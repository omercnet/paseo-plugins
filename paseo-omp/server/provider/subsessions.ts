import { createHash } from "node:crypto";
import { basename, extname, isAbsolute } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type {
  OmpAgentSessionEvent,
  OmpMessage,
  OmpRuntime,
  OmpRuntimeSession,
  OmpSubagentEvent,
  OmpSubagentSnapshot,
} from "./omp-rpc";
import {
  BoundedStringSet,
  boundedJsonBytes,
  boundedJsonMetrics,
  OmpPublicDataSerializer,
  OmpPublicError,
} from "./security";
import { OmpTimelineProjector, type OmpTimelineScheduler } from "./timeline-projector";

const MAX_CHILDREN = 1_024;
const MAX_TASK_DISPATCHES = 4_096;
const MAX_BUFFERED_EVENTS = MAX_CHILDREN * 3;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_MESSAGE_IDENTITIES = 2_048;
const MAX_REPLAY_MESSAGES = 100_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_NODES = 400_000;
const MAX_REPLAY_DEPTH = 16;
const CHILD_REPLAY_UNAVAILABLE = "OMP subagent history is unavailable or incomplete";
type BufferedSubagentEvent = { event: OmpSubagentEvent; bytes: number };

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
type ReplayChildRef = ChildRef & { status: ChildTerminalStatus | "derive" };
type ChildState = {
  nativeId: string;
  sessionId: string;
  parentSessionId: string;
  turnId: string;
  turnSequence: number;
  title: string;
  description?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  status: ChildStatus;
  terminalRequested?: ChildTerminalStatus;
  sessionClosed: boolean;
  replayUnavailable?: boolean;
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
type ReplayHistory = { sessionFile: string; messages: OmpMessage[] };
type ReplayBudget = { messages: number; bytes: number; nodes: number };
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
const TaskProgressSchema = z.object({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CHILDREN - 1),
  id: z.string().min(1),
  agent: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "failed", "aborted"]),
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
        status: z
          .enum([
            "pending",
            "running",
            "completed",
            "failed",
            "error",
            "aborted",
            "canceled",
            "cancelled",
          ])
          .optional(),
      }),
    )
    .max(MAX_CHILDREN),
  progress: z.array(TaskProgressSchema).max(MAX_CHILDREN).optional(),
});
const YieldResultSchema = z.object({
  status: z.enum(["success", "completed", "failed", "error", "aborted", "canceled", "cancelled"]),
});
const TaskResultEnvelopeSchema = z.object({ details: TaskResultDetailsSchema });

function expectedTaskChildren(value: unknown): number {
  const parsed = TaskArgsSchema.safeParse(value);
  if (!parsed.success || !parsed.data.tasks) return 1;
  return Math.max(1, parsed.data.tasks.length);
}

function taskResultActivity(value: unknown): {
  expectedChildren?: number;
  settleWithoutChildren: boolean;
} {
  const parsed = TaskResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) return { settleWithoutChildren: false };
  const pending = (parsed.data.details.progress ?? []).filter(
    (item) => item.status === "pending" || item.status === "running",
  );
  const progressCount = pending.reduce((count, item) => Math.max(count, item.index + 1), 0);
  const observed = Math.max(parsed.data.details.results.length, progressCount);
  return {
    ...(observed > 0 ? { expectedChildren: observed } : {}),
    settleWithoutChildren: parsed.data.details.results.length === 0 && pending.length === 0,
  };
}

async function waitForReplay<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
      const canceled =
        result.aborted === true ||
        result.status === "aborted" ||
        result.status === "canceled" ||
        result.status === "cancelled";
      const failed =
        message.isError === true ||
        result.status === "failed" ||
        result.status === "error" ||
        Boolean(result.error) ||
        (typeof result.exitCode === "number" && result.exitCode !== 0);
      children.push({
        id: result.id,
        agent: result.agent ?? call?.title,
        description: call?.description,
        parentToolCallId: message.toolCallId,
        status: canceled ? "canceled" : failed ? "failed" : "completed",
      });
    }
    const resultIds = new Set(results.map((result) => result.id));
    const progress = details?.progress ?? [];
    for (const item of progress) {
      if (resultIds.has(item.id)) continue;
      const status = terminalStatus(item.status);
      children.push({
        id: item.id,
        agent: item.agent ?? call?.title,
        description: call?.description,
        parentToolCallId: message.toolCallId,
        status: status ?? "derive",
      });
    }
    if (results.length > 0 || progress.length > 0) continue;
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

function replayTerminalStatus(messages: readonly OmpMessage[]): ChildTerminalStatus {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || message.toolName !== "yield") continue;
    const parsed = YieldResultSchema.safeParse(message.details);
    if (!parsed.success) continue;
    if (
      parsed.data.status === "aborted" ||
      parsed.data.status === "canceled" ||
      parsed.data.status === "cancelled"
    ) {
      return "canceled";
    }
    if (parsed.data.status === "failed" || parsed.data.status === "error") return "failed";
    return "completed";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const stopReason = message.stopReason?.toLowerCase();
    if (stopReason === "aborted" || stopReason === "canceled" || stopReason === "cancelled") {
      return "canceled";
    }
    if (stopReason === "error" || message.errorMessage) return "failed";
    return "completed";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "bashExecution" && message.cancelled) return "canceled";
    if (message?.role === "toolResult" && message.isError) return "failed";
  }
  return "completed";
}

function terminalStatus(status: string): ChildTerminalStatus | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "canceled";
  return;
}

function bufferedNativeId(event: OmpSubagentEvent): string {
  return event.type === "subagent_progress" ? event.payload.progress.id : event.payload.id;
}

export class OmpSubsessionProjector {
  private readonly children = new Map<string, ChildState>();
  private readonly sessionIdByNativeId = new Map<string, string>();
  private readonly toolOwners = new Map<string, string>();
  private readonly dispatches = new Map<string, TaskDispatch>();
  private readonly bufferedEvents: BufferedSubagentEvent[] = [];
  // null means every child observed during this replay is omitted after tombstone saturation.
  private omittedBufferedChildren: Set<string> | null = new Set();
  private bufferedBytes = 0;
  private replaying = false;
  private closed = false;

  private readonly dataFilter: OmpPublicDataSerializer;

  constructor(
    private readonly rootSessionId: string,
    private readonly rootIdentityKey: string,
    private readonly rootSessionFile: string | undefined,
    private readonly cwd: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler,
    private readonly onActivityChange: () => void,
    private readonly outputRedactionValues: readonly string[],
    private readonly pluginTimelineEnabled = false,
  ) {
    this.dataFilter = new OmpPublicDataSerializer(outputRedactionValues);
  }

  observeSessionEvent(ownerSessionId: string, event: OmpAgentSessionEvent): void {
    if (event.type === "tool_execution_start" && event.toolName === "task") {
      if (!this.dispatches.has(event.toolCallId)) {
        if (this.dispatches.size >= MAX_TASK_DISPATCHES) {
          throw new OmpPublicError("OMP subagent dispatch limit reached");
        }
        const dispatch: TaskDispatch = {
          ownerSessionId,
          expectedChildren: expectedTaskChildren(event.args),
          childSessionIds: new Set(),
          acknowledged: false,
        };
        for (const child of this.children.values()) {
          if (
            child.parentToolCallId === event.toolCallId &&
            child.parentSessionId === ownerSessionId
          ) {
            dispatch.childSessionIds.add(child.sessionId);
          }
        }
        this.dispatches.set(event.toolCallId, dispatch);
      }
      this.registerToolOwner(event.toolCallId, ownerSessionId);
      return;
    }
    if (event.type !== "tool_execution_end" || event.toolName !== "task") return;
    const dispatch = this.dispatches.get(event.toolCallId);
    if (!dispatch) return;
    if (event.isError) {
      this.dispatches.delete(event.toolCallId);
      this.toolOwners.delete(event.toolCallId);
      this.onActivityChange();
      return;
    }
    dispatch.acknowledged = true;
    const activity = taskResultActivity(event.result);
    if (activity.settleWithoutChildren) dispatch.expectedChildren = 0;
    else if (activity.expectedChildren !== undefined) {
      dispatch.expectedChildren = Math.max(dispatch.expectedChildren, activity.expectedChildren);
    }
    this.settleDispatch(event.toolCallId, dispatch);
  }

  handle(event: OmpSubagentEvent): void {
    if (this.closed) return;
    if (this.replaying) {
      this.bufferEvent(event);
      return;
    }
    this.apply(event);
  }
  async replay(
    messages: readonly OmpMessage[],
    runtimeSession: OmpRuntimeSession,
    runtime: OmpRuntime,
    signal: AbortSignal,
  ): Promise<void> {
    this.replaying = true;
    let completed = false;
    try {
      const budget: ReplayBudget = { messages: 0, bytes: 0, nodes: 0 };
      this.accountReplay(messages, budget, signal);
      const visited = new Set<string>();
      await this.replayChildren(
        this.rootSessionId,
        this.rootSessionFile,
        messages,
        runtime,
        visited,
        budget,
        signal,
        0,
      );
      let snapshots: OmpSubagentSnapshot[] = [];
      try {
        snapshots = await waitForReplay(runtimeSession.getSubagents(), signal);
      } catch (error) {
        if (signal.aborted) throw error;
      }
      await this.replaySnapshots(snapshots, runtimeSession, runtime, visited, budget, signal);
      signal.throwIfAborted();
      this.reconcileSnapshots(snapshots);
      completed = true;
    } catch (error) {
      if (signal.aborted) throw error;
      this.terminalize("failed");
      completed = true;
    } finally {
      this.replaying = false;
      const buffered = this.bufferedEvents.splice(0);
      this.bufferedBytes = 0;
      if (completed && !signal.aborted) {
        for (const { event } of buffered) {
          if (
            event.type === "subagent_progress" &&
            !terminalStatus(event.payload.progress.status)
          ) {
            const sessionId = this.sessionIdByNativeId.get(event.payload.progress.id);
            const child = sessionId ? this.children.get(sessionId) : undefined;
            if (child && child.status !== "running") continue;
          }
          try {
            this.apply(event);
          } catch {
            this.terminalize("failed");
          }
        }
      } else {
        this.terminalize("failed");
        this.closed = true;
        for (const child of this.children.values()) child.projector.close();
        this.dispatches.clear();
        this.toolOwners.clear();
      }
      this.omittedBufferedChildren = new Set();
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
      child.projector.close();
      if (child.sessionClosed) continue;
      child.sessionClosed = true;
      this.emit({ type: "session.closed", sessionId: child.sessionId });
    }
    this.bufferedEvents.length = 0;
    this.bufferedBytes = 0;
    this.omittedBufferedChildren = new Set();
  }

  private bufferEvent(event: OmpSubagentEvent): void {
    const isProgress = event.type === "subagent_progress";
    const progressTerminal = isProgress ? terminalStatus(event.payload.progress.status) : undefined;
    const isAdvisoryProgress = isProgress && !progressTerminal;
    const bufferedEvent: OmpSubagentEvent =
      isProgress && progressTerminal
        ? {
            type: "subagent_lifecycle",
            payload: {
              id: event.payload.progress.id,
              agent: event.payload.agent,
              status: event.payload.progress.status,
              index: event.payload.index,
              ...(event.payload.agentSource ? { agentSource: event.payload.agentSource } : {}),
              ...(event.payload.parentToolCallId
                ? { parentToolCallId: event.payload.parentToolCallId }
                : {}),
              ...(event.payload.detached !== undefined ? { detached: event.payload.detached } : {}),
            },
          }
        : event;
    const incomingId = bufferedNativeId(bufferedEvent);
    if (this.isBufferedChildOmitted(incomingId)) return;
    const bytes = boundedJsonBytes(
      bufferedEvent,
      MAX_BUFFERED_BYTES,
      1_024,
      MAX_BUFFERED_BYTES,
      4_096,
    );
    if (bytes === Number.POSITIVE_INFINITY) {
      if (!isAdvisoryProgress) this.omitBufferedChild(incomingId);
      return;
    }
    if (isAdvisoryProgress) {
      for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
        const queued = this.bufferedEvents[index]?.event;
        if (!queued) continue;
        if (
          queued.type === "subagent_lifecycle" &&
          queued.payload.id === incomingId &&
          terminalStatus(queued.payload.status)
        ) {
          return;
        }
        if (queued.type !== "subagent_progress" || queued.payload.progress.id !== incomingId) {
          continue;
        }
        if (terminalStatus(queued.payload.progress.status)) return;
        const [removed] = this.bufferedEvents.splice(index, 1);
        this.bufferedBytes -= removed?.bytes ?? 0;
        break;
      }
    }

    const bufferedIds = new Set<string>();
    for (const child of this.children.values()) bufferedIds.add(child.nativeId);
    for (const { event: queued } of this.bufferedEvents) bufferedIds.add(bufferedNativeId(queued));
    if (!bufferedIds.has(incomingId) && bufferedIds.size >= MAX_CHILDREN) {
      if (isAdvisoryProgress) return;
      const advisory = this.bufferedEvents.find(
        ({ event: queued }) =>
          queued.type === "subagent_progress" && !terminalStatus(queued.payload.progress.status),
      );
      if (!advisory) {
        this.omitBufferedChild(incomingId);
        return;
      }
      const evictedId = bufferedNativeId(advisory.event);
      this.omitBufferedChild(evictedId);
      if (this.isBufferedChildOmitted(incomingId)) return;
    }

    while (
      this.bufferedEvents.length >= MAX_BUFFERED_EVENTS ||
      this.bufferedBytes + bytes > MAX_BUFFERED_BYTES
    ) {
      const advisoryIndex = this.bufferedEvents.findIndex(
        ({ event: queued }) =>
          queued.type === "subagent_progress" && !terminalStatus(queued.payload.progress.status),
      );
      if (advisoryIndex < 0) {
        if (!isAdvisoryProgress) this.omitBufferedChild(incomingId);
        return;
      }
      const [removed] = this.bufferedEvents.splice(advisoryIndex, 1);
      this.bufferedBytes -= removed?.bytes ?? 0;
    }
    this.bufferedEvents.push({ event: bufferedEvent, bytes });
    this.bufferedBytes += bytes;
  }

  private isBufferedChildOmitted(nativeId: string): boolean {
    return this.omittedBufferedChildren === null || this.omittedBufferedChildren.has(nativeId);
  }

  private omitBufferedChild(nativeId: string): void {
    const omitted = this.omittedBufferedChildren;
    if (!omitted || omitted.has(nativeId)) return;
    if (omitted.size >= MAX_CHILDREN) {
      this.omittedBufferedChildren = null;
      this.bufferedEvents.length = 0;
      this.bufferedBytes = 0;
      for (const child of this.children.values()) child.replayUnavailable = true;
      this.terminalize("failed");
      return;
    }
    omitted.add(nativeId);
    for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
      const queued = this.bufferedEvents[index];
      if (!queued || bufferedNativeId(queued.event) !== nativeId) continue;
      const [removed] = this.bufferedEvents.splice(index, 1);
      this.bufferedBytes -= removed?.bytes ?? 0;
    }
    const sessionId = this.sessionIdByNativeId.get(nativeId);
    const child = sessionId ? this.children.get(sessionId) : undefined;
    if (child?.status === "running") this.failReplayChild(child);
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
      else if (event.payload.status === "started") this.restartChild(child);
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
      else this.restartChild(child);
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
    if (existing) {
      if (ref.parentToolCallId) existing.parentToolCallId = ref.parentToolCallId;
      if (existing.parentToolCallId) {
        const dispatch = this.dispatches.get(existing.parentToolCallId);
        if (dispatch?.ownerSessionId === existing.parentSessionId) {
          dispatch.childSessionIds.add(existing.sessionId);
        }
      }
      return existing;
    }
    if (this.children.size >= MAX_CHILDREN) throw new OmpPublicError("OMP subagent limit reached");
    const digest = createHash("sha256")
      .update(this.rootIdentityKey)
      .update("\0")
      .update(ref.id)
      .digest("base64url")
      .slice(0, 32);
    const sessionId = `omp:subsession:${digest}`;
    const turnId = `${sessionId}:turn:1`;
    const title = this.dataFilter.text(ref.agent?.trim() || "OMP subagent", 256);
    const description = ref.description
      ? this.dataFilter.text(ref.description, 16 * 1024)
      : undefined;
    const child: ChildState = {
      nativeId: ref.id,
      sessionId,
      parentSessionId,
      turnId,
      turnSequence: 1,
      title,
      ...(description ? { description } : {}),
      ...(ref.sessionFile ? { sessionFile: ref.sessionFile } : {}),
      ...(ref.parentToolCallId ? { parentToolCallId: ref.parentToolCallId } : {}),
      status: "running",
      sessionClosed: false,
      seenAssistantIdentities: new BoundedStringSet(MAX_CHILD_MESSAGE_IDENTITIES),
      seenInSnapshot: false,
      projector: new OmpTimelineProjector(
        sessionId,
        this.emit,
        this.scheduler,
        this.outputRedactionValues,
        false,
        this.pluginTimelineEnabled,
      ),
    };
    this.children.set(sessionId, child);
    this.sessionIdByNativeId.set(ref.id, sessionId);
    if (ref.parentToolCallId) {
      const dispatch = this.dispatches.get(ref.parentToolCallId);
      if (dispatch?.ownerSessionId === parentSessionId) dispatch.childSessionIds.add(sessionId);
    }
    this.emit({
      type: "session.opened",
      sessionId,
      parentSessionId,
      toolCallId: ref.parentToolCallId,
      capabilities: ["session.subsession"],
      restoration: "parent",
      cwd: this.cwd,
      title,
      ...(description ? { description } : {}),
    });
    this.emit({ type: "session.ready", sessionId });
    this.emit({ type: "session.turn", sessionId, turnId, state: "started" });
    return child;
  }

  private restartChild(child: ChildState): void {
    child.replayUnavailable = false;
    if (child.status === "running") return;
    child.status = "running";
    child.terminalRequested = undefined;
    child.seenInSnapshot = false;
    child.turnSequence += 1;
    child.turnId = `${child.sessionId}:turn:${child.turnSequence}`;
    this.emit({
      type: "session.turn",
      sessionId: child.sessionId,
      turnId: child.turnId,
      state: "started",
    });
  }

  private requestTerminal(child: ChildState, status: ChildTerminalStatus): void {
    if (child.status !== "running") return;
    child.terminalRequested = status;
    if (!this.hasDirectActivity(child.sessionId)) this.finishChild(child, status);
  }

  private finishChild(
    child: ChildState,
    status: ChildTerminalStatus,
    force = false,
    errorMessage = "OMP subagent failed",
  ): void {
    if (child.status !== "running") return;
    if (!force && this.hasDirectActivity(child.sessionId)) {
      child.terminalRequested = status;
      return;
    }
    child.status = status;
    child.projector.finishTurn(child.turnId);
    this.emit({
      type: "session.turn",
      sessionId: child.sessionId,
      turnId: child.turnId,
      state: status,
      ...(status === "failed" ? { error: { message: errorMessage } } : {}),
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
  private failReplayChild(child: ChildState): void {
    child.replayUnavailable = true;
    this.finishChild(child, "failed", true, CHILD_REPLAY_UNAVAILABLE);
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
    this.toolOwners.delete(toolCallId);
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
      if (child.replayUnavailable) {
        child.seenInSnapshot = true;
        continue;
      }
      const terminal = terminalStatus(snapshot.status);
      if (terminal) this.requestTerminal(child, terminal);
      else this.restartChild(child);
      child.seenInSnapshot = true;
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
    runtimeSession: OmpRuntimeSession,
    runtime: OmpRuntime,
    visited: Set<string>,
    budget: ReplayBudget,
    signal: AbortSignal,
  ): Promise<void> {
    const collected: Array<{
      snapshot: OmpSubagentSnapshot;
      sessionFile?: string;
      messages?: OmpMessage[];
    }> = [];
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      if (this.sessionIdByNativeId.has(snapshot.id)) continue;
      try {
        let history: ReplayHistory;
        if (snapshot.sessionFile && isAbsolute(snapshot.sessionFile) && this.rootSessionFile) {
          try {
            history = await waitForReplay(
              runtime.readPersistedSubagentTranscript({
                parentSessionFile: this.rootSessionFile,
                childTranscriptId: snapshot.id,
                sessionFile: snapshot.sessionFile,
                cwd: this.cwd,
                signal,
              }),
              signal,
            );
          } catch (error) {
            if (signal.aborted) throw error;
            history = await waitForReplay(
              runtimeSession.getSubagentMessages({ subagentId: snapshot.id }),
              signal,
            );
          }
        } else {
          history = await waitForReplay(
            runtimeSession.getSubagentMessages({ subagentId: snapshot.id }),
            signal,
          );
        }
        try {
          this.accountReplay(history.messages, budget, signal);
          collected.push({
            snapshot,
            sessionFile: history.sessionFile,
            messages: history.messages,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          collected.push({ snapshot, sessionFile: history.sessionFile });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        collected.push({ snapshot, sessionFile: snapshot.sessionFile });
      }
    }
    collected.sort((left, right) => {
      const leftDepth = left.sessionFile?.split("/").length ?? Number.MAX_SAFE_INTEGER;
      const rightDepth = right.sessionFile?.split("/").length ?? Number.MAX_SAFE_INTEGER;
      return leftDepth - rightDepth;
    });
    const snapshotIds = new Set(collected.map(({ snapshot }) => snapshot.id));
    for (const { snapshot, sessionFile, messages } of collected) {
      signal.throwIfAborted();
      if (this.sessionIdByNativeId.has(snapshot.id)) continue;
      let child: ChildState | undefined;
      try {
        child = this.ensureChild(
          { ...snapshot, sessionFile },
          this.resolveParent(snapshot.parentToolCallId, sessionFile),
        );
        if (!messages || this.isBufferedChildOmitted(snapshot.id)) {
          this.failReplayChild(child);
          continue;
        }
        this.projectReplay(child, messages, signal);
        if (!sessionFile) {
          this.failReplayChild(child);
          continue;
        }
        visited.add(`${sessionFile}\0${snapshot.id}`);
        await this.replayChildren(
          child.sessionId,
          sessionFile,
          messages,
          runtime,
          visited,
          budget,
          signal,
          1,
          snapshotIds,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (child) this.failReplayChild(child);
      }
    }
    const activeToolCallIds = new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.parentToolCallId ? [snapshot.parentToolCallId] : [],
      ),
    );
    for (const toolCallId of this.toolOwners.keys()) {
      if (!activeToolCallIds.has(toolCallId) && !this.dispatches.has(toolCallId)) {
        this.toolOwners.delete(toolCallId);
      }
    }
  }

  private async replayChildren(
    parentSessionId: string,
    parentSessionFile: string | undefined,
    messages: readonly OmpMessage[],
    runtime: OmpRuntime,
    visited: Set<string>,
    budget: ReplayBudget,
    signal: AbortSignal,
    depth: number,
    snapshotIds?: ReadonlySet<string>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (depth > MAX_REPLAY_DEPTH) throw new OmpPublicError("OMP subagent history is too deep");
    this.indexTaskCalls(parentSessionId, messages);
    for (const ref of replayChildren(messages)) {
      signal.throwIfAborted();
      if (!parentSessionFile || snapshotIds?.has(ref.id)) continue;
      const visitKey = `${parentSessionFile}\0${ref.id}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      let child: ChildState | undefined;
      let history: ReplayHistory | undefined;
      try {
        const loaded = await waitForReplay(
          runtime.readPersistedSubagentTranscript({
            parentSessionFile,
            childTranscriptId: ref.id,
            cwd: this.cwd,
            signal,
          }),
          signal,
        );
        history = loaded;
        child = this.ensureChild({ ...ref, sessionFile: loaded.sessionFile }, parentSessionId);
        this.accountReplay(loaded.messages, budget, signal);
        signal.throwIfAborted();
        this.projectReplay(child, loaded.messages, signal);
        await this.replayChildren(
          child.sessionId,
          history.sessionFile,
          history.messages,
          runtime,
          visited,
          budget,
          signal,
          depth + 1,
          snapshotIds,
        );
        signal.throwIfAborted();
        this.requestTerminal(
          child,
          ref.status === "derive" ? replayTerminalStatus(history.messages) : ref.status,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (!child) {
          try {
            child = this.ensureChild(
              { ...ref, sessionFile: history?.sessionFile },
              parentSessionId,
            );
          } catch {
            continue;
          }
        }
        this.failReplayChild(child);
      }
    }
  }

  private projectReplay(
    child: ChildState,
    messages: readonly OmpMessage[],
    signal: AbortSignal,
  ): void {
    this.indexTaskCalls(child.sessionId, messages);
    for (const message of messages) {
      signal.throwIfAborted();
      child.projector.projectReplayMessage(message);
      if (message.role === "assistant") {
        const identity = message.entryId ?? message.responseId ?? message.id;
        if (identity) child.seenAssistantIdentities.add(identity);
      }
    }
    signal.throwIfAborted();
    child.projector.finishReplay();
  }

  private accountReplay(
    messages: readonly OmpMessage[],
    budget: ReplayBudget,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    if (budget.messages + messages.length > MAX_REPLAY_MESSAGES) {
      throw new OmpPublicError("OMP subagent history exceeds replay limits");
    }
    const metrics = boundedJsonMetrics(
      messages,
      MAX_REPLAY_BYTES - budget.bytes,
      MAX_REPLAY_MESSAGES,
      MAX_REPLAY_BYTES,
      MAX_REPLAY_NODES - budget.nodes,
    );
    if (!metrics) throw new OmpPublicError("OMP subagent history exceeds replay limits");
    budget.messages += messages.length;
    budget.bytes += metrics.bytes;
    budget.nodes += metrics.nodes;
  }

  private indexTaskCalls(ownerSessionId: string, messages: readonly OmpMessage[]): void {
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== "task" || !part.id) continue;
        this.registerToolOwner(part.id, ownerSessionId);
      }
    }
  }

  private registerToolOwner(toolCallId: string, ownerSessionId: string): void {
    const existing = this.toolOwners.get(toolCallId);
    if (existing && existing !== ownerSessionId) {
      throw new OmpPublicError("OMP reused a task tool identifier across child sessions");
    }
    if (!existing && this.toolOwners.size >= MAX_TASK_DISPATCHES) {
      throw new OmpPublicError("OMP subagent dispatch limit reached");
    }
    this.toolOwners.set(toolCallId, ownerSessionId);
  }
}
