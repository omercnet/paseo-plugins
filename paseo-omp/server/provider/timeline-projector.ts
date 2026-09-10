import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc";

const STREAM_FRAME_MS = 32;

type Emit = (event: ProviderEvent) => void;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type StreamSnapshot = {
  assistantId: string;
  reasoningId: string;
  message: OmpMessage;
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

function extractStreamText(message: OmpMessage): { assistant: string; reasoning: string } {
  if (!Array.isArray(message.content)) return { assistant: "", reasoning: "" };
  const assistant: string[] = [];
  const reasoning: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) assistant.push(part.text);
    else if (part.type === "thinking" && part.thinking) reasoning.push(part.thinking);
  }
  return { assistant: assistant.join(""), reasoning: reasoning.join("") };
}

export class OmpTimelineProjector {
  private readonly tools = new Map<string, ToolSnapshot>();
  private stream: StreamSnapshot | null = null;
  private flushTimer: unknown;
  private currentTurnId: string | null = null;
  private assistantSequence = 0;
  private commandText = "";
  private dirty = false;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ) {}

  project(event: OmpRpcEvent, turnId: string): void {
    if (this.closed) return;
    this.ensureTurn(turnId);
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant") return;
        if (this.stream) {
          this.flush();
          this.stream = null;
        }
        this.beginStream(event.message, turnId);
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId);
        this.scheduleFlush();
        return;
      case "message_end":
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId);
        this.flush();
        this.stream = null;
        return;
      case "tool_execution_start": {
        this.flush();
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
      case "todo_reminder":
        this.publish({
          type: "todo",
          id: "omp:todos",
          items: event.todos.map((todo, index) => ({
            id: todo.id ?? `omp:todo:${index}`,
            text: todo.content,
            completed: todo.status === "completed" || todo.status === "abandoned",
            status: todo.status === "abandoned" ? "completed" : todo.status,
          })),
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

  flush(): void {
    this.clearFlushTimer();
    if (!this.dirty || !this.stream || this.closed) return;
    this.dirty = false;
    const text = extractStreamText(this.stream.message);
    if (text.reasoning) {
      this.publish({ type: "reasoning", id: this.stream.reasoningId, text: text.reasoning });
    }
    if (text.assistant) {
      this.publish({
        type: "assistant_message",
        id: this.stream.assistantId,
        messageId: this.stream.assistantId,
        text: text.assistant,
      });
    }
  }

  finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    this.flush();
    this.stream = null;
    this.dirty = false;
    this.tools.clear();
    this.commandText = "";
    this.currentTurnId = null;
    this.assistantSequence = 0;
  }

  close(): void {
    this.flush();
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
    const assistantId =
      message.responseId ??
      message.entryId ??
      message.id ??
      `assistant:${turnId}:${this.assistantSequence}`;
    this.stream = {
      assistantId,
      reasoningId: `${assistantId}:reasoning`,
      message,
    };
    return this.stream;
  }

  private updateStream(message: OmpMessage, turnId: string): void {
    const responseId = message.responseId ?? message.entryId ?? message.id;
    if (this.stream && responseId && responseId !== this.stream.assistantId) {
      this.flush();
      this.stream = null;
    }
    const stream = this.stream ?? this.beginStream(message, turnId);
    stream.message = message;
    this.dirty = true;
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
