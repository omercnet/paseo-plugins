import { createHash } from "node:crypto";
import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc";
import {
  BoundedStringSet,
  boundedJsonBytes,
  type JsonValue,
  OmpPublicDataFilter,
  utf8Bytes,
} from "./security";

const STREAM_FRAME_MS = 32;
const MAX_STREAM_CONTENT_BLOCKS = 64;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_TODOS = 256;
const MAX_TURN_NATIVE_IDENTITIES = 1_024;
const MAX_PUBLIC_TOOL_PAYLOAD_BYTES = 256 * 1024;
const MAX_ACTIVE_TOOL_BYTES = 4 * 1024 * 1024;

type Emit = (event: ProviderEvent) => void;

type StreamBlockKind = "assistant_message" | "reasoning";

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

function assistantIdentity(message: OmpMessage, allowMessageId = false): string | undefined {
  if (message.role !== "assistant") return;
  return message.responseId ?? message.entryId ?? (allowMessageId ? message.id : undefined);
}
type OmpAssistantMessage = Extract<OmpMessage, { role: "assistant" }>;

function blockText(
  message: OmpAssistantMessage,
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
  private readonly turnNativeMessageIds = new Map<string, string>();
  private nativeIdentitySaturated = false;
  private assistantIdentitySequence = 0;
  private noticeSequence = 0;
  private toolSequence = 0;
  private userSequence = 0;
  private replayTurnId: string | null = null;
  private replaySequence = 0;
  private readonly replayedNativeMessageIds = new BoundedStringSet(MAX_TURN_NATIVE_IDENTITIES);
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
    const replayedIdentity =
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end"
        ? assistantIdentity(event.message)
        : undefined;
    if (replayedIdentity && this.replayedNativeMessageIds.has(replayedIdentity)) return;
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
        };
        this.activeToolBytes += retainedBytes - (previous?.retainedBytes ?? 0);
        this.tools.set(event.toolCallId, snapshot);
        this.publishTool(snapshot, "running");
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
        this.publishTool(snapshot, "running");
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
        if (event.isError) {
          this.publishTool(snapshot, "failed", snapshot.output);
        } else {
          this.publishTool(snapshot, "completed");
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
    if (event.type === "todo_reminder") {
      this.publish({
        type: "todo",
        id: "omp:todos",
        items: event.todos.slice(0, MAX_TODOS).map((todo, index) => ({
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
      const message = event.message ?? event.title;
      if (!message) return;
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:ui:${this.noticeSequence}`,
        level: event.notifyType ?? "info",
        message: this.dataFilter.text(message, 64 * 1024),
      });
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

  projectReplayMessage(message: OmpMessage): void {
    if (this.closed) return;
    const nativeIdentity = assistantIdentity(message, true);
    if (nativeIdentity && this.replayedNativeMessageIds.has(nativeIdentity)) return;
    this.replaySequence += 1;
    if (message.role === "user") {
      if (this.replayTurnId) this.finishTurn(this.replayTurnId);
      this.replayTurnId = `omp:replay-turn:${this.replaySequence}`;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("\n\n");
      if (text) {
        this.publishUser(
          text,
          `omp:replay-user:${this.replaySequence}`,
          message.entryId ?? message.id,
        );
      }
      return;
    }
    if (message.role === "assistant") {
      this.replayTurnId ??= `omp:replay-turn:${this.replaySequence}`;
      this.project({ type: "message_start", message }, this.replayTurnId);
      this.project({ type: "message_end", message }, this.replayTurnId);
      if (nativeIdentity) this.replayedNativeMessageIds.add(nativeIdentity);
      return;
    }
    this.replayTurnId ??= `omp:replay-turn:${this.replaySequence}`;
    if (message.role === "toolResult") {
      this.project(
        {
          type: "tool_execution_start",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          args: null,
        },
        this.replayTurnId,
      );
      this.project(
        {
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: message.content,
          isError: message.isError,
        },
        this.replayTurnId,
      );
      return;
    }
    if (message.role === "bashExecution") {
      const text = message.output
        ? `$ ${message.command}\n${message.output}`
        : `$ ${message.command}`;
      this.project({ type: "command_output", text }, this.replayTurnId);
      this.finishTurn(this.replayTurnId);
      this.replayTurnId = null;
    }
  }
  finishReplay(): void {
    if (this.replayTurnId) this.finishTurn(this.replayTurnId);
    this.replayTurnId = null;
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

  private beginStream(message: OmpAssistantMessage, turnId: string): StreamSnapshot | null {
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

  private updateStream(
    message: OmpAssistantMessage,
    turnId: string,
    update?: AssistantMessageEvent,
  ): void {
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

  private updateAllBlocks(message: OmpAssistantMessage): void {
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
    message: OmpAssistantMessage,
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
        : undefined;
    if (!kind) return;
    const previous = stream.blocks.get(contentIndex);
    const eventContent = typeof update.content === "string" ? update.content : undefined;
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

  private publishTool(snapshot: ToolSnapshot, status: "running" | "completed"): void;
  private publishTool(snapshot: ToolSnapshot, status: "failed", error: JsonValue): void;
  private publishTool(
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
