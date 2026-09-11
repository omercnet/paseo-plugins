import { createHash } from "node:crypto";
import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc";
import { boundedJsonBytes, type JsonValue, OmpPublicDataFilter, utf8Bytes } from "./security";

const STREAM_FRAME_MS = 32;
const MAX_STREAM_CONTENT_BLOCKS = 64;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_TODOS = 256;
const MAX_TURN_NATIVE_IDENTITIES = 1_024;
const MAX_PUBLIC_TOOL_PAYLOAD_BYTES = 256 * 1024;
const MAX_ACTIVE_TOOL_BYTES = 4 * 1024 * 1024;

type Emit = (event: ProviderEvent) => void;

type StreamBlockKind = "assistant_message" | "reasoning" | "image";

type StreamBlockSnapshot = {
  kind: StreamBlockKind;
  text: string;
  publishedText?: string;
};

type StreamSnapshot = {
  messageId: string;
  nativeIdentity?: string;
  published: boolean;
  blocks: Map<number, StreamBlockSnapshot>;
  dirtyBlocks: Set<number>;
};

type ToolSnapshot = {
  publicId: string;
  name: string;
  input: JsonValue;
  output: JsonValue;
  retainedBytes: number;
  unsafePartialOutput: boolean;
  silent: boolean;
};

export interface OmpTimelineScheduler {
  set(callback: () => void | Promise<void>, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const defaultOmpTimelineScheduler: OmpTimelineScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type AssistantMessageEvent = Extract<
  OmpRpcEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

function assistantIdentity(message: OmpMessage): string | undefined {
  return message.responseId ?? message.entryId;
}

function blockText(
  message: OmpMessage,
  contentIndex: number,
): { kind: StreamBlockKind; text: string } | undefined {
  if (typeof message.content === "string") {
    return contentIndex === 0 ? { kind: "assistant_message", text: message.content } : undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const part = message.content[contentIndex];
  if (part?.type === "text") return { kind: "assistant_message", text: part.text ?? "" };
  if (part?.type === "thinking") return { kind: "reasoning", text: part.thinking ?? "" };
  if (part?.type === "image" && part.data && part.mimeType) {
    return { kind: "image", text: `![OMP image](data:${part.mimeType};base64,${part.data})` };
  }
  return undefined;
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function firstString(
  record: Record<string, JsonValue> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function displayText(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  const record = jsonRecord(value);
  const direct = firstString(record, "content", "text", "output", "message", "result", "log");
  if (direct !== undefined) return direct;
  if (value === null) return undefined;
  return JSON.stringify(value);
}

export class OmpTimelineProjector {
  private readonly tools = new Map<string, ToolSnapshot>();
  private stream: StreamSnapshot | null = null;
  private flushTimer: unknown;
  private currentTurnId: string | null = null;
  private assistantSequence = 0;
  private readonly turnNativeMessageIds = new Map<string, string>();
  private nativeIdentitySaturated = false;
  private assistantIdentitySequence = 0;
  private noticeSequence = 0;
  private toolSequence = 0;
  private userSequence = 0;
  private customSequence = 0;
  private compactionSequence = 0;
  private activeCompactionId: string | null = null;
  private activeToolBytes = 0;
  private commandText = "";
  private commandPublishedText = "";
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
    sensitiveValues: Iterable<string> = [],
  ) {
    this.dataFilter = new OmpPublicDataFilter(sensitiveValues);
  }

  private readonly dataFilter: OmpPublicDataFilter;
  addSensitiveValues(values: Iterable<string>): void {
    this.dataFilter.addSensitiveValues(values);
  }

  project(event: OmpRpcEvent, turnId: string): void {
    if (this.closed) return;
    if (
      event.type === "todo_reminder" ||
      event.type === "todo_auto_clear" ||
      event.type === "notice" ||
      event.type === "extension_ui_request" ||
      event.type === "auto_compaction_start" ||
      event.type === "auto_compaction_end"
    ) {
      this.projectPassive(event);
      return;
    }
    this.ensureTurn(turnId);
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant") return;
        if (this.stream) {
          this.flush(true);
          this.stream = null;
        }
        this.beginStream(event.message, turnId);
        this.updateAllBlocks(event.message);
        this.scheduleFlush();
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId, event.assistantMessageEvent);
        this.scheduleFlush();
        return;
      case "message_end":
        if (event.message.role === "custom") {
          this.publishCustomMessage(event.message);
          return;
        }
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId);
        this.flush(true);
        this.stream = null;
        return;
      case "tool_execution_start": {
        this.flush(true);
        const previous = this.tools.get(event.toolCallId);
        if (!previous && this.tools.size >= MAX_ACTIVE_TOOLS) return;
        const input = this.dataFilter.json(
          event.args,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
        );
        const retainedBytes = boundedJsonBytes(input, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        if (
          this.activeToolBytes - (previous?.retainedBytes ?? 0) + retainedBytes >
          MAX_ACTIVE_TOOL_BYTES
        ) {
          return;
        }
        if (!previous) this.toolSequence += 1;
        const snapshot: ToolSnapshot = {
          publicId: previous?.publicId ?? `omp:tool:${this.toolSequence}`,
          name: this.dataFilter.text(event.toolName, 256),
          input,
          output: null,
          retainedBytes,
          unsafePartialOutput: previous?.unsafePartialOutput ?? false,
          silent: event.toolName.toLowerCase() === "ask",
        };
        this.activeToolBytes += retainedBytes - (previous?.retainedBytes ?? 0);
        this.tools.set(event.toolCallId, snapshot);
        if (!snapshot.silent) this.publishTool(snapshot, "running");
        return;
      }
      case "tool_execution_update": {
        const previous = this.tools.get(event.toolCallId);
        if (!previous) return;
        if (
          previous.unsafePartialOutput ||
          this.dataFilter.hasUnsafeStreamSuffix(event.partialResult)
        ) {
          this.tools.set(event.toolCallId, { ...previous, unsafePartialOutput: true });
          return;
        }
        const output = this.dataFilter.json(
          event.partialResult,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
        );
        const outputBytes = boundedJsonBytes(output, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        const inputBytes = boundedJsonBytes(previous.input, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        const retainedBytes = inputBytes + outputBytes;
        if (this.activeToolBytes - previous.retainedBytes + retainedBytes > MAX_ACTIVE_TOOL_BYTES)
          return;
        const snapshot: ToolSnapshot = { ...previous, output, retainedBytes };
        this.activeToolBytes += retainedBytes - previous.retainedBytes;
        this.tools.set(event.toolCallId, snapshot);
        if (!snapshot.silent) this.publishTool(snapshot, "running");
        return;
      }
      case "tool_execution_end": {
        const previous = this.tools.get(event.toolCallId);
        if (!previous) return;
        const output = previous.unsafePartialOutput
          ? "<redacted>"
          : this.dataFilter.json(
              event.result,
              MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
              MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
            );
        const snapshot: ToolSnapshot = {
          ...previous,
          output,
          retainedBytes: previous.retainedBytes,
        };
        this.tools.delete(event.toolCallId);
        this.activeToolBytes -= previous.retainedBytes;
        if (!snapshot.silent) {
          if (event.isError) {
            this.publishTool(snapshot, "failed", snapshot.output);
          } else {
            this.publishTool(snapshot, "completed");
          }
        }
        return;
      }
      case "command_output": {
        if (!event.text) return;
        const next = `${this.commandText}${event.text}`;
        if (utf8Bytes(next) > MAX_STREAM_TEXT_LENGTH) return;
        this.commandText = next;
        this.publishCommand(turnId, false);
        return;
      }
    }
  }

  projectPassive(event: OmpRpcEvent): void {
    if (this.closed) return;
    if (event.type === "todo_reminder" || event.type === "todo_auto_clear") {
      const todos = event.type === "todo_reminder" ? event.todos : [];
      this.publish({
        type: "todo",
        id: "omp:todos",
        items: todos.slice(0, MAX_TODOS).map((todo, index) => ({
          id: `omp:todo:${index}`,
          text: this.dataFilter.text(todo.content, 16_384),
          completed: todo.status === "completed" || todo.status === "abandoned",
          status:
            todo.status === "completed" || todo.status === "abandoned"
              ? "completed"
              : todo.status === "blocked"
                ? "pending"
                : todo.status,
        })),
      });
      return;
    }
    if (event.type === "notice") {
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:notice:${this.noticeSequence}`,
        level: event.level,
        message: this.dataFilter.text(event.message, 64 * 1024),
      });
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "notify") {
      if (!event.message) return;
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:ui:${this.noticeSequence}`,
        level: event.notifyType ?? "info",
        message: this.dataFilter.text(event.message, 64 * 1024),
      });
      return;
    }
    if (event.type === "auto_compaction_start") {
      this.compactionSequence += 1;
      this.activeCompactionId = `omp:compaction:${this.compactionSequence}`;
      this.publish({
        type: "compaction",
        id: this.activeCompactionId,
        status: "loading",
        trigger: "auto",
      });
      return;
    }
    if (event.type === "auto_compaction_end") {
      const id = this.activeCompactionId ?? `omp:compaction:${++this.compactionSequence}`;
      const result = jsonRecord(this.dataFilter.json(event.result ?? null));
      const rawPreTokens = result?.preTokens ?? result?.tokensBefore;
      this.publish({
        type: "compaction",
        id,
        status: "completed",
        trigger: "auto",
        ...(typeof rawPreTokens === "number" && Number.isFinite(rawPreTokens)
          ? { preTokens: Math.max(0, Math.trunc(rawPreTokens)) }
          : {}),
      });
      this.activeCompactionId = null;
    }
  }

  publishUser(text: string, clientMessageId: string, nativeId?: string): void {
    this.userSequence += 1;
    const nativeHash = nativeId
      ? createHash("sha256").update(nativeId).digest("base64url").slice(0, 12)
      : "local";
    const messageId = `omp:user:${this.userSequence}:${nativeHash}`;
    this.publish({
      type: "user_message",
      id: messageId,
      messageId,
      clientMessageId,
      text: this.dataFilter.text(text),
    });
  }

  flush(finalizeFallback = false): void {
    this.clearFlushTimer();
    if (!this.stream || this.closed || this.stream.dirtyBlocks.size === 0) return;
    const stream = this.stream;
    if (!stream.nativeIdentity && !finalizeFallback) return;
    const indexes = [...stream.dirtyBlocks].sort((left, right) => left - right);
    stream.dirtyBlocks.clear();
    for (const contentIndex of indexes) {
      const block = stream.blocks.get(contentIndex);
      if (!block?.text) continue;
      const publicText = this.dataFilter.streamText(block.text, finalizeFallback);
      if (publicText.pending) stream.dirtyBlocks.add(contentIndex);
      if (!publicText.text || block.publishedText === publicText.text) continue;
      const suffix = block.kind === "reasoning" ? "reasoning" : "text";
      const id = `${stream.messageId}:content:${contentIndex}:${suffix}`;
      if (block.kind === "reasoning") {
        this.publish({ type: "reasoning", id, text: publicText.text });
      } else {
        this.publish({
          type: "assistant_message",
          id,
          messageId: stream.messageId,
          text: publicText.text,
        });
      }
      block.publishedText = publicText.text;
      stream.published = true;
    }
  }

  finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    this.flush(true);
    this.publishCommand(turnId, true);
    this.stream = null;
    this.activeToolBytes = 0;
    this.tools.clear();
    this.commandText = "";
    this.currentTurnId = null;
    this.assistantSequence = 0;
    this.turnNativeMessageIds.clear();
    this.nativeIdentitySaturated = false;
  }

  close(): void {
    this.flush(true);
    if (this.currentTurnId) this.publishCommand(this.currentTurnId, true);
    this.closed = true;
    this.clearFlushTimer();
    this.stream = null;
    this.tools.clear();
    this.activeToolBytes = 0;
  }

  private ensureTurn(turnId: string): void {
    if (this.currentTurnId === turnId) return;
    if (this.currentTurnId) this.finishTurn(this.currentTurnId);
    this.currentTurnId = turnId;
    this.assistantSequence = 0;
    this.commandText = "";
    this.commandPublishedText = "";
  }

  private beginStream(message: OmpMessage, turnId: string): StreamSnapshot | null {
    this.assistantSequence += 1;
    const nativeIdentity = assistantIdentity(message);
    const messageId = nativeIdentity
      ? this.messageIdForNativeIdentity(nativeIdentity)
      : this.nextAssistantMessageId(`turn:${turnId}:${this.assistantSequence}`);
    if (!messageId) return null;
    this.stream = {
      messageId,
      ...(nativeIdentity ? { nativeIdentity } : {}),
      published: false,
      blocks: new Map(),
      dirtyBlocks: new Set(),
    };
    return this.stream;
  }

  private messageIdForNativeIdentity(nativeIdentity: string): string | undefined {
    const existing = this.turnNativeMessageIds.get(nativeIdentity);
    if (existing) return existing;
    if (
      this.nativeIdentitySaturated ||
      this.turnNativeMessageIds.size >= MAX_TURN_NATIVE_IDENTITIES
    ) {
      this.nativeIdentitySaturated = true;
      return undefined;
    }
    const messageId = this.nextAssistantMessageId(nativeIdentity);
    this.turnNativeMessageIds.set(nativeIdentity, messageId);
    return messageId;
  }

  private nextAssistantMessageId(source: string): string {
    this.assistantIdentitySequence += 1;
    const digest = createHash("sha256").update(source).digest("base64url").slice(0, 12);
    return `omp:assistant:${this.assistantIdentitySequence}:${digest}`;
  }

  private updateStream(message: OmpMessage, turnId: string, update?: AssistantMessageEvent): void {
    const nativeIdentity = assistantIdentity(message);
    if (this.stream && nativeIdentity && this.stream.nativeIdentity !== nativeIdentity) {
      if (!this.stream.nativeIdentity && !this.stream.published) {
        const messageId = this.messageIdForNativeIdentity(nativeIdentity);
        if (!messageId) {
          this.stream = null;
          return;
        }
        this.stream.messageId = messageId;
        this.stream.nativeIdentity = nativeIdentity;
      } else {
        this.flush();
        this.stream = null;
      }
    }
    const stream = this.stream ?? this.beginStream(message, turnId);
    if (!stream) return;
    if (update?.contentIndex !== undefined) {
      this.updateBlock(stream, message, update.contentIndex, update);
      return;
    }
    this.updateAllBlocks(message);
  }

  private updateAllBlocks(message: OmpMessage): void {
    const stream = this.stream;
    if (!stream) return;
    if (typeof message.content === "string") {
      this.setBlock(stream, 0, { kind: "assistant_message", text: message.content });
      return;
    }
    if (!Array.isArray(message.content)) return;
    const blockCount = Math.min(message.content.length, MAX_STREAM_CONTENT_BLOCKS);
    for (let index = 0; index < blockCount; index += 1) {
      const block = blockText(message, index);
      if (block) this.setBlock(stream, index, block);
    }
  }

  private updateBlock(
    stream: StreamSnapshot,
    message: OmpMessage,
    contentIndex: number,
    update: NonNullable<AssistantMessageEvent>,
  ): void {
    if (!this.isValidContentIndex(contentIndex)) return;
    const snapshot = blockText(message, contentIndex);
    if (snapshot) {
      this.setBlock(stream, contentIndex, snapshot);
      return;
    }
    const kind = update.type.startsWith("thinking_")
      ? "reasoning"
      : update.type.startsWith("text_")
        ? "assistant_message"
        : update.type.startsWith("image_")
          ? "image"
          : undefined;
    if (!kind) return;
    const previous = stream.blocks.get(contentIndex);
    const content = update.content;
    const eventContent =
      typeof content === "string"
        ? content
        : content && typeof content === "object" && !Array.isArray(content)
          ? (() => {
              const image = content as { type?: unknown; data?: unknown; mimeType?: unknown };
              return image.type === "image" &&
                typeof image.data === "string" &&
                typeof image.mimeType === "string"
                ? `![OMP image](data:${image.mimeType};base64,${image.data})`
                : undefined;
            })()
          : undefined;
    const text =
      eventContent ??
      (update.delta !== undefined && previous?.kind === kind
        ? `${previous.text}${update.delta}`
        : (update.delta ?? previous?.text ?? ""));
    this.setBlock(stream, contentIndex, { kind, text });
  }

  private setBlock(
    stream: StreamSnapshot,
    contentIndex: number,
    snapshot: StreamBlockSnapshot,
  ): void {
    if (!this.isValidContentIndex(contentIndex)) return;
    let totalLength = utf8Bytes(snapshot.text);
    for (const [index, block] of stream.blocks) {
      if (index !== contentIndex) totalLength += utf8Bytes(block.text);
      if (totalLength > MAX_STREAM_TEXT_LENGTH) return;
    }
    const previous = stream.blocks.get(contentIndex);
    if (previous?.kind === snapshot.kind && previous.text === snapshot.text) return;
    stream.blocks.set(contentIndex, {
      ...snapshot,
      ...(previous?.kind === snapshot.kind ? { publishedText: previous.publishedText } : {}),
    });
    stream.dirtyBlocks.add(contentIndex);
  }

  private isValidContentIndex(contentIndex: number): boolean {
    return (
      Number.isSafeInteger(contentIndex) &&
      contentIndex >= 0 &&
      contentIndex < MAX_STREAM_CONTENT_BLOCKS
    );
  }

  private publishCommand(turnId: string, final: boolean): void {
    if (!this.commandText) return;
    const publicText = this.dataFilter.streamText(this.commandText, final).text;
    if (!publicText || publicText === this.commandPublishedText) return;
    this.commandPublishedText = publicText;
    this.publish({
      type: "assistant_message",
      id: `omp:command:${turnId}`,
      messageId: `omp:command:${turnId}`,
      text: publicText,
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.scheduler.set(() => {
      this.flushTimer = undefined;
      this.flush();
    }, STREAM_FRAME_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    this.scheduler.clear(this.flushTimer);
    this.flushTimer = undefined;
  }

  private publishCustomMessage(message: OmpMessage): void {
    if (message.display === false) return;
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                part.type === "text"
                  ? part.text
                  : part.type === "image" && part.data && part.mimeType
                    ? `![OMP image](data:${part.mimeType};base64,${part.data})`
                    : undefined,
              )
              .filter((part): part is string => part !== undefined)
              .join("\n\n")
          : "";
    if (!content) return;
    this.customSequence += 1;
    const customType = message.customType ?? "custom";
    const lowerType = customType.toLowerCase();
    const details = jsonRecord(this.dataFilter.json(message.details ?? null));
    const id = `omp:custom:${this.customSequence}`;
    if (lowerType.includes("bash") || lowerType.includes("shell") || lowerType.includes("python")) {
      this.publish({
        type: "tool_call",
        id,
        callId: id,
        name: customType,
        detail: {
          type: "shell",
          command: firstString(details, "command", "input") ?? customType,
          ...(firstString(details, "cwd") ? { cwd: firstString(details, "cwd") } : {}),
          output: this.dataFilter.text(content),
          ...(typeof details?.exitCode === "number" ? { exitCode: details.exitCode } : {}),
        },
        status: "completed",
        error: null,
      });
      return;
    }
    this.publish({
      type: "tool_call",
      id,
      callId: id,
      name: customType,
      detail: {
        type: "plain_text",
        label: lowerType.includes("advisor") || lowerType === "aside" ? "Advisor" : customType,
        text: this.dataFilter.text(content),
        icon: lowerType.includes("advisor") || lowerType === "aside" ? "brain" : "sparkles",
      },
      status: "completed",
      error: null,
    });
  }

  private toolDetail(snapshot: ToolSnapshot): ProviderToolCallDetail {
    const input = jsonRecord(snapshot.input);
    const output = jsonRecord(snapshot.output);
    const resultText = displayText(snapshot.output);
    const name = snapshot.name.toLowerCase();
    if (["bash", "shell", "exec", "run_command"].includes(name)) {
      return {
        type: "shell",
        command: firstString(input, "command", "cmd") ?? snapshot.name,
        ...(firstString(input, "cwd") ? { cwd: firstString(input, "cwd") } : {}),
        ...(resultText !== undefined ? { output: resultText } : {}),
        ...(typeof output?.exitCode === "number" ? { exitCode: output.exitCode } : {}),
      };
    }
    if (name === "read") {
      const filePath = firstString(input, "path", "filePath", "url");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      if (/^https?:\/\//u.test(filePath)) {
        return {
          type: "fetch",
          url: filePath,
          ...(resultText !== undefined ? { result: resultText } : {}),
        };
      }
      return {
        type: "read",
        filePath,
        ...(resultText !== undefined ? { content: resultText } : {}),
        ...(typeof input?.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      };
    }
    if (name === "edit" || name === "apply_patch") {
      const filePath = firstString(input, "path", "filePath");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      return {
        type: "edit",
        filePath,
        ...(firstString(input, "oldString", "old_text")
          ? { oldString: firstString(input, "oldString", "old_text") }
          : {}),
        ...(firstString(input, "newString", "new_text")
          ? { newString: firstString(input, "newString", "new_text") }
          : {}),
        ...(firstString(output, "unifiedDiff", "diff")
          ? { unifiedDiff: firstString(output, "unifiedDiff", "diff") }
          : {}),
      };
    }
    if (name === "write") {
      const filePath = firstString(input, "path", "filePath");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      return {
        type: "write",
        filePath,
        ...(firstString(input, "content") ? { content: firstString(input, "content") } : {}),
      };
    }
    if (["grep", "glob", "search", "web_search"].includes(name)) {
      const toolName =
        name === "web_search"
          ? "web_search"
          : name === "glob"
            ? "glob"
            : name === "grep"
              ? "grep"
              : "search";
      return {
        type: "search",
        query: firstString(input, "query", "pattern", "path") ?? "",
        toolName,
        ...(resultText !== undefined ? { content: resultText } : {}),
      };
    }
    if (name === "fetch" || name === "web_fetch") {
      return {
        type: "fetch",
        url: firstString(input, "url") ?? "",
        ...(firstString(input, "prompt") ? { prompt: firstString(input, "prompt") } : {}),
        ...(resultText !== undefined ? { result: resultText } : {}),
      };
    }
    if (["task", "agent", "subagent"].includes(name)) {
      return {
        type: "sub_agent",
        ...(firstString(input, "agent", "name")
          ? { subAgentType: firstString(input, "agent", "name") }
          : {}),
        ...(firstString(input, "description", "task")
          ? { description: firstString(input, "description", "task") }
          : {}),
        log: resultText ?? "",
      };
    }
    if (name === "advisor") {
      return { type: "plain_text", label: "Advisor", text: resultText, icon: "brain" };
    }
    if (name === "todo") {
      return { type: "plan", text: resultText ?? JSON.stringify(snapshot.input) };
    }
    return { type: "unknown", input: snapshot.input, output: snapshot.output };
  }

  private publishTool(snapshot: ToolSnapshot, status: "running" | "completed"): void;
  private publishTool(snapshot: ToolSnapshot, status: "failed", error: JsonValue): void;
  private publishTool(
    snapshot: ToolSnapshot,
    status: "running" | "completed" | "failed",
    error?: JsonValue,
  ): void {
    const detail = this.toolDetail(snapshot);
    if (status === "failed") {
      this.publish({
        type: "tool_call",
        id: snapshot.publicId,
        callId: snapshot.publicId,
        name: snapshot.name,
        detail,
        status,
        error: error ?? null,
      });
      return;
    }
    this.publish({
      type: "tool_call",
      id: snapshot.publicId,
      callId: snapshot.publicId,
      name: snapshot.name,
      detail,
      status,
      error: null,
    });
  }

  private publish(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }
}
