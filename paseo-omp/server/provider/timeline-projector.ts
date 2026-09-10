import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc";

const STREAM_FRAME_MS = 32;

type Emit = (event: ProviderEvent) => void;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type StreamBlockKind = "assistant_message" | "reasoning";

type StreamBlockSnapshot = {
  kind: StreamBlockKind;
  text: string;
};

type StreamSnapshot = {
  messageId: string;
  nativeIdentity?: string;
  published: boolean;
  blocks: Map<number, StreamBlockSnapshot>;
  dirtyBlocks: Set<number>;
};

type ToolSnapshot = {
  name: string;
  input: JsonValue;
  output: JsonValue;
};

export interface OmpTimelineScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const defaultOmpTimelineScheduler: OmpTimelineScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

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
  return undefined;
}

export class OmpTimelineProjector {
  private readonly tools = new Map<string, ToolSnapshot>();
  private stream: StreamSnapshot | null = null;
  private flushTimer: unknown;
  private currentTurnId: string | null = null;
  private assistantSequence = 0;
  private noticeSequence = 0;
  private commandText = "";
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ) {}

  project(event: OmpRpcEvent, turnId: string): void {
    if (this.closed) return;
    if (
      event.type === "todo_reminder" ||
      event.type === "notice" ||
      event.type === "extension_ui_request"
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
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId);
        this.flush(true);
        this.stream = null;
        return;
      case "tool_execution_start": {
        this.flush(true);
        const snapshot: ToolSnapshot = {
          name: event.toolName,
          input: toJsonValue(event.args),
          output: null,
        };
        this.tools.set(event.toolCallId, snapshot);
        this.publishTool(event.toolCallId, snapshot, "running");
        return;
      }
      case "tool_execution_update": {
        const previous = this.tools.get(event.toolCallId);
        const snapshot: ToolSnapshot = {
          name: event.toolName,
          input: previous?.input ?? toJsonValue(event.args),
          output: toJsonValue(event.partialResult),
        };
        this.tools.set(event.toolCallId, snapshot);
        this.publishTool(event.toolCallId, snapshot, "running");
        return;
      }
      case "tool_execution_end": {
        const previous = this.tools.get(event.toolCallId);
        const snapshot: ToolSnapshot = {
          name: event.toolName,
          input: previous?.input ?? null,
          output: toJsonValue(event.result),
        };
        this.tools.delete(event.toolCallId);
        if (event.isError) {
          this.publishTool(event.toolCallId, snapshot, "failed", snapshot.output);
        } else {
          this.publishTool(event.toolCallId, snapshot, "completed");
        }
        return;
      }
      case "command_output":
        if (!event.text) return;
        this.commandText += event.text;
        this.publish({
          type: "assistant_message",
          id: `command:${turnId}`,
          messageId: `command:${turnId}`,
          text: this.commandText,
        });
        return;
    }
  }

  projectPassive(event: OmpRpcEvent): void {
    if (this.closed) return;
    if (event.type === "todo_reminder") {
      this.publish({
        type: "todo",
        id: "omp:todos",
        items: event.todos.map((todo, index) => ({
          id: todo.id ?? `omp:todo:${index}`,
          text: todo.content,
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
        id: event.id ?? `omp:notice:${this.noticeSequence}`,
        level: event.level,
        message: event.source ? `${event.source}: ${event.message}` : event.message,
      });
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "notify") {
      const message = event.message ?? event.title;
      if (!message) return;
      this.publish({
        type: "notification",
        id: `omp:ui:${event.id}`,
        level: event.notifyType ?? "info",
        message,
      });
    }
  }

  publishUser(text: string, clientMessageId: string, nativeId?: string): void {
    this.publish({
      type: "user_message",
      id: nativeId ?? `user:${clientMessageId}`,
      ...(nativeId ? { messageId: nativeId } : {}),
      clientMessageId,
      text,
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
      const suffix = block.kind === "reasoning" ? "reasoning" : "text";
      const id = `${stream.messageId}:content:${contentIndex}:${suffix}`;
      if (block.kind === "reasoning") {
        this.publish({ type: "reasoning", id, text: block.text });
      } else {
        this.publish({
          type: "assistant_message",
          id,
          messageId: stream.messageId,
          text: block.text,
        });
      }
      stream.published = true;
    }
  }

  finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    this.flush(true);
    this.stream = null;
    this.tools.clear();
    this.commandText = "";
    this.currentTurnId = null;
    this.assistantSequence = 0;
  }

  close(): void {
    this.flush(true);
    this.closed = true;
    this.clearFlushTimer();
    this.stream = null;
    this.tools.clear();
  }

  private ensureTurn(turnId: string): void {
    if (this.currentTurnId === turnId) return;
    if (this.currentTurnId) this.finishTurn(this.currentTurnId);
    this.currentTurnId = turnId;
    this.assistantSequence = 0;
    this.commandText = "";
  }

  private beginStream(message: OmpMessage, turnId: string): StreamSnapshot {
    this.assistantSequence += 1;
    const nativeIdentity = assistantIdentity(message);
    this.stream = {
      messageId: nativeIdentity ?? `assistant:${turnId}:${this.assistantSequence}`,
      ...(nativeIdentity ? { nativeIdentity } : {}),
      published: false,
      blocks: new Map(),
      dirtyBlocks: new Set(),
    };
    return this.stream;
  }

  private updateStream(
    message: OmpMessage,
    turnId: string,
    update?: AssistantMessageEvent,
  ): void {
    const nativeIdentity = assistantIdentity(message);
    if (this.stream && nativeIdentity && this.stream.nativeIdentity !== nativeIdentity) {
      if (!this.stream.nativeIdentity) {
        if (!this.stream.published) {
          this.stream.messageId = nativeIdentity;
          this.stream.nativeIdentity = nativeIdentity;
        }
      } else {
        this.flush();
        this.stream = null;
      }
    }
    const stream = this.stream ?? this.beginStream(message, turnId);
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
    for (let index = 0; index < message.content.length; index += 1) {
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
    const snapshot = blockText(message, contentIndex);
    if (snapshot) {
      this.setBlock(stream, contentIndex, snapshot);
      return;
    }
    const kind = update.type.startsWith("thinking_")
      ? "reasoning"
      : update.type.startsWith("text_")
        ? "assistant_message"
        : undefined;
    if (!kind) return;
    const previous = stream.blocks.get(contentIndex);
    const eventContent = typeof update.content === "string" ? update.content : undefined;
    const text =
      eventContent ??
      (update.delta !== undefined && previous?.kind === kind
        ? `${previous.text}${update.delta}`
        : update.delta ?? previous?.text ?? "");
    this.setBlock(stream, contentIndex, { kind, text });
  }

  private setBlock(
    stream: StreamSnapshot,
    contentIndex: number,
    snapshot: StreamBlockSnapshot,
  ): void {
    const previous = stream.blocks.get(contentIndex);
    if (previous?.kind === snapshot.kind && previous.text === snapshot.text) return;
    stream.blocks.set(contentIndex, snapshot);
    stream.dirtyBlocks.add(contentIndex);
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

  private publishTool(
    callId: string,
    snapshot: ToolSnapshot,
    status: "running" | "completed",
  ): void;
  private publishTool(
    callId: string,
    snapshot: ToolSnapshot,
    status: "failed",
    error: JsonValue,
  ): void;
  private publishTool(
    callId: string,
    snapshot: ToolSnapshot,
    status: "running" | "completed" | "failed",
    error?: JsonValue,
  ): void {
    const detail: ProviderToolCallDetail = {
      type: "unknown",
      input: snapshot.input,
      output: snapshot.output,
    };
    if (status === "failed") {
      this.publish({
        type: "tool_call",
        id: callId,
        callId,
        name: snapshot.name,
        detail,
        status,
        error: error ?? null,
      });
      return;
    }
    this.publish({
      type: "tool_call",
      id: callId,
      callId,
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
