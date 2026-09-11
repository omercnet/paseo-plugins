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
const MAX_IMAGE_MARKDOWN_LENGTH = 8 * 1024 * 1024 + 256;
const MAX_STREAM_TOTAL_BYTES = MAX_IMAGE_MARKDOWN_LENGTH * 2;
const MAX_NATIVE_IMAGE_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_ACTIVE_COMPACTIONS = 8;

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
  retainedBytes: number;
  publishedBytes: number;
  blocks: Map<number, StreamBlockSnapshot>;
  dirtyBlocks: Set<number>;
};

type ToolSnapshot = {
  publicId: string;
  nativeName: string;
  name: string;
  input: JsonValue;
  output: JsonValue;
  retainedBytes: number;
  specializedRendered: boolean;
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

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
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

function todoPublicId(nativeId: string | undefined, index: number): string {
  if (!nativeId) return `omp:todo:${index}`;
  const digest = createHash("sha256").update(nativeId).digest("base64url").slice(0, 12);
  return `omp:todo:${digest}`;
}

function displayText(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .flatMap((part) => {
        const record = jsonRecord(part);
        return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n");
    return text || (value.length > 0 ? JSON.stringify(value) : undefined);
  }
  const record = jsonRecord(value);
  const direct = firstString(record, "text", "output", "message", "result", "log");
  if (direct !== undefined) return direct;
  if (record?.content !== undefined) return displayText(record.content);
  if (value === null) return undefined;
  return JSON.stringify(value);
}

function resultDetails(value: JsonValue): Record<string, JsonValue> | undefined {
  const envelope = jsonRecord(value);
  return jsonRecord(envelope?.details);
}

function nativeImageResult(value: unknown, filter: OmpPublicDataFilter): JsonValue | undefined {
  if (
    boundedJsonBytes(
      value,
      MAX_NATIVE_IMAGE_RESULT_BYTES,
      MAX_STREAM_CONTENT_BLOCKS,
      8 * 1024 * 1024,
      512,
    ) === Number.POSITIVE_INFINITY
  ) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value)) {
    return undefined;
  }
  if (!Array.isArray(value.content)) return undefined;
  let hasImage = false;
  const content: JsonValue[] = [];
  for (const part of value.content) {
    if (
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      "type" in part &&
      part.type === "image"
    ) {
      if (
        !("data" in part) ||
        typeof part.data !== "string" ||
        part.data.length === 0 ||
        part.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(part.data) ||
        !("mimeType" in part) ||
        typeof part.mimeType !== "string" ||
        !/^image\/(?:gif|jpeg|png|webp)$/u.test(part.mimeType)
      ) {
        return undefined;
      }
      hasImage = true;
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      continue;
    }
    content.push(filter.json(part, MAX_PUBLIC_TOOL_PAYLOAD_BYTES, MAX_PUBLIC_TOOL_PAYLOAD_BYTES));
  }
  if (!hasImage) return undefined;
  const details =
    "details" in value
      ? filter.json(value.details, MAX_PUBLIC_TOOL_PAYLOAD_BYTES, MAX_PUBLIC_TOOL_PAYLOAD_BYTES)
      : undefined;
  return { content, ...(details !== undefined ? { details } : {}) };
}

type CompactionSlot = { id: string; retrying: boolean };

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
  private readonly compactions: Record<"auto" | "manual", CompactionSlot[]> = {
    auto: [],
    manual: [],
  };
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
      event.type === "auto_compaction_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "advisor_yielded"
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
        if (event.message.role === "custom" || event.message.role === "bashExecution") {
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
          nativeName: event.toolName,
          name: this.dataFilter.text(event.toolName, 256),
          input,
          output: null,
          retainedBytes,
          unsafePartialOutput: previous?.unsafePartialOutput ?? false,
          specializedRendered: previous?.specializedRendered ?? false,
          silent: ["ask_user", "todo"].includes(event.toolName.toLowerCase()),
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
        const preservedImage = previous.nativeName.startsWith("browser_")
          ? nativeImageResult(event.result, this.dataFilter)
          : undefined;
        const output =
          preservedImage ??
          (previous.unsafePartialOutput
            ? "<redacted>"
            : this.dataFilter.json(
                event.result,
                MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
                MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
              ));
        const snapshot: ToolSnapshot = { ...previous, output };
        this.tools.delete(event.toolCallId);
        this.activeToolBytes -= previous.retainedBytes;
        const specializedRendered =
          previous.nativeName.toLowerCase() === "todo" && !event.isError
            ? this.publishTodoResult(snapshot)
            : snapshot.specializedRendered;
        if (snapshot.silent && (event.isError || !specializedRendered)) {
          this.publishTool(
            snapshot,
            "failed",
            event.isError
              ? snapshot.output
              : `${snapshot.name} completed without a supported native rendering`,
          );
        } else if (!snapshot.silent) {
          if (event.isError) this.publishTool(snapshot, "failed", snapshot.output);
          else this.publishTool(snapshot, "completed");
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
          id: todoPublicId(todo.id, index),
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
    if (event.type === "extension_ui_request" && event.method === "open_url") {
      this.noticeSequence += 1;
      const url = event.launchUrl ?? event.url;
      const message = [event.instructions, url].filter(Boolean).join("\n");
      this.publish({
        type: "notification",
        id: `omp:ui:${this.noticeSequence}`,
        level: "info",
        message: this.dataFilter.text(message, 64 * 1024),
      });
      return;
    }
    if (event.type === "advisor_yielded") {
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:advisor:${this.noticeSequence}`,
        level: "info",
        message: "Advisor review completed",
      });
      return;
    }
    if (event.type === "auto_compaction_start" || event.type === "compaction_start") {
      const trigger = event.type === "auto_compaction_start" ? "auto" : "manual";
      const active = this.compactions[trigger];
      const retrying = active[0];
      if (retrying?.retrying) {
        retrying.retrying = false;
        return;
      }
      const activeCount = this.compactions.auto.length + this.compactions.manual.length;
      if (activeCount >= MAX_ACTIVE_COMPACTIONS) {
        this.retireCompactions("OMP emitted too many overlapping compactions");
        return;
      }
      this.compactionSequence += 1;
      const slot = { id: `omp:compaction:${this.compactionSequence}`, retrying: false };
      active.push(slot);
      this.publish({ type: "compaction", id: slot.id, status: "loading", trigger });
      return;
    }
    if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
      const trigger = event.type === "auto_compaction_end" ? "auto" : "manual";
      const active = this.compactions[trigger];
      const slot = active[0];
      if (!slot) {
        this.compactionSequence += 1;
        this.publish({
          type: "error",
          id: `omp:compaction:${this.compactionSequence}`,
          message: "OMP compaction ended without a matching start",
        });
        return;
      }
      if (event.willRetry) {
        slot.retrying = true;
        return;
      }
      active.shift();
      const result = jsonRecord(this.dataFilter.json(event.result ?? null));
      const rawPreTokens = result?.preTokens ?? result?.tokensBefore;
      if (event.aborted || event.errorMessage) {
        this.publish({
          type: "error",
          id: slot.id,
          message: this.dataFilter.text(
            event.errorMessage ??
              (event.aborted ? "OMP compaction canceled" : "OMP compaction failed"),
            4_096,
          ),
        });
        return;
      }
      this.publish({
        type: "compaction",
        id: slot.id,
        status: "completed",
        trigger,
        ...(typeof rawPreTokens === "number" && Number.isFinite(rawPreTokens)
          ? { preTokens: Math.max(0, Math.trunc(rawPreTokens)) }
          : {}),
      });
    }
  }

  markAskPermissionRendered(): void {
    const snapshots = [...this.tools.values()];
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (snapshot?.nativeName.toLowerCase() !== "ask_user") continue;
      snapshot.specializedRendered = true;
      return;
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
      const publicText =
        block.kind === "image"
          ? { text: block.text, pending: false }
          : this.dataFilter.streamText(block.text, finalizeFallback);
      if (publicText.pending) stream.dirtyBlocks.add(contentIndex);
      if (!publicText.text || block.publishedText === publicText.text) continue;
      const previousPublishedBytes = utf8Bytes(block.publishedText ?? "");
      const nextPublishedBytes = utf8Bytes(publicText.text);
      if (
        stream.retainedBytes + stream.publishedBytes - previousPublishedBytes + nextPublishedBytes >
        MAX_STREAM_TOTAL_BYTES
      ) {
        continue;
      }
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
      stream.publishedBytes += nextPublishedBytes - previousPublishedBytes;
      block.publishedText = publicText.text;
      stream.published = true;
    }
  }

  finishTurn(turnId: string, preserveCompactions = false): void {
    if (!preserveCompactions) this.retireCompactions("OMP compaction ended with the turn");
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
    this.retireCompactions("OMP compaction ended when the session closed");
    this.closed = true;
    this.clearFlushTimer();
    this.stream = null;
    this.tools.clear();
    this.activeToolBytes = 0;
  }

  retireCompactions(message: string): void {
    for (const trigger of ["auto", "manual"] as const) {
      for (const slot of this.compactions[trigger].splice(0)) {
        this.publish({ type: "error", id: slot.id, message });
      }
    }
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
      retainedBytes: 0,
      publishedBytes: 0,
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
    let eventContent = typeof content === "string" ? content : undefined;
    if (
      content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      "type" in content &&
      content.type === "image" &&
      "data" in content &&
      typeof content.data === "string" &&
      "mimeType" in content &&
      typeof content.mimeType === "string"
    ) {
      eventContent = `![OMP image](data:${content.mimeType};base64,${content.data})`;
    }
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
    if (snapshot.kind === "image" && utf8Bytes(snapshot.text) > MAX_IMAGE_MARKDOWN_LENGTH) return;
    const previous = stream.blocks.get(contentIndex);
    let retainedBytes = utf8Bytes(snapshot.text);
    let textBytes = snapshot.kind === "image" ? 0 : retainedBytes;
    for (const [index, block] of stream.blocks) {
      if (index === contentIndex) continue;
      const blockBytes = utf8Bytes(block.text);
      retainedBytes += blockBytes;
      if (block.kind !== "image") textBytes += blockBytes;
      if (
        retainedBytes + stream.publishedBytes > MAX_STREAM_TOTAL_BYTES ||
        textBytes > MAX_STREAM_TEXT_LENGTH
      ) {
        return;
      }
    }
    if (
      retainedBytes + stream.publishedBytes > MAX_STREAM_TOTAL_BYTES ||
      textBytes > MAX_STREAM_TEXT_LENGTH
    ) {
      return;
    }
    if (previous?.kind === snapshot.kind && previous.text === snapshot.text) return;
    stream.retainedBytes = retainedBytes;
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
    const rawType = message.customType ?? message.role;
    const publicType = this.dataFilter.text(rawType, 256);
    const lowerType = rawType.toLowerCase();
    const details = jsonRecord(this.dataFilter.json(message.details ?? null));
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
    const nativeIdentity = message.id ?? message.entryId ?? message.responseId;
    if (!nativeIdentity) this.customSequence += 1;
    const id = nativeIdentity
      ? `omp:custom:${createHash("sha256").update(nativeIdentity).digest("base64url").slice(0, 12)}`
      : `omp:custom:${this.customSequence}`;
    if (message.role === "bashExecution" || /bash|shell|python/u.test(lowerType)) {
      const command = this.dataFilter.text(
        message.command ?? firstString(details, "command", "input") ?? publicType,
      );
      const output = message.output ?? content;
      this.publish({
        type: "tool_call",
        id,
        callId: id,
        name: publicType,
        detail: {
          type: "shell",
          command,
          ...(firstString(details, "cwd") ? { cwd: firstString(details, "cwd") } : {}),
          ...(output ? { output: this.dataFilter.text(output) } : {}),
          ...(typeof message.exitCode === "number" || message.exitCode === null
            ? { exitCode: message.exitCode }
            : typeof details?.exitCode === "number"
              ? { exitCode: details.exitCode }
              : {}),
        },
        status: "completed",
        error: null,
      });
      return;
    }
    const advisor = lowerType.includes("advisor") || lowerType === "aside";
    const sharedSeverity = firstString(details, "severity");
    const sharedAttribution = firstString(details, "attribution", "advisor", "name", "source");
    const noteLines = Array.isArray(details?.notes)
      ? details.notes.flatMap((note) => {
          const record = jsonRecord(note);
          const noteText =
            typeof note === "string"
              ? note
              : (firstString(record, "text", "content", "message") ?? "");
          const severity = firstString(record, "severity") ?? sharedSeverity;
          const attribution =
            firstString(record, "attribution", "advisor", "name", "source") ?? sharedAttribution;
          const prefix = [severity ? `[${severity}]` : undefined, attribution]
            .filter(Boolean)
            .join(" ");
          const line = [prefix, noteText].filter(Boolean).join(": ");
          return line ? [line] : [];
        })
      : typeof details?.notes === "string"
        ? [
            [
              [sharedSeverity ? `[${sharedSeverity}]` : undefined, sharedAttribution]
                .filter(Boolean)
                .join(" "),
              details.notes,
            ]
              .filter(Boolean)
              .join(": "),
          ]
        : [];
    const advisorMetadata = [sharedSeverity ? `[${sharedSeverity}]` : undefined, sharedAttribution]
      .filter(Boolean)
      .join(" ");
    const text = [content, ...noteLines].filter(Boolean).join("\n\n") || advisorMetadata;
    if (!text && !advisor) return;
    this.publish({
      type: "tool_call",
      id,
      callId: id,
      name: publicType,
      detail: {
        type: "plain_text",
        label: advisor ? "Advisor" : publicType,
        text: this.dataFilter.text(text || "Advisor update"),
        icon: advisor ? "brain" : "sparkles",
      },
      status: "completed",
      error: null,
    });
  }

  private publishTodoResult(snapshot: ToolSnapshot): boolean {
    const phases = resultDetails(snapshot.output)?.phases;
    if (!Array.isArray(phases)) return false;
    const items: Array<{
      id: string;
      text: string;
      completed: boolean;
      status: "pending" | "in_progress" | "completed";
      activeForm?: string;
    }> = [];
    for (const phase of phases) {
      const phaseRecord = jsonRecord(phase);
      const tasks = phaseRecord?.tasks;
      if (!Array.isArray(tasks)) continue;
      const phaseName = firstString(phaseRecord, "name", "phase");
      for (const task of tasks) {
        if (items.length >= MAX_TODOS) break;
        const taskRecord = jsonRecord(task);
        const text = firstString(taskRecord, "content", "text");
        if (!text) continue;
        const status = firstString(taskRecord, "status");
        const completed = status === "completed" || status === "abandoned";
        items.push({
          id: todoPublicId(firstString(taskRecord, "id"), items.length),
          text: this.dataFilter.text(text, 16_384),
          completed,
          status: completed ? "completed" : status === "in_progress" ? "in_progress" : "pending",
          ...(phaseName ? { activeForm: this.dataFilter.text(phaseName, 256) } : {}),
        });
      }
    }
    this.publish({ type: "todo", id: "omp:todos", items });
    return true;
  }

  private toolDetail(snapshot: ToolSnapshot): ProviderToolCallDetail {
    const input = jsonRecord(snapshot.input);
    const output = jsonRecord(snapshot.output);
    const details = resultDetails(snapshot.output);
    const resultText = displayText(snapshot.output);
    const name = snapshot.nativeName.toLowerCase();
    if (["bash", "shell", "exec", "run_command"].includes(name)) {
      const exitCode = details?.exitCode ?? output?.exitCode;
      return {
        type: "shell",
        command: firstString(input, "command", "cmd") ?? snapshot.name,
        ...(firstString(input, "cwd") ? { cwd: firstString(input, "cwd") } : {}),
        ...(resultText !== undefined ? { output: resultText } : {}),
        ...(typeof exitCode === "number" || exitCode === null ? { exitCode } : {}),
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
      const unifiedDiff =
        firstString(details, "unifiedDiff", "diff", "patch") ??
        firstString(output, "unifiedDiff", "diff", "patch");
      return {
        type: "edit",
        filePath,
        ...(firstString(input, "oldString", "old_text")
          ? { oldString: firstString(input, "oldString", "old_text") }
          : {}),
        ...(firstString(input, "newString", "new_text")
          ? { newString: firstString(input, "newString", "new_text") }
          : {}),
        ...(unifiedDiff ? { unifiedDiff } : {}),
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
