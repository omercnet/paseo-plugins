import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type {
  OmpAgentSessionEvent,
  OmpMessage,
  OmpRuntimeSession,
  OmpSubagentEvent,
  OmpSubagentSnapshot,
} from "./omp-rpc";
import {
  BoundedStringSet,
  boundedJsonBytes,
  OmpPublicDataFilter,
  OmpPublicError,
} from "./security";
import { OmpTimelineProjector, type OmpTimelineScheduler } from "./timeline-projector";

const MAX_CHILDREN = 1_024;
const MAX_TASK_DISPATCHES = 4_096;
const MAX_BUFFERED_EVENTS = 1_024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_MESSAGE_IDENTITIES = 2_048;
const MAX_REPLAY_MESSAGES = 100_000;
const MAX_REPLAY_DEPTH = 16;

type Emit = (event: ProviderEvent) => void;
type ChildTerminalStatus = "completed" | "failed" | "canceled";
type ChildStatus = "running" | ChildTerminalStatus;
type ChildRef = {
  id: string;
  agent?: string;
  description?: string;
  sessionFile?: string;
  parentToolCallId?: string;
};
type ReplayChildRef = ChildRef & { status: ChildTerminalStatus };
type ChildState = {
  nativeId: string;
  sessionId: string;
  parentSessionId: string;
  turnId: string;
  title: string;
  description?: string;
  sessionFile?: string;
  status: ChildStatus;
  terminalRequested?: ChildTerminalStatus;
  sessionClosed: boolean;
  seenInSnapshot: boolean;
  seenAssistantIdentities: BoundedStringSet;
  projector: OmpTimelineProjector;
};
type TaskDispatch = {
  ownerSessionId: string;
  expectedChildren: number;
  childSessionIds: Set<string>;
  acknowledged: boolean;
};
type ReplayBudget = { messages: number };

const TaskArgsSchema = z.object({
  tasks: z.array(z.unknown()).max(MAX_CHILDREN).optional(),
  agent: z.string().optional(),
  subAgentType: z.string().optional(),
  agentType: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  task: z.string().optional(),
  prompt: z.string().optional(),
  assignment: z.string().optional(),
});
const TaskResultDetailsSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().min(1),
        agent: z.string().optional(),
        exitCode: z.number().optional(),
        error: z.unknown().optional(),
        aborted: z.boolean().optional(),
      }),
    )
    .max(MAX_CHILDREN),
});
const TaskResultEnvelopeSchema = z.object({ details: TaskResultDetailsSchema });

function expectedTaskChildren(value: unknown): number {
  const parsed = TaskArgsSchema.safeParse(value);
  if (!parsed.success || !parsed.data.tasks) return 1;
  return Math.max(1, parsed.data.tasks.length);
}

function taskResultCount(value: unknown): number | undefined {
  const parsed = TaskResultEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.details.results.length : undefined;
}

function taskDescription(value: unknown): string | undefined {
  const parsed = TaskArgsSchema.safeParse(value);
  if (!parsed.success) return;
  for (const candidate of [
    parsed.data.description,
    parsed.data.task,
    parsed.data.prompt,
    parsed.data.assignment,
  ]) {
    if (candidate?.trim()) return candidate;
  }
  return;
}

function taskCalls(
  messages: readonly OmpMessage[],
): Map<string, { title: string; description?: string }> {
  const calls = new Map<string, { title: string; description?: string }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || part.name !== "task" || !part.id) continue;
      const args = TaskArgsSchema.safeParse(part.arguments);
      const data = args.success ? args.data : {};
      const title =
        [data.agent, data.subAgentType, data.agentType, data.type].find(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        ) ?? "OMP subagent";
      calls.set(part.id, { title, description: taskDescription(data) });
    }
  }
  return calls;
}

function taskResultDetails(
  message: OmpMessage,
): z.infer<typeof TaskResultDetailsSchema> | undefined {
  if (message.role !== "toolResult") return;
  const direct = TaskResultDetailsSchema.safeParse(message.details);
  if (direct.success) return direct.data;
  const nested = TaskResultEnvelopeSchema.safeParse(message.content);
  return nested.success ? nested.data.details : undefined;
}

function replayChildren(messages: readonly OmpMessage[]): ReplayChildRef[] {
  const calls = taskCalls(messages);
  const children: ReplayChildRef[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "task") continue;
    const call = calls.get(message.toolCallId);
    const details = taskResultDetails(message);
    const results = details?.results ?? [];
    for (const result of results) {
      const failed =
        message.isError === true ||
        Boolean(result.error) ||
        (typeof result.exitCode === "number" && result.exitCode !== 0);
      children.push({
        id: result.id,
        agent: typeof result.agent === "string" ? result.agent : call?.title,
        description: call?.description,
        parentToolCallId: message.toolCallId,
        status: failed ? "failed" : result.aborted === true ? "canceled" : "completed",
      });
    }
    if (results.length > 0) continue;
    const text = Array.isArray(message.content)
      ? message.content
          .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    const sessionFile = text.match(/(?:session|transcript)(?: file)?:\s*(?<path>\/\S+\.jsonl)/iu)
      ?.groups?.path;
    if (!sessionFile) continue;
    const fileName = basename(sessionFile);
    const extension = extname(fileName);
    children.push({
      id: extension ? fileName.slice(0, -extension.length) : fileName,
      agent: call?.title,
      description: call?.description,
      sessionFile,
      parentToolCallId: message.toolCallId,
      status: message.isError ? "failed" : "completed",
    });
  }
  return children;
}

function terminalStatus(status: string): ChildTerminalStatus | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "canceled";
  return;
}

export class OmpSubsessionProjector {
  private readonly children = new Map<string, ChildState>();
  private readonly sessionIdByNativeId = new Map<string, string>();
  private readonly toolOwners = new Map<string, string>();
  private readonly dispatches = new Map<string, TaskDispatch>();
  private readonly bufferedEvents: OmpSubagentEvent[] = [];
  private readonly sensitiveValues = new Set<string>();
  private bufferedBytes = 0;
  private replaying = false;
  private closed = false;

  constructor(
    private readonly rootSessionId: string,
    private readonly rootNativeSessionId: string,
    private readonly rootSessionFile: string | undefined,
    private readonly cwd: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler,
    sensitiveValues: Iterable<string>,
    private readonly onActivityChange: () => void,
  ) {
    for (const value of sensitiveValues) this.sensitiveValues.add(value);
    this.dataFilter = new OmpPublicDataFilter(this.sensitiveValues);
  }

  private readonly dataFilter: OmpPublicDataFilter;

  addSensitiveValues(values: Iterable<string>): void {
    const additions: string[] = [];
    for (const value of values) {
      if (this.sensitiveValues.has(value)) continue;
      this.sensitiveValues.add(value);
      additions.push(value);
    }
    this.dataFilter.addSensitiveValues(additions);
    for (const child of this.children.values()) child.projector.addSensitiveValues(additions);
  }

  observeSessionEvent(ownerSessionId: string, event: OmpAgentSessionEvent): void {
    if (event.type === "tool_execution_start" && event.toolName === "task") {
      if (!this.dispatches.has(event.toolCallId)) {
        if (this.dispatches.size >= MAX_TASK_DISPATCHES) {
          throw new OmpPublicError("OMP subagent dispatch limit reached");
        }
        this.dispatches.set(event.toolCallId, {
          ownerSessionId,
          expectedChildren: expectedTaskChildren(event.args),
          childSessionIds: new Set(),
          acknowledged: false,
        });
      }
      this.toolOwners.set(event.toolCallId, ownerSessionId);
      return;
    }
    if (event.type !== "tool_execution_end" || event.toolName !== "task") return;
    const dispatch = this.dispatches.get(event.toolCallId);
    if (!dispatch) return;
    if (event.isError) {
      this.dispatches.delete(event.toolCallId);
      this.onActivityChange();
      return;
    }
    dispatch.acknowledged = true;
    const resultCount = taskResultCount(event.result);
    if (resultCount !== undefined) dispatch.expectedChildren = resultCount;
    this.settleDispatch(event.toolCallId, dispatch);
  }

  handle(event: OmpSubagentEvent): void {
    if (this.closed) return;
    if (this.replaying) {
      if (this.bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
        throw new OmpPublicError("OMP subagent replay event limit reached");
      }
      const bytes = boundedJsonBytes(event, MAX_BUFFERED_BYTES, 1_024, MAX_BUFFERED_BYTES, 4_096);
      if (bytes === Number.POSITIVE_INFINITY || this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
        throw new OmpPublicError("OMP subagent replay event limit reached");
      }
      this.bufferedEvents.push(event);
      this.bufferedBytes += bytes;
      return;
    }
    this.apply(event);
  }

  async replay(messages: readonly OmpMessage[], runtime: OmpRuntimeSession): Promise<void> {
    this.replaying = true;
    try {
      const budget: ReplayBudget = { messages: messages.length };
      if (budget.messages > MAX_REPLAY_MESSAGES) {
        throw new OmpPublicError("OMP subagent history exceeds replay limits");
      }
      const visited = new Set<string>();
      await this.replayChildren(this.rootSessionId, messages, runtime, visited, budget, 0);
      const snapshots = await runtime.getSubagents();
      await this.replaySnapshots(snapshots, runtime, visited, budget);
      this.reconcileSnapshots(snapshots);
    } finally {
      this.replaying = false;
      const buffered = this.bufferedEvents.splice(0);
      this.bufferedBytes = 0;
      for (const event of buffered) this.apply(event);
    }
  }

  async reconcile(runtime: OmpRuntimeSession): Promise<void> {
    this.reconcileSnapshots(await runtime.getSubagents());
  }

  hasActiveChildren(): boolean {
    for (const child of this.children.values()) if (child.status === "running") return true;
    for (const dispatch of this.dispatches.values()) if (dispatch.acknowledged) return true;
    return false;
  }

  terminalize(status: ChildTerminalStatus): void {
    for (const child of this.children.values()) {
      if (child.status === "running") this.finishChild(child, status, true);
    }
    this.dispatches.clear();
    this.toolOwners.clear();
    this.onActivityChange();
  }

  close(): void {
    if (this.closed) return;
    this.terminalize("canceled");
    this.closed = true;
    for (const child of this.children.values()) {
      if (child.sessionClosed) continue;
      child.sessionClosed = true;
      this.emit({ type: "session.closed", sessionId: child.sessionId });
    }
    this.bufferedEvents.length = 0;
    this.bufferedBytes = 0;
  }

  private apply(event: OmpSubagentEvent): void {
    if (event.type === "subagent_lifecycle") {
      const child = this.ensureChild(
        {
          id: event.payload.id,
          agent: event.payload.agent,
          description: event.payload.description,
          sessionFile: event.payload.sessionFile,
          parentToolCallId: event.payload.parentToolCallId,
        },
        this.resolveParent(event.payload.parentToolCallId, event.payload.sessionFile),
      );
      const terminal = terminalStatus(event.payload.status);
      if (terminal) this.requestTerminal(child, terminal);
      this.onActivityChange();
      return;
    }
    if (event.type === "subagent_progress") {
      const child = this.ensureChild(
        {
          id: event.payload.progress.id,
          agent: event.payload.agent,
          description: event.payload.progress.description ?? event.payload.assignment,
          sessionFile: event.payload.sessionFile,
          parentToolCallId: event.payload.parentToolCallId,
        },
        this.resolveParent(event.payload.parentToolCallId, event.payload.sessionFile),
      );
      const terminal = terminalStatus(event.payload.progress.status);
      if (terminal) this.requestTerminal(child, terminal);
      this.onActivityChange();
      return;
    }
    const sessionId = this.sessionIdByNativeId.get(event.payload.id);
    const child = sessionId ? this.children.get(sessionId) : undefined;
    if (child?.status !== "running") return;
    const nested = event.payload.event;
    if (
      (nested.type === "message_start" ||
        nested.type === "message_update" ||
        nested.type === "message_end") &&
      nested.message.role === "assistant"
    ) {
      const identity = nested.message.entryId ?? nested.message.responseId ?? nested.message.id;
      if (identity && child.seenAssistantIdentities.has(identity)) return;
      if (identity && nested.type === "message_end") child.seenAssistantIdentities.add(identity);
    }
    this.observeSessionEvent(child.sessionId, nested);
    child.projector.project(nested, child.turnId);
  }

  private ensureChild(ref: ChildRef, parentSessionId: string): ChildState {
    const existingSessionId = this.sessionIdByNativeId.get(ref.id);
    const existing = existingSessionId ? this.children.get(existingSessionId) : undefined;
    if (existing) return existing;
    if (this.children.size >= MAX_CHILDREN) throw new OmpPublicError("OMP subagent limit reached");
    const digest = createHash("sha256")
      .update(this.rootNativeSessionId)
      .update("\0")
      .update(ref.id)
      .digest("base64url")
      .slice(0, 32);
    const sessionId = `omp:subsession:${digest}`;
    const turnId = `${sessionId}:turn`;
    const title = this.dataFilter.text(ref.agent?.trim() || "OMP subagent", 256);
    const description = ref.description
      ? this.dataFilter.text(ref.description, 16 * 1024)
      : undefined;
    const child: ChildState = {
      nativeId: ref.id,
      sessionId,
      parentSessionId,
      turnId,
      title,
      ...(description ? { description } : {}),
      ...(ref.sessionFile ? { sessionFile: ref.sessionFile } : {}),
      status: "running",
      sessionClosed: false,
      seenAssistantIdentities: new BoundedStringSet(MAX_CHILD_MESSAGE_IDENTITIES),
      seenInSnapshot: false,
      projector: new OmpTimelineProjector(
        sessionId,
        this.emit,
        this.scheduler,
        this.sensitiveValues,
      ),
    };
    this.children.set(sessionId, child);
    this.sessionIdByNativeId.set(ref.id, sessionId);
    const dispatch = ref.parentToolCallId ? this.dispatches.get(ref.parentToolCallId) : undefined;
    dispatch?.childSessionIds.add(sessionId);
    this.emit({
      type: "session.opened",
      sessionId,
      parentSessionId,
      capabilities: [],
      restoration: "parent",
      cwd: this.cwd,
      title,
      ...(description ? { description } : {}),
    });
    this.emit({ type: "session.ready", sessionId });
    this.emit({ type: "session.turn", sessionId, turnId, state: "started" });
    return child;
  }

  private requestTerminal(child: ChildState, status: ChildTerminalStatus): void {
    if (child.status !== "running") return;
    child.terminalRequested = status;
    if (!this.hasDirectActivity(child.sessionId)) this.finishChild(child, status);
  }

  private finishChild(child: ChildState, status: ChildTerminalStatus, force = false): void {
    if (child.status !== "running") return;
    if (!force && this.hasDirectActivity(child.sessionId)) {
      child.terminalRequested = status;
      return;
    }
    child.status = status;
    child.projector.finishTurn(child.turnId);
    child.projector.close();
    this.emit({
      type: "session.turn",
      sessionId: child.sessionId,
      turnId: child.turnId,
      state: status,
      ...(status === "failed" ? { error: { message: "OMP subagent failed" } } : {}),
    });
    for (const [toolCallId, dispatch] of this.dispatches) {
      if (dispatch.childSessionIds.has(child.sessionId)) this.settleDispatch(toolCallId, dispatch);
    }
    const parent = this.children.get(child.parentSessionId);
    if (parent?.terminalRequested && !this.hasDirectActivity(parent.sessionId)) {
      this.finishChild(parent, parent.terminalRequested);
    }
    this.onActivityChange();
  }

  private hasDirectActivity(ownerSessionId: string): boolean {
    for (const child of this.children.values()) {
      if (child.parentSessionId === ownerSessionId && child.status === "running") return true;
    }
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.ownerSessionId === ownerSessionId && dispatch.acknowledged) return true;
    }
    return false;
  }

  private settleDispatch(toolCallId: string, dispatch: TaskDispatch): void {
    if (!dispatch.acknowledged || dispatch.childSessionIds.size < dispatch.expectedChildren) return;
    for (const sessionId of dispatch.childSessionIds) {
      if (this.children.get(sessionId)?.status === "running") return;
    }
    this.dispatches.delete(toolCallId);
    const owner = this.children.get(dispatch.ownerSessionId);
    if (owner?.terminalRequested && !this.hasDirectActivity(owner.sessionId)) {
      this.finishChild(owner, owner.terminalRequested);
    }
    this.onActivityChange();
  }

  private resolveParent(parentToolCallId?: string, sessionFile?: string): string {
    if (parentToolCallId) {
      const owner = this.toolOwners.get(parentToolCallId);
      if (owner) return owner;
    }
    if (!sessionFile) return this.rootSessionId;
    let parentSessionId = this.rootSessionId;
    let parentStemLength = this.rootSessionFile
      ? this.rootSessionFile.slice(0, -extname(this.rootSessionFile).length).length
      : -1;
    for (const child of this.children.values()) {
      if (!child.sessionFile) continue;
      const stem = child.sessionFile.slice(0, -extname(child.sessionFile).length);
      if (stem.length > parentStemLength && sessionFile.startsWith(`${stem}/`)) {
        parentSessionId = child.sessionId;
        parentStemLength = stem.length;
      }
    }
    return parentSessionId;
  }

  private reconcileSnapshots(snapshots: readonly OmpSubagentSnapshot[]): void {
    const present = new Set<string>();
    for (const snapshot of snapshots) {
      const child = this.ensureChild(
        {
          id: snapshot.id,
          agent: snapshot.agent,
          description: snapshot.description ?? snapshot.assignment,
          sessionFile: snapshot.sessionFile,
          parentToolCallId: snapshot.parentToolCallId,
        },
        this.resolveParent(snapshot.parentToolCallId, snapshot.sessionFile),
      );
      present.add(child.nativeId);
      child.seenInSnapshot = true;
      const terminal = terminalStatus(snapshot.status);
      if (terminal) this.requestTerminal(child, terminal);
    }
    for (const child of this.children.values()) {
      if (child.status === "running" && child.seenInSnapshot && !present.has(child.nativeId)) {
        this.requestTerminal(child, "completed");
      }
    }
    this.onActivityChange();
  }

  private async replaySnapshots(
    snapshots: readonly OmpSubagentSnapshot[],
    runtime: OmpRuntimeSession,
    visited: Set<string>,
    budget: ReplayBudget,
  ): Promise<void> {
    const ordered = [...snapshots].sort(
      (left, right) =>
        (left.sessionFile?.split("/").length ?? 0) - (right.sessionFile?.split("/").length ?? 0),
    );
    for (const snapshot of ordered) {
      if (this.sessionIdByNativeId.has(snapshot.id)) continue;
      const history = await runtime.getSubagentMessages({ subagentId: snapshot.id });
      budget.messages += history.messages.length;
      if (budget.messages > MAX_REPLAY_MESSAGES) {
        throw new OmpPublicError("OMP subagent history exceeds replay limits");
      }
      const parentSessionId = this.resolveParent(snapshot.parentToolCallId, history.sessionFile);
      const child = this.ensureChild(
        { ...snapshot, sessionFile: history.sessionFile },
        parentSessionId,
      );
      this.projectReplay(child, history.messages);
      visited.add(snapshot.id);
      await this.replayChildren(child.sessionId, history.messages, runtime, visited, budget, 1);
    }
  }

  private async replayChildren(
    parentSessionId: string,
    messages: readonly OmpMessage[],
    runtime: OmpRuntimeSession,
    visited: Set<string>,
    budget: ReplayBudget,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_REPLAY_DEPTH) throw new OmpPublicError("OMP subagent history is too deep");
    this.indexTaskCalls(parentSessionId, messages);
    for (const ref of replayChildren(messages)) {
      if (visited.has(ref.id)) continue;
      visited.add(ref.id);
      const history = await runtime.getSubagentMessages(
        ref.sessionFile ? { sessionFile: ref.sessionFile } : { subagentId: ref.id },
      );
      budget.messages += history.messages.length;
      if (budget.messages > MAX_REPLAY_MESSAGES) {
        throw new OmpPublicError("OMP subagent history exceeds replay limits");
      }
      const child = this.ensureChild({ ...ref, sessionFile: history.sessionFile }, parentSessionId);
      this.projectReplay(child, history.messages);
      await this.replayChildren(
        child.sessionId,
        history.messages,
        runtime,
        visited,
        budget,
        depth + 1,
      );
      this.requestTerminal(child, ref.status);
    }
  }

  private projectReplay(child: ChildState, messages: readonly OmpMessage[]): void {
    this.indexTaskCalls(child.sessionId, messages);
    for (const message of messages) {
      child.projector.projectReplayMessage(message);
      if (message.role === "assistant") {
        const identity = message.entryId ?? message.responseId ?? message.id;
        if (identity) child.seenAssistantIdentities.add(identity);
      }
    }
    child.projector.finishReplay();
  }

  private indexTaskCalls(ownerSessionId: string, messages: readonly OmpMessage[]): void {
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== "task" || !part.id) continue;
        if (!this.toolOwners.has(part.id) && this.toolOwners.size >= MAX_TASK_DISPATCHES) {
          throw new OmpPublicError("OMP subagent dispatch limit reached");
        }
        this.toolOwners.set(part.id, ownerSessionId);
      }
    }
  }
}
