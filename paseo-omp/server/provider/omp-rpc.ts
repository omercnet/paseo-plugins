import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ompDataDir } from "../paths";
import { isValidImagePayload } from "./image";
import {
  buildOmpSpawnRequest,
  type OmpSpawnRequest,
  type OmpStartOptions,
} from "./omp-rpc-environment";
import {
  isConfirmedNoProcessSpawnFailure,
  PROCESS_STOP_TIMEOUT_MS,
  type ProcessTreeCleanup,
  stopWindowsTree,
  terminatePosixProcessTree,
  waitMs,
} from "./omp-rpc-process";
import {
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  OmpThinkingLevelSchema,
  validateBoundedText,
} from "./omp-rpc-values";
import {
  boundedJsonBytes,
  boundedJsonMetrics,
  OmpCleanupFailure,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import {
  listOmpSessionDescriptors,
  type OmpSessionDescriptor,
  type OmpSessionListOptions,
  readOmpPersistedSessionTranscript,
  readOmpPersistedSubagentTranscript,
} from "./session-descriptors";

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CHUNK_STALE_MS = 30_000;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;
const MAX_CONFIG_EVENT_TEXT_BYTES = 64 * 1024;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const MAX_TOOL_PAYLOAD_LENGTH = 256 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_HOST_TOOLS = 256;
const MAX_TOOL_APPROVAL_FRAME_BYTES = 64 * 1024;
const MAX_TOOL_APPROVAL_STRING_BYTES = 8 * 1024;
const MAX_TOOL_APPROVAL_COLLECTION_ITEMS = 32;
const MAX_TOOL_APPROVAL_INPUT_NODES = 256;
const MAX_TOOL_APPROVAL_DEPTH = 4;
const MAX_TOOL_APPROVAL_ID_BYTES = 512;
const MAX_TOOL_APPROVAL_NAME_BYTES = 256;
const MAX_TOOL_APPROVAL_DETAIL_LINES = 16;
const MAX_TOOL_APPROVAL_DETAIL_BYTES = 2 * 1024;
const MAX_TOOL_APPROVAL_METADATA_FIELDS = 33;
const MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES = 64;
const MAX_TOOL_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_APPROVAL_PATH_BYTES = 4 * 1024;
const MAX_TOOL_APPROVAL_CONTENT_BYTES = 20 * 1024;
type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_ONE_WAY_WRITES = 256;
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_PARTS = 4_096;
const MAX_ARRAY_ITEMS = 512;
// OMP read metadata can contain one source entry per displayed line. Bound this optional,
// opaque field separately so over-budget metadata can be omitted without losing completion events.
const MAX_OPTIONAL_METADATA_BYTES = MAX_TOOL_PAYLOAD_LENGTH;
const MAX_OPTIONAL_METADATA_ITEMS = 2_048;
const MAX_OPTIONAL_METADATA_NODES = 4_096;
const MAX_TASK_CORRELATION_BYTES = 256 * 1024;
const MAX_TASK_CORRELATION_ITEMS = 1_024;
const MAX_TASK_CORRELATION_NODES = 4_096;
const MAX_MODEL_CATALOG_ITEMS = 4_096;
// Tool-intensive OMP turns legitimately exceed 64 blocks; transport byte/node budgets remain the
// primary resource bounds.
export const OMP_MAX_CONTENT_PARTS = 4_096;
const MAX_TODOS = 256;
const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_COST_USD = 1_000_000_000;
const MAX_RPC_ERROR_BYTES = 4_096;
const MAX_RPC_ERROR_CODE_BYTES = 256;
const PROMPT_SCHEDULING_FAILURE = "OMP prompt scheduling failed";
const PROTOCOL_VIOLATION_COALESCE_MS = 10_000;
const MAX_REPLAY_MESSAGES = 100_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_NODES = 400_000;
const OMP_MESSAGE_PAGE_LIMIT = 256;
const MAX_MESSAGE_PAGES = 512;
const MAX_MESSAGE_PAGE_BUSY_RETRIES = 4;
const MAX_MESSAGE_PAGE_STALE_RESTARTS = 2;
const MESSAGE_PAGE_RETRY_BASE_MS = 50;

export const OMP_MESSAGE_REPLAY_POLICIES = {
  assistant: "render",
  user: "render",
  developer: "ignore",
  toolResult: "render",
  bashExecution: "normalize",
  pythonExecution: "normalize",
  custom: "normalize",
  hookMessage: "normalize",
  branchSummary: "ignore",
  compactionSummary: "ignore",
  fileMention: "ignore",
} as const;

export const OMP_SESSION_EVENT_POLICIES = {
  agent_start: "lifecycle",
  agent_end: "lifecycle",
  turn_start: "lifecycle",
  turn_end: "lifecycle",
  message_start: "normalize",
  message_update: "normalize",
  message_end: "normalize",
  tool_execution_start: "normalize",
  tool_execution_update: "normalize",
  tool_stream_update: "normalize",
  tool_execution_end: "normalize",
  auto_compaction_start: "normalize",
  auto_compaction_end: "normalize",
  auto_retry_start: "normalize",
  auto_retry_end: "normalize",
  retry_fallback_applied: "normalize",
  retry_fallback_succeeded: "normalize",
  model_changed: "normalize",
  config_warnings_changed: "ignore",
  advisor_cost_changed: "ignore",
  advisor_yielded: "normalize",
  ttsr_triggered: "ignore",
  todo_reminder: "normalize",
  todo_auto_clear: "normalize",
  irc_message: "normalize",
  notice: "normalize",
  thinking_level_changed: "normalize",
  goal_updated: "normalize",
} as const;

export const OMP_RPC_COMMAND_POLICIES = {
  negotiate_protocol: "implemented",
  prompt: "implemented",
  steer: "implemented",
  follow_up: "implemented",
  abort: "implemented",
  abort_and_prompt: "unsupported",
  new_session: "unsupported",
  get_state: "implemented",
  set_fast_mode: "unsupported",
  get_available_commands: "implemented",
  set_todos: "unsupported",
  set_host_tools: "implemented",
  set_host_uri_schemes: "unsupported",
  set_subagent_subscription: "implemented",
  get_subagents: "implemented",
  get_subagent_messages: "implemented",
  set_model: "implemented",
  cycle_model: "unsupported",
  get_available_models: "implemented",
  set_thinking_level: "implemented",
  cycle_thinking_level: "unsupported",
  set_steering_mode: "unsupported",
  set_follow_up_mode: "unsupported",
  set_interrupt_mode: "unsupported",
  compact: "implemented",
  set_auto_compaction: "implemented",
  set_auto_retry: "unsupported",
  abort_retry: "unsupported",
  bash: "unsupported",
  abort_bash: "unsupported",
  get_session_stats: "implemented",
  export_html: "unsupported",
  switch_session: "unsupported",
  branch: "implemented",
  get_branch_messages: "implemented",
  get_last_assistant_text: "unsupported",
  set_session_name: "unsupported",
  handoff: "implemented",
  get_messages: "implemented",
  get_messages_page: "implemented",
  get_login_providers: "unsupported",
  login: "unsupported",
} as const;
export const OMP_RPC_RESPONSE_POLICIES = OMP_RPC_COMMAND_POLICIES;
export const OMP_PROTOCOL_VIOLATION_CATEGORIES = [
  "duplicate-ready",
  "frame-limit",
  "incomplete-frame",
  "interleaved-chunk",
  "invalid-chunk",
  "invalid-envelope",
  "invalid-event",
  "invalid-event-state",
  "invalid-json",
  "invalid-ready",
  "invalid-response",
  "remote-frame-error",
] as const;
export type OmpProtocolViolationCategory = (typeof OMP_PROTOCOL_VIOLATION_CATEGORIES)[number];
export const OMP_PROTOCOL_VIOLATION_REASONS = [
  "output-ended-mid-frame",
  "physical-frame-limit",
  "semantic-frame-limit",
  "json-decode",
  "chunk-json-decode",
  "object-envelope",
  "missing-frame-type",
  "response-schema",
  "chunk-schema",
  "chunk-metadata",
  "chunk-size",
  "chunk-start-index",
  "chunk-sequence",
  "chunk-byte-count",
  "chunk-timeout",
  "frame-interleaved-with-chunk",
  "remote-frame-error",
  "ready-already-received",
  "ready-schema",
  "notice-level-type",
  "notice-message-type",
  "notice-schema",
  "event-schema",
  "message-event-schema",
  "tool-event-schema",
  "lifecycle-event-schema",
  "subagent-event-schema",
  "configuration-event-schema",
  "extension-ui-schema",
  "unknown-event-type",
  "event-state-transition",
] as const;
export type OmpProtocolViolationReason = (typeof OMP_PROTOCOL_VIOLATION_REASONS)[number];
export const OMP_PROTOCOL_DIAGNOSTIC_PHASES = [
  "startup",
  "negotiation",
  "idle",
  "active-turn",
  "closing",
] as const;
export type OmpProtocolDiagnosticPhase = (typeof OMP_PROTOCOL_DIAGNOSTIC_PHASES)[number];

export const OMP_PROTOCOL_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_stream_update",
  "compaction_start",
  "compaction_end",
  "subagent_lifecycle",
  "subagent_progress",
  "subagent_event",
  "todo_reminder",
  "model_changed",
  "config_warnings_changed",
  "advisor_cost_changed",
  "ttsr_triggered",
  "irc_message",
  "thinking_level_changed",
  "goal_updated",
  "auto_retry_start",
  "auto_retry_end",
  "retry_fallback_applied",
  "retry_fallback_succeeded",
  "todo_auto_clear",
  "auto_compaction_start",
  "auto_compaction_end",
  "available_commands_update",
  "notice",
  "command_output",
  "extension_ui_request",
  "prompt_result",
  "host_tool_call",
  "host_tool_cancel",
  "tool_approval_request",
  "tool_approval_cancel",
  "advisor_yielded",
] as const;
export type OmpProtocolEventType = (typeof OMP_PROTOCOL_EVENT_TYPES)[number];

export const OMP_PROTOCOL_DIAGNOSTIC_FIELDS = [
  "frame",
  "frame.byteLength",
  "frame.type",
  "response",
  "ready",
  "event",
  "event.sequence",
  "notice.level",
  "notice.message",
  "chunk",
  "chunk.data",
  "chunk.index",
  "chunk.sequence",
  "chunk.byteLength",
] as const;
export type OmpProtocolDiagnosticField = (typeof OMP_PROTOCOL_DIAGNOSTIC_FIELDS)[number];

export const OMP_PROTOCOL_DIAGNOSTIC_EXPECTATIONS = [
  "complete-json-line",
  "within-byte-limit",
  "valid-json",
  "object-envelope",
  "bounded-frame-type",
  "valid-response-frame",
  "valid-ready-frame",
  "single-ready-frame",
  "valid-event-frame",
  "valid-event-state-transition",
  "valid-message-event",
  "valid-tool-event",
  "valid-lifecycle-event",
  "valid-subagent-event",
  "valid-configuration-event",
  "valid-extension-ui-event",
  "known-event-type",
  "notice-level-enum",
  "notice-message-string",
  "valid-chunk-frame",
  "valid-base64-chunk",
  "first-chunk-index-zero",
  "contiguous-chunk-sequence",
  "declared-chunk-byte-count",
  "chunk-before-deadline",
  "no-interleaved-frame",
  "no-remote-frame-error",
] as const;
export type OmpProtocolDiagnosticExpectation =
  (typeof OMP_PROTOCOL_DIAGNOSTIC_EXPECTATIONS)[number];

export const OMP_PROTOCOL_DIAGNOSTIC_ACTUAL_TYPES = [
  "missing",
  "null",
  "array",
  "object",
  "string",
  "number",
  "boolean",
  "invalid-json",
  "partial-frame",
  "oversized",
  "duplicate",
  "interleaved",
  "out-of-order",
  "timeout",
  "remote-error",
  "mismatched",
] as const;
export type OmpProtocolDiagnosticActualType = (typeof OMP_PROTOCOL_DIAGNOSTIC_ACTUAL_TYPES)[number];

export interface OmpProtocolViolationDiagnostic {
  category: OmpProtocolViolationCategory;
  reason: OmpProtocolViolationReason;
  phase: OmpProtocolDiagnosticPhase;
  occurrenceCount: number;
  eventType?: OmpProtocolEventType;
  frameType?: "ready" | "response" | "rpc_chunk" | "rpc_frame_error" | "notice";
  field?: OmpProtocolDiagnosticField;
  expected?: OmpProtocolDiagnosticExpectation;
  actualType?: OmpProtocolDiagnosticActualType;
  maxByteSize?: number;
  limitBytes?: number;
}

function protocolDiagnosticActualType(value: unknown): OmpProtocolDiagnosticActualType {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function isProtocolEventType(value: string): value is OmpProtocolEventType {
  return (OMP_PROTOCOL_EVENT_TYPES as readonly string[]).includes(value);
}

function eventSchemaClassification(
  eventType: OmpProtocolEventType,
): Pick<OmpProtocolViolationDiagnostic, "reason" | "expected"> {
  switch (eventType) {
    case "message_start":
    case "message_update":
    case "message_end":
      return { reason: "message-event-schema", expected: "valid-message-event" };
    case "irc_message":
      return { reason: "message-event-schema", expected: "valid-message-event" };
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_stream_update":
    case "tool_execution_end":
    case "host_tool_call":
    case "host_tool_cancel":
    case "tool_approval_request":
    case "tool_approval_cancel":
      return { reason: "tool-event-schema", expected: "valid-tool-event" };
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event":
      return { reason: "subagent-event-schema", expected: "valid-subagent-event" };
    case "model_changed":
    case "thinking_level_changed":
    case "goal_updated":
    case "todo_reminder":
    case "todo_auto_clear":
    case "available_commands_update":
    case "retry_fallback_applied":
    case "retry_fallback_succeeded":
    case "config_warnings_changed":
    case "advisor_cost_changed":
    case "ttsr_triggered":
      return { reason: "configuration-event-schema", expected: "valid-configuration-event" };
    case "extension_ui_request":
      return { reason: "extension-ui-schema", expected: "valid-extension-ui-event" };
    default:
      return { reason: "lifecycle-event-schema", expected: "valid-lifecycle-event" };
  }
}

function invalidEventDiagnosticMetadata(
  frame: Record<string, unknown>,
  type: string,
): Pick<
  OmpProtocolViolationDiagnostic,
  "reason" | "eventType" | "frameType" | "field" | "expected" | "actualType"
> {
  if (!isProtocolEventType(type)) {
    return {
      reason: "unknown-event-type",
      field: "frame.type",
      expected: "known-event-type",
      actualType: "string",
    };
  }
  if (type !== "notice") {
    return {
      ...eventSchemaClassification(type),
      eventType: type,
      field: "event",
      actualType: "object",
    };
  }
  if (typeof frame.level !== "string") {
    return {
      reason: "notice-level-type",
      eventType: "notice",
      frameType: "notice",
      field: "notice.level",
      expected: "notice-level-enum",
      actualType: protocolDiagnosticActualType(frame.level),
    };
  }
  if (typeof frame.message !== "string") {
    return {
      reason: "notice-message-type",
      eventType: "notice",
      frameType: "notice",
      field: "notice.message",
      expected: "notice-message-string",
      actualType: protocolDiagnosticActualType(frame.message),
    };
  }
  return {
    reason: "notice-schema",
    eventType: "notice",
    frameType: "notice",
    field: "event",
    expected: "valid-event-frame",
    actualType: "object",
  };
}

type PendingProtocolViolation = Omit<OmpProtocolViolationDiagnostic, "occurrenceCount"> & {
  occurrenceCount: number;
};
type ProtocolViolationKey = `${OmpProtocolViolationCategory}:${OmpProtocolViolationReason}`;
const MAX_CONTEXT_PERCENT = 1_000_000;
function boundedJsonString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
    return bytes >= minBytes && bytes <= maxBytes;
  });
}
function isBoundedToolApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

export const OMP_HOST_TOOL_FRAME_LIMIT_ERROR =
  "MCP host tool result exceeds the OMP RPC frame limit";
const MIN_HOST_TOOL_RESULT_FRAME_BYTES = Buffer.byteLength(
  `${JSON.stringify({
    type: "host_tool_result",
    id: "\0".repeat(MAX_ID_LENGTH),
    result: {
      content: [{ type: "text", text: OMP_HOST_TOOL_FRAME_LIMIT_ERROR }],
      details: {},
      isError: true,
    },
    isError: true,
  })}\n`,
);
function boundedString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = utf8Bytes(value);
    return bytes >= minBytes && bytes <= maxBytes;
  });
}
function isSafeOpaqueCursor(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
function boundedOptionalStringArray(maxItems: number, maxBytes: number) {
  return z.unknown().transform((value): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter(
        (item): item is string =>
          typeof item === "string" && item.length > 0 && utf8Bytes(item) <= maxBytes,
      )
      .slice(0, maxItems);
  });
}

const IDENTIFIER = boundedString(MAX_ID_LENGTH, 1);
const NAME = boundedString(MAX_NAME_LENGTH, 1);
const OMP_PROVIDER_NAME = NAME.refine((provider) => !provider.includes("/"));
const TEXT = boundedString(MAX_TEXT_LENGTH);
const RAW_DISPLAY_TEXT = boundedString(MAX_IMAGE_DATA_LENGTH);
const DISPLAY_TRUNCATION_MARKER = "<truncated>";

function boundRawDisplayContent(value: unknown): unknown {
  if (typeof value === "string") {
    return utf8Bytes(value) <= MAX_IMAGE_DATA_LENGTH ? value : DISPLAY_TRUNCATION_MARKER;
  }
  if (!Array.isArray(value)) return value;
  let totalBytes = 0;
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") totalBytes += utf8Bytes(record.text);
    if (typeof record.thinking === "string") totalBytes += utf8Bytes(record.thinking);
  }
  if (totalBytes <= MAX_IMAGE_DATA_LENGTH) return value;

  let retainedMarker = false;
  return value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const copy = { ...(part as Record<string, unknown>) };
    for (const key of ["text", "thinking"] as const) {
      if (typeof copy[key] !== "string") continue;
      if (retainedMarker) delete copy[key];
      else {
        copy[key] = DISPLAY_TRUNCATION_MARKER;
        retainedMarker = true;
      }
    }
    return copy;
  });
}

function sanitizeLiveMessageDisplay(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as Record<string, unknown>;
  if (message.role === "assistant") {
    const content = boundRawDisplayContent(message.content);
    return content === message.content ? value : { ...message, content };
  }
  if (
    (message.role === "bashExecution" || message.role === "pythonExecution") &&
    typeof message.output === "string" &&
    utf8Bytes(message.output) > MAX_IMAGE_DATA_LENGTH
  ) {
    return { ...message, output: DISPLAY_TRUNCATION_MARKER };
  }
  return value;
}

function sanitizeLiveDisplayFrame(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const frame = value as Record<string, unknown>;
  if (
    frame.type === "message_start" ||
    frame.type === "message_update" ||
    frame.type === "message_end"
  ) {
    const message = sanitizeLiveMessageDisplay(frame.message);
    return message === frame.message ? value : { ...frame, message };
  }
  if (frame.type !== "agent_end" || !Array.isArray(frame.messages)) return value;
  let changed = false;
  const messages = frame.messages.map((message) => {
    const sanitized = sanitizeLiveMessageDisplay(message);
    if (sanitized !== message) changed = true;
    return sanitized;
  });
  return changed ? { ...frame, messages } : value;
}
const OmpCurrentThinkingLevelSchema = boundedString(32).optional().catch(undefined);

function isBoundedJson(
  value: unknown,
  maxBytes = MAX_TOOL_PAYLOAD_LENGTH,
  maxItems = MAX_ARRAY_ITEMS,
  maxNodes = 2_048,
): boolean {
  return (
    boundedJsonBytes(value, maxBytes, maxItems, maxBytes, maxNodes) !== Number.POSITIVE_INFINITY
  );
}
const MAX_RESPONSE_DEPTH = 16;
export const OMP_RPC_BOUND_DIMENSIONS = [
  "bytes",
  "items",
  "nodes",
  "depth",
  "string-bytes",
] as const;
export type OmpRpcBoundDimension = (typeof OMP_RPC_BOUND_DIMENSIONS)[number];
export const OMP_RPC_DIAGNOSTIC_COMMANDS = [
  "negotiate_protocol",
  "get_state",
  "get_session_stats",
  "get_available_models",
  "get_available_commands",
  "set_subagent_subscription",
  "get_subagents",
  "get_subagent_messages",
  "prompt",
  "compact",
  "set_auto_compaction",
  "set_model",
  "set_thinking_level",
  "handoff",
  "get_branch_messages",
  "branch",
  "get_messages_page",
  "get_messages",
  "abort",
  "set_host_tools",
] as const;
export type OmpRpcDiagnosticCommand = (typeof OMP_RPC_DIAGNOSTIC_COMMANDS)[number];
type JsonBoundViolation = {
  dimension: OmpRpcBoundDimension;
  actual: number;
  limit: number;
};
type JsonBoundInspection = { bytes: number; nodes: number; violation?: JsonBoundViolation };

function rpcDiagnosticCommand(value: string): OmpRpcDiagnosticCommand | undefined {
  return (OMP_RPC_DIAGNOSTIC_COMMANDS as readonly string[]).includes(value)
    ? (value as OmpRpcDiagnosticCommand)
    : undefined;
}

function encodedJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
  }
  return bytes;
}

function inspectJsonBounds(
  value: unknown,
  maxBytes: number,
  maxItems: number,
  maxStringBytes: number,
  maxNodes: number,
): JsonBoundInspection {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  const addBytes = (count: number): JsonBoundViolation | undefined => {
    bytes += count;
    return bytes > maxBytes ? { dimension: "bytes", actual: bytes, limit: maxBytes } : undefined;
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes)
      return { bytes, nodes, violation: { dimension: "nodes", actual: nodes, limit: maxNodes } };
    if (current.depth > MAX_RESPONSE_DEPTH) {
      return {
        bytes,
        nodes,
        violation: { dimension: "depth", actual: current.depth, limit: MAX_RESPONSE_DEPTH },
      };
    }
    const item = current.value;
    if (item === null) {
      const violation = addBytes(4);
      if (violation) return { bytes, nodes, violation };
      continue;
    }
    if (typeof item === "boolean") {
      const violation = addBytes(item ? 4 : 5);
      if (violation) return { bytes, nodes, violation };
      continue;
    }
    if (typeof item === "number") {
      const violation = addBytes((JSON.stringify(item) ?? "null").length);
      if (violation) return { bytes, nodes, violation };
      continue;
    }
    if (typeof item === "string") {
      const itemBytes = utf8Bytes(item);
      if (itemBytes > maxStringBytes) {
        return {
          bytes,
          nodes,
          violation: { dimension: "string-bytes", actual: itemBytes, limit: maxStringBytes },
        };
      }
      const violation = addBytes(encodedJsonStringBytes(item));
      if (violation) return { bytes, nodes, violation };
      continue;
    }
    if (typeof item !== "object") continue;
    if (Array.isArray(item)) {
      if (item.length > maxItems) {
        return {
          bytes,
          nodes,
          violation: { dimension: "items", actual: item.length, limit: maxItems },
        };
      }
      const violation = addBytes(2 + Math.max(0, item.length - 1));
      if (violation) return { bytes, nodes, violation };
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(item).filter(([, child]) => child !== undefined);
    if (entries.length > maxItems) {
      return {
        bytes,
        nodes,
        violation: { dimension: "items", actual: entries.length, limit: maxItems },
      };
    }
    let violation = addBytes(2 + Math.max(0, entries.length - 1) + entries.length);
    if (violation) return { bytes, nodes, violation };
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index] as [string, unknown];
      violation = addBytes(encodedJsonStringBytes(key));
      if (violation) return { bytes, nodes, violation };
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return { bytes, nodes };
}

function jsonBoundViolation(
  value: unknown,
  maxBytes: number,
  maxItems: number,
  maxStringBytes: number,
  maxNodes: number,
): JsonBoundViolation | undefined {
  return inspectJsonBounds(value, maxBytes, maxItems, maxStringBytes, maxNodes).violation;
}
function optionalMetadataMetrics(value: unknown) {
  return boundedJsonMetrics(
    value,
    MAX_OPTIONAL_METADATA_BYTES,
    MAX_OPTIONAL_METADATA_ITEMS,
    MAX_OPTIONAL_METADATA_BYTES,
    MAX_OPTIONAL_METADATA_NODES,
  );
}

function optionalMetadataIsBounded(value: unknown): boolean {
  return optionalMetadataMetrics(value) !== undefined;
}

function omitUnsafeOptionalDetails(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "details") || optionalMetadataIsBounded(record.details)) return value;
  const { details: _details, ...safe } = record;
  return safe;
}

const TASK_RESULT_STATUSES: Readonly<Record<string, true>> = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  error: true,
  aborted: true,
  canceled: true,
  cancelled: true,
};
const TASK_PROGRESS_STATUSES: Readonly<Record<string, true>> = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  aborted: true,
};

function boundedTaskId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= MAX_ID_LENGTH;
}

function taskCorrelationDetails(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const details = value as Record<string, unknown>;
  if (!Array.isArray(details.results) || details.results.length > MAX_TASK_CORRELATION_ITEMS)
    return;
  const results: Record<string, unknown>[] = [];
  for (const value of details.results) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const result = value as Record<string, unknown>;
    if (!boundedTaskId(result.id)) return;
    const safe: Record<string, unknown> = { id: result.id };
    if (typeof result.status === "string" && Object.hasOwn(TASK_RESULT_STATUSES, result.status)) {
      safe.status = result.status;
    }
    if (typeof result.aborted === "boolean") safe.aborted = result.aborted;
    if (typeof result.exitCode === "number" && Number.isFinite(result.exitCode)) {
      safe.exitCode = result.exitCode;
    }
    if (
      result.error !== undefined &&
      boundedJsonMetrics(result.error, 4_096, 32, 4_096, 64) !== undefined
    ) {
      safe.error = result.error;
    }
    results.push(safe);
  }
  let progress: Record<string, unknown>[] | undefined;
  if (details.progress !== undefined) {
    if (!Array.isArray(details.progress) || details.progress.length > MAX_TASK_CORRELATION_ITEMS) {
      return;
    }
    progress = [];
    for (const value of details.progress) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      if (
        !boundedTaskId(item.id) ||
        typeof item.index !== "number" ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= MAX_TASK_CORRELATION_ITEMS ||
        typeof item.status !== "string" ||
        !Object.hasOwn(TASK_PROGRESS_STATUSES, item.status)
      ) {
        return;
      }
      progress.push({ id: item.id, index: item.index, status: item.status });
    }
  }
  const correlation = { results, ...(progress ? { progress } : {}) };
  return boundedJsonMetrics(
    correlation,
    MAX_TASK_CORRELATION_BYTES,
    MAX_TASK_CORRELATION_ITEMS,
    MAX_TASK_CORRELATION_BYTES,
    MAX_TASK_CORRELATION_NODES,
  )
    ? correlation
    : undefined;
}

function omitOptionalDetails(value: unknown, preserveTaskCorrelation = false): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "details")) return value;
  const { details: _details, ...structural } = record;
  if (!preserveTaskCorrelation) return structural;
  const correlation = taskCorrelationDetails(record.details);
  return correlation === undefined ? structural : { ...structural, details: correlation };
}

function createOptionalMetadataSanitizer(): (value: unknown, taskResult?: boolean) => unknown {
  let retainedBytes = 0;
  let retainedNodes = 0;
  return (value, taskResult = false) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, "details")) return value;
    const metrics = optionalMetadataMetrics(record.details);
    if (
      metrics &&
      retainedBytes + metrics.bytes <= MAX_OPTIONAL_METADATA_BYTES &&
      retainedNodes + metrics.nodes <= MAX_OPTIONAL_METADATA_NODES
    ) {
      retainedBytes += metrics.bytes;
      retainedNodes += metrics.nodes;
      return value;
    }
    const correlation = taskResult ? taskCorrelationDetails(record.details) : undefined;
    const { details: _details, ...safe } = record;
    return correlation === undefined ? safe : { ...safe, details: correlation };
  };
}

const OmpOptionalMetadataSchema = z.preprocess(
  (value) => (optionalMetadataIsBounded(value) ? value : undefined),
  z.unknown().optional(),
);

const OmpContentPartSchema = z
  .object({
    type: NAME,
    text: TEXT.optional(),
    thinking: TEXT.optional(),
    data: boundedString(MAX_IMAGE_DATA_LENGTH).optional(),
    mimeType: boundedString(128).optional(),
    id: IDENTIFIER.optional(),
    name: NAME.optional(),
    arguments: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_TOOL_PAYLOAD_LENGTH, 1_024, 4_096))
      .optional(),
  })
  .superRefine((part, context) => {
    if (part.type === "toolCall" && (!part.id || !part.name || part.arguments === undefined)) {
      context.addIssue({ code: "custom", message: "invalid tool call payload" });
      return;
    }
    if (part.type !== "image") return;
    if (
      part.data === undefined ||
      part.mimeType === undefined ||
      !isValidImagePayload(part.data, part.mimeType, MAX_IMAGE_DATA_LENGTH)
    ) {
      context.addIssue({ code: "custom", message: "invalid image payload" });
    }
  });
const OmpAssistantContentPartSchema = OmpContentPartSchema.safeExtend({
  text: RAW_DISPLAY_TEXT.optional(),
  thinking: RAW_DISPLAY_TEXT.optional(),
});
const OmpAssistantDisplayContentSchema = z.preprocess(
  boundRawDisplayContent,
  z.union([RAW_DISPLAY_TEXT, z.array(OmpAssistantContentPartSchema).max(OMP_MAX_CONTENT_PARTS)]),
);
const OmpDisplayContentSchema = z.union([
  TEXT,
  z.array(OmpContentPartSchema).max(OMP_MAX_CONTENT_PARTS),
]);
const OmpImageArraySchema = z
  .array(OmpContentPartSchema)
  .max(OMP_MAX_CONTENT_PARTS)
  .superRefine((parts, context) => {
    if (parts.some((part) => part.type !== "image")) {
      context.addIssue({ code: "custom", message: "invalid image collection" });
    }
  });
const OmpMessageIdentityShape = {
  id: IDENTIFIER.optional(),
  entryId: IDENTIFIER.optional(),
  responseId: IDENTIFIER.optional(),
  images: OmpImageArraySchema.optional(),
  timestamp: z.number().finite().optional(),
  details: OmpOptionalMetadataSchema,
};
const OmpOpaqueMessagePayloadSchema = z
  .unknown()
  .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 8_192));
const OmpExecutionOutputSchema = z.preprocess(
  (value) =>
    typeof value === "string" && utf8Bytes(value) > MAX_IMAGE_DATA_LENGTH
      ? DISPLAY_TRUNCATION_MARKER
      : value,
  RAW_DISPLAY_TEXT.optional(),
);
const OmpExecutionMessageShape = {
  output: OmpExecutionOutputSchema,
  exitCode: z.number().int().nullable().optional(),
  cancelled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  excludeFromContext: z.boolean().optional(),
  meta: OmpOptionalMetadataSchema,
};
const OmpCustomMessageShape = {
  customType: NAME.optional(),
  content: OmpDisplayContentSchema.optional(),
  display: z.boolean().optional(),
  attribution: OmpOpaqueMessagePayloadSchema.optional(),
};
const OmpFileMentionSchema = z
  .object({
    path: boundedString(MAX_PATH_LENGTH),
    content: TEXT,
    lineCount: z.number().int().nonnegative().safe().optional(),
    byteSize: z.number().int().nonnegative().safe().optional(),
    skippedReason: z.enum(["tooLarge", "binary"]).optional(),
    image: OmpContentPartSchema.optional(),
  })
  .superRefine((file, context) => {
    if (file.image && file.image.type !== "image") {
      context.addIssue({ code: "custom", message: "invalid file mention image" });
    }
  });

const OmpMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("assistant"),
    content: OmpAssistantDisplayContentSchema.optional(),
    ...OmpMessageIdentityShape,
    errorMessage: boundedString(4_096).nullable().optional(),
    stopReason: boundedString(64).optional(),
  }),
  z.object({
    role: z.literal("user"),
    content: OmpDisplayContentSchema,
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("developer"),
    content: OmpDisplayContentSchema,
    attribution: OmpOpaqueMessagePayloadSchema.optional(),
    synthetic: z.boolean().optional(),
    userInitiated: z.boolean().optional(),
    providerPayload: OmpOpaqueMessagePayloadSchema.optional(),
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    content: OmpOpaqueMessagePayloadSchema,
    isError: z.boolean().optional(),
    attribution: OmpOpaqueMessagePayloadSchema.optional(),
    prunedAt: z.number().finite().nonnegative().optional(),
    providerMetadata: OmpOpaqueMessagePayloadSchema.optional(),
    useless: z.boolean().optional(),
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("bashExecution"),
    command: TEXT,
    ...OmpExecutionMessageShape,
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("pythonExecution"),
    code: TEXT,
    ...OmpExecutionMessageShape,
    ...OmpMessageIdentityShape,
  }),
  z.object({ role: z.literal("custom"), ...OmpCustomMessageShape, ...OmpMessageIdentityShape }),
  z.object({
    role: z.literal("hookMessage"),
    ...OmpCustomMessageShape,
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("branchSummary"),
    summary: TEXT,
    fromId: IDENTIFIER,
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("compactionSummary"),
    summary: TEXT,
    shortSummary: TEXT.optional(),
    tokensBefore: z.number().finite().nonnegative(),
    tokensAfter: z.number().finite().nonnegative().optional(),
    method: NAME.optional(),
    providerPayload: OmpOpaqueMessagePayloadSchema.optional(),
    blocks: z.array(OmpContentPartSchema).max(OMP_MAX_CONTENT_PARTS).optional(),
    warning: boundedString(64 * 1024).optional(),
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("fileMention"),
    files: z.array(OmpFileMentionSchema).max(MAX_ARRAY_ITEMS),
    ...OmpMessageIdentityShape,
  }),
]);
export type OmpMessage = z.infer<typeof OmpMessageSchema>;

const OmpAssistantMessageEventSchema = z
  .object({
    type: NAME,
    contentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(OMP_MAX_CONTENT_PARTS - 1)
      .optional(),
    delta: TEXT.optional(),
    content: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_IMAGE_DATA_LENGTH + 1_024))
      .optional(),
  })
  .superRefine((event, context) => {
    const content = event.content;
    const imageLike =
      content !== null &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      "type" in content &&
      content.type === "image";
    if (!event.type.startsWith("image_") && !imageLike) return;
    const image = OmpContentPartSchema.safeParse(content);
    if (!image.success || image.data.type !== "image") {
      context.addIssue({ code: "custom", message: "invalid image event" });
    }
  });

const OmpAvailableCommandSchema = z.object({
  name: NAME,
  aliases: z.array(NAME).max(32).optional(),
  description: boundedString(4_096).optional(),
  input: z
    .object({ hint: boundedString(1_024).optional() })
    .nullable()
    .optional(),
  subcommands: z
    .array(
      z.object({
        name: NAME,
        description: boundedString(4_096).optional(),
        usage: boundedString(1_024).optional(),
      }),
    )
    .max(128)
    .optional(),
  source: boundedString(64).optional(),
});
const OmpThinkingMetadataSchema = z
  .unknown()
  .transform((value): { efforts?: string[]; defaultLevel?: string } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const efforts = boundedOptionalStringArray(16, 32).parse(record.efforts);
    const defaultLevel = boundedString(32).optional().catch(undefined).parse(record.defaultLevel);
    return {
      ...(efforts !== undefined ? { efforts } : {}),
      ...(defaultLevel !== undefined ? { defaultLevel } : {}),
    };
  });
const OmpModelSchema = z.object({
  provider: OMP_PROVIDER_NAME,
  id: NAME,
  name: boundedString(MAX_NAME_LENGTH).optional().catch(undefined),
  reasoning: z.boolean().optional().catch(undefined),
  thinking: OmpThinkingMetadataSchema.optional(),
  input: boundedOptionalStringArray(16, MAX_NAME_LENGTH).optional(),
  contextWindow: z
    .number()
    .int()
    .nonnegative()
    .max(100_000_000)
    .nullable()
    .optional()
    .catch(undefined),
});
const TokenCountSchema = z.number().int().nonnegative().max(MAX_TOKEN_COUNT);
const OptionalTokenCountSchema = TokenCountSchema.nullable().optional();
const OptionalCostSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_COST_USD)
  .nullable()
  .optional();
const OmpContextUsageSchema = z.object({
  tokens: OptionalTokenCountSchema,
  contextWindow: TokenCountSchema.max(100_000_000).nullable().optional(),
  percent: z.number().finite().nonnegative().max(MAX_CONTEXT_PERCENT).nullable().optional(),
});
const OmpSessionStatsSchema = z.object({
  userMessages: OptionalTokenCountSchema,
  assistantMessages: OptionalTokenCountSchema,
  toolCalls: OptionalTokenCountSchema,
  toolResults: OptionalTokenCountSchema,
  totalMessages: OptionalTokenCountSchema,
  tokens: z
    .object({
      input: OptionalTokenCountSchema,
      output: OptionalTokenCountSchema,
      reasoning: OptionalTokenCountSchema,
      cacheRead: OptionalTokenCountSchema,
      cacheWrite: OptionalTokenCountSchema,
      total: OptionalTokenCountSchema,
    })
    .nullable()
    .optional(),
  cost: OptionalCostSchema,
  premiumRequests: OptionalTokenCountSchema,
  credits: z
    .object({
      cost: OptionalCostSchema,
      committedCost: OptionalCostSchema,
      acuCost: OptionalCostSchema,
    })
    .nullable()
    .optional(),
  routedModels: z.record(NAME, OptionalTokenCountSchema).nullable().optional(),
  contextUsage: OmpContextUsageSchema.nullable().optional(),
});
const OmpCompactionResultSchema = z.object({
  tokensBefore: OptionalTokenCountSchema,
  preTokens: OptionalTokenCountSchema,
});
const OmpSessionStateSchema = z.object({
  model: OmpModelSchema.nullable().optional(),
  thinkingLevel: OmpCurrentThinkingLevelSchema,
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  sessionId: IDENTIFIER,
  autoCompactionEnabled: z.boolean().optional(),
  contextUsage: OmpContextUsageSchema.nullable().optional().catch(undefined),
  sessionFile: boundedString(MAX_PATH_LENGTH).optional().catch(undefined),
});
const OmpReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number().int().positive().max(16).optional(),
  supportedProtocolVersions: z.array(z.number().int().positive().max(16)).max(8).optional(),
  maxFrameBytes: z.number().int().positive().optional(),
  maxReassembledFrameBytes: z.number().int().positive().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});
const OmpResponseFrameSchema = z.object({
  type: z.literal("response"),
  id: IDENTIFIER,
  command: boundedString(64, 1).optional(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: boundedString(MAX_RPC_ERROR_BYTES).optional(),
  code: boundedString(MAX_RPC_ERROR_CODE_BYTES, 1).optional(),
});
const OmpChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: IDENTIFIER,
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(MAX_CHUNK_COUNT),
  byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
  data: boundedString(MAX_ENCODED_CHUNK_BYTES),
});
const JsonObjectSchema = z.record(z.string(), z.unknown());
const BoundedToolPayloadSchema = z
  .unknown()
  .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 4_096));
const OmpToolResultPayloadSchema = z.preprocess(
  omitUnsafeOptionalDetails,
  z
    .unknown()
    .refine(
      (value) =>
        isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, MAX_OPTIONAL_METADATA_ITEMS, 8_192) &&
        isBoundedJson(omitOptionalDetails(value), MAX_SEMANTIC_FRAME_BYTES, 1_024, 4_096),
    ),
);
const OmpHostToolDefinitionSchema = z.object({
  name: NAME,
  label: NAME.optional(),
  description: boundedString(MAX_TEXT_LENGTH),
  loadMode: z.enum(["essential", "discoverable"]).optional(),
  parameters: JsonObjectSchema,
});
const OmpHostToolCallSchema = z.object({
  type: z.literal("host_tool_call"),
  id: IDENTIFIER,
  toolCallId: IDENTIFIER,
  toolName: NAME,
  arguments: JsonObjectSchema,
});
const OmpHostToolCancelSchema = z.object({
  type: z.literal("host_tool_cancel"),
  id: IDENTIFIER,
  targetId: IDENTIFIER,
});
const OmpHostToolContentSchema = z.object({ type: NAME, text: TEXT.optional() }).passthrough();
const OmpHostToolAgentResultSchema = z.object({
  content: z.array(OmpHostToolContentSchema).max(MAX_ARRAY_ITEMS),
  details: BoundedToolPayloadSchema.optional(),
  isError: z.boolean().optional(),
});
const OmpHostToolResultSchema = z.object({
  type: z.literal("host_tool_result"),
  id: IDENTIFIER,
  result: OmpHostToolAgentResultSchema,
  isError: z.boolean().optional(),
});
const OmpHostToolUpdateSchema = z.object({
  type: z.literal("host_tool_update"),
  id: IDENTIFIER,
  partialResult: OmpHostToolAgentResultSchema,
});
const OmpToolApprovalIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), command: boundedJsonString(24 * 1024, 1) }).strict(),
  z
    .object({
      kind: z.literal("edit"),
      paths: z.array(boundedJsonString(MAX_TOOL_APPROVAL_PATH_BYTES, 1)).min(1).max(16),
      content: boundedJsonString(MAX_TOOL_APPROVAL_CONTENT_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("write"),
      path: boundedJsonString(MAX_TOOL_APPROVAL_PATH_BYTES, 1),
      content: boundedJsonString(MAX_TOOL_APPROVAL_CONTENT_BYTES),
    })
    .strict(),
  z.object({ kind: z.literal("other") }).strict(),
]);
type OmpToolApprovalValue =
  | string
  | number
  | boolean
  | null
  | OmpToolApprovalValue[]
  | { [key: string]: OmpToolApprovalValue };
const OmpToolApprovalValueSchema: z.ZodType<OmpToolApprovalValue> = z.lazy(() =>
  z.union([
    boundedString(MAX_TOOL_APPROVAL_STRING_BYTES),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(OmpToolApprovalValueSchema).max(MAX_TOOL_APPROVAL_COLLECTION_ITEMS),
    z.record(boundedString(128, 1), OmpToolApprovalValueSchema),
  ]),
);
function approvalInputWithinBounds(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_TOOL_APPROVAL_INPUT_NODES) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth >= MAX_TOOL_APPROVAL_DEPTH) return false;
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}
const OmpToolApprovalRequestSchema = z
  .object({
    type: z.literal("tool_approval_request"),
    id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolKind: z.enum(["shell", "edit", "write", "other"]),
    toolName: boundedString(MAX_TOOL_APPROVAL_NAME_BYTES, 1),
    tier: z.enum(["read", "write", "exec"]),
    identity: OmpToolApprovalIdentitySchema,
    input: z
      .record(boundedString(128, 1), OmpToolApprovalValueSchema)
      .refine(approvalInputWithinBounds),
    detail: z
      .object({
        lines: z
          .array(boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES))
          .max(MAX_TOOL_APPROVAL_DETAIL_LINES),
        truncated: z.boolean(),
        truncatedFields: z
          .array(boundedString(MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES))
          .max(MAX_TOOL_APPROVAL_METADATA_FIELDS),
        redacted: z.boolean(),
        redactedFields: z
          .array(boundedString(MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES))
          .max(MAX_TOOL_APPROVAL_METADATA_FIELDS),
        reason: boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES).optional(),
        providerSafetyChecks: z
          .array(boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES))
          .max(MAX_TOOL_APPROVAL_DETAIL_LINES)
          .optional(),
      })
      .strict(),
    timeout: z.number().finite().nonnegative().max(MAX_TOOL_APPROVAL_TIMEOUT_MS).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.toolKind !== request.identity.kind) {
      context.addIssue({ code: "custom", message: "tool approval identity kind mismatch" });
    }
    if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_TOOL_APPROVAL_FRAME_BYTES) {
      context.addIssue({ code: "custom", message: "tool approval request exceeds bounds" });
    }
  });
const OmpToolApprovalCancelSchema = z
  .object({
    type: z.literal("tool_approval_cancel"),
    id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    targetId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
  })
  .strict();
const OmpToolApprovalResponseSchema = z.union([
  z
    .object({
      type: z.literal("tool_approval_response"),
      id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      approved: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_approval_response"),
      id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      cancelled: z.literal(true),
      timedOut: z.boolean().optional(),
    })
    .strict(),
]);
const OmpAgentEndEnvelopeSchema = z.object({
  type: z.literal("agent_end"),
  requestId: IDENTIFIER.optional(),
  messageCount: z.number().int().nonnegative().optional(),
  isTerminal: z.boolean().optional(),
});
const OmpCompactionStartSchema = z.object({
  type: z.literal("compaction_start"),
  reason: boundedString(4_096).optional(),
});
const OmpCompactionEndSchema = z.object({
  type: z.literal("compaction_end"),
  reason: boundedString(4_096).optional(),
  result: BoundedToolPayloadSchema.optional(),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  errorMessage: boundedString(4_096).optional(),
  skipped: z.boolean().optional(),
});
const OmpCoreAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({
    type: z.literal("agent_end"),
    requestId: IDENTIFIER.optional(),
    messages: z.array(OmpMessageSchema).max(MAX_ARRAY_ITEMS).optional(),
    messageCount: z.number().int().nonnegative().optional(),
    isTerminal: z.boolean().optional(),
  }),
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("turn_end") }),
  z.object({ type: z.literal("message_start"), message: OmpMessageSchema }),
  z.object({
    type: z.literal("message_update"),
    message: OmpMessageSchema,
    assistantMessageEvent: OmpAssistantMessageEventSchema.optional(),
  }),
  z.object({ type: z.literal("message_end"), message: OmpMessageSchema }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    args: BoundedToolPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    args: BoundedToolPayloadSchema.optional(),
    partialResult: OmpToolResultPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_stream_update"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    update: BoundedToolPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    result: OmpToolResultPayloadSchema,
    isError: z.boolean().optional(),
  }),
  OmpCompactionStartSchema,
  OmpCompactionEndSchema,
]);
const OmpGoalSchema = z.object({
  id: IDENTIFIER.optional(),
  objective: TEXT.optional(),
  status: boundedString(256).optional(),
  tokenBudget: z.number().finite().nonnegative().optional(),
  tokensUsed: z.number().finite().nonnegative().optional(),
  timeUsedSeconds: z.number().finite().nonnegative().optional(),
  createdAt: boundedString(128).optional(),
  updatedAt: boundedString(128).optional(),
});
const OmpGoalModeStateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: boundedString(256).optional(),
  reason: boundedString(4_096).optional(),
  goal: OmpGoalSchema.optional(),
});
const OmpTodoReminderEventSchema = z.object({
  type: z.literal("todo_reminder"),
  todos: z
    .array(
      z.object({
        id: IDENTIFIER.optional(),
        content: boundedString(16_384),
        status: z.enum(["pending", "in_progress", "blocked", "completed", "abandoned"]),
      }),
    )
    .max(MAX_TODOS),
  attempt: z.number().int().nonnegative().safe().optional(),
  maxAttempts: z.number().int().nonnegative().safe().optional(),
});
const OmpThinkingLevelChangedEventSchema = z.object({
  type: z.literal("thinking_level_changed"),
  thinkingLevel: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES).optional(),
  configured: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES).optional(),
  resolved: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES).optional(),
});
const OmpAutoRetryStartEventSchema = z.object({
  type: z.literal("auto_retry_start"),
  attempt: z.number().int().nonnegative().safe(),
  maxAttempts: z.number().int().positive().safe(),
  delayMs: z.number().int().nonnegative().safe(),
  errorMessage: boundedString(64 * 1024),
  errorId: z.number().int().safe().optional(),
});
const OmpAutoRetryEndEventSchema = z.object({
  type: z.literal("auto_retry_end"),
  success: z.boolean(),
  attempt: z.number().int().nonnegative().safe(),
  finalError: boundedString(64 * 1024).optional(),
  retryErrors: BoundedToolPayloadSchema.optional(),
  recoveredErrors: BoundedToolPayloadSchema.optional(),
});
const OmpAgentSessionEventSchema = z.discriminatedUnion("type", [
  ...OmpCoreAgentEventSchema.options,
  z.object({ type: z.literal("config_warnings_changed") }),
  z.object({ type: z.literal("advisor_cost_changed") }),
  z.object({ type: z.literal("advisor_yielded") }),
  z.object({
    type: z.literal("ttsr_triggered"),
    rules: z.array(BoundedToolPayloadSchema).max(MAX_ARRAY_ITEMS),
  }),
  OmpTodoReminderEventSchema,
  z.object({ type: z.literal("todo_auto_clear") }),
  z.object({
    type: z.literal("irc_message"),
    message: OmpMessageSchema.refine((message) => message.role === "custom"),
  }),
  z.object({ type: z.literal("model_changed") }),
  OmpThinkingLevelChangedEventSchema,
  z.object({
    type: z.literal("goal_updated"),
    goal: OmpGoalSchema.nullable().optional(),
    state: OmpGoalModeStateSchema.optional(),
  }),
  OmpAutoRetryStartEventSchema,
  OmpAutoRetryEndEventSchema,
  z.object({
    type: z.literal("retry_fallback_applied"),
    from: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    to: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    role: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({
    type: z.literal("retry_fallback_succeeded"),
    model: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    role: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({
    type: z.literal("auto_compaction_start"),
    reason: boundedString(4_096),
    action: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({
    type: z.literal("auto_compaction_end"),
    action: NAME.optional(),
    result: OmpCompactionResultSchema.nullable().optional(),
    aborted: z.boolean().optional(),
    willRetry: z.boolean().optional(),
    errorMessage: boundedString(64 * 1024).optional(),
    skipped: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("notice"),
    id: IDENTIFIER.optional(),
    level: z.enum(["info", "warning", "error"]),
    message: boundedString(64 * 1024),
    source: boundedString(MAX_NAME_LENGTH).optional(),
  }),
]);
const OmpSubagentStatusSchema = z.enum([
  "pending",
  "running",
  "started",
  "completed",
  "failed",
  "aborted",
]);
const OmpSubagentLifecyclePayloadSchema = z.object({
  id: IDENTIFIER,
  agent: NAME,
  agentSource: NAME.optional(),
  description: boundedString(64 * 1024).optional(),
  status: OmpSubagentStatusSchema,
  sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
  parentToolCallId: IDENTIFIER.optional(),
  index: z.number().int().nonnegative().max(10_000),
  detached: z.boolean().optional(),
});
const OmpSubagentProgressSchema = z.object({
  id: IDENTIFIER,
  status: OmpSubagentStatusSchema,
  description: boundedString(64 * 1024).optional(),
  currentTool: BoundedToolPayloadSchema.optional(),
  recentTools: z.array(BoundedToolPayloadSchema).max(64).optional(),
  recentOutput: z.array(BoundedToolPayloadSchema).max(128).optional(),
  resolvedModel: NAME.optional(),
});
const OmpSubagentProgressPayloadSchema = z.object({
  index: z.number().int().nonnegative().max(10_000),
  agent: NAME,
  agentSource: NAME.optional(),
  task: TEXT,
  parentToolCallId: IDENTIFIER.optional(),
  assignment: TEXT.optional(),
  progress: OmpSubagentProgressSchema,
  sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
  detached: z.boolean().optional(),
});
const ExtensionUiBase = { type: z.literal("extension_ui_request"), id: IDENTIFIER };
const OmpExtensionUiRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("select"),
      title: boundedString(4_096),
      options: z.array(boundedString(4_096)).min(1).max(128),
      optionDetails: z
        .array(z.object({ description: boundedString(16_384).optional() }).strict())
        .max(128)
        .optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.optionDetails && request.optionDetails.length !== request.options.length) {
        context.addIssue({ code: "custom", message: "invalid extension UI request" });
      }
    }),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("confirm"),
      title: boundedString(4_096),
      message: boundedString(64 * 1024),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("input"),
      title: boundedString(4_096),
      placeholder: boundedString(4_096).optional(),
      prefill: TEXT.optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("editor"),
      title: boundedString(4_096),
      prefill: TEXT.optional(),
      promptStyle: z.boolean().optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z.object({ ...ExtensionUiBase, method: z.literal("cancel"), targetId: IDENTIFIER }).strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("notify"),
      message: boundedString(64 * 1024),
      notifyType: z.enum(["info", "warning", "error"]).optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("setStatus"),
      statusKey: NAME,
      statusText: boundedString(16_384).optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("setWidget"),
      widgetKey: NAME,
      widgetLines: z.array(boundedString(16_384)).max(128).optional(),
      widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
    })
    .strict(),
  z
    .object({ ...ExtensionUiBase, method: z.literal("setTitle"), title: boundedString(4_096) })
    .strict(),
  z.object({ ...ExtensionUiBase, method: z.literal("set_editor_text"), text: TEXT }).strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("open_url"),
      url: boundedString(16_384),
      launchUrl: boundedString(16_384).optional(),
      instructions: boundedString(64 * 1024).optional(),
    })
    .strict(),
]);
const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  ...OmpAgentSessionEventSchema.options,
  z.object({
    type: z.literal("subagent_lifecycle"),
    payload: OmpSubagentLifecyclePayloadSchema,
  }),
  z.object({
    type: z.literal("subagent_progress"),
    payload: OmpSubagentProgressPayloadSchema,
  }),
  z.object({
    type: z.literal("subagent_event"),
    payload: z.object({ id: IDENTIFIER, event: OmpAgentSessionEventSchema }),
  }),
  z.object({
    type: z.literal("available_commands_update"),
    commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
  }),
  z.object({ type: z.literal("command_output"), text: TEXT.optional() }),
  OmpExtensionUiRequestSchema,
  z.object({
    type: z.literal("prompt_result"),
    id: IDENTIFIER.optional(),
    agentInvoked: z.boolean(),
  }),
  OmpHostToolCallSchema,
  OmpHostToolCancelSchema,
  OmpToolApprovalRequestSchema,
  OmpToolApprovalCancelSchema,
]);
type OptionalDetailsMapper = (value: unknown, taskResult?: boolean) => unknown;

function mapRecordField(
  record: Record<string, unknown>,
  key: string,
  map: OptionalDetailsMapper,
  taskResult = false,
): Record<string, unknown> {
  if (!Object.hasOwn(record, key)) return record;
  const next = map(record[key], taskResult);
  return next === record[key] ? record : { ...record, [key]: next };
}

function mapMessageList(value: unknown, map: OptionalDetailsMapper): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const messages = value.map((message) => {
    const taskResult =
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).role === "toolResult" &&
      (message as Record<string, unknown>).toolName === "task";
    const next = map(message, taskResult);
    changed ||= next !== message;
    return next;
  });
  return changed ? messages : value;
}

function mapAgentEventDetails(
  frame: Record<string, unknown>,
  map: OptionalDetailsMapper,
): Record<string, unknown> {
  switch (frame.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      const message = frame.message;
      const taskResult =
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "toolResult" &&
        (message as Record<string, unknown>).toolName === "task";
      return mapRecordField(frame, "message", map, taskResult);
    }
    case "tool_execution_update":
      return mapRecordField(frame, "partialResult", map, frame.toolName === "task");
    case "tool_execution_end":
      return mapRecordField(frame, "result", map, frame.toolName === "task");
    case "agent_end":
      return mapRecordField(frame, "messages", (messages) => mapMessageList(messages, map));
    case "irc_message":
      return mapRecordField(frame, "message", map);
    default:
      return frame;
  }
}

function mapRuntimeFrameDetails(
  frame: Record<string, unknown>,
  map: OptionalDetailsMapper,
): Record<string, unknown> {
  if (frame.type !== "subagent_event") return mapAgentEventDetails(frame, map);
  if (frame.payload === null || typeof frame.payload !== "object" || Array.isArray(frame.payload)) {
    return frame;
  }
  const payload = frame.payload as Record<string, unknown>;
  if (payload.event === null || typeof payload.event !== "object" || Array.isArray(payload.event)) {
    return frame;
  }
  const event = mapAgentEventDetails(payload.event as Record<string, unknown>, map);
  return event === payload.event ? frame : { ...frame, payload: { ...payload, event } };
}

function sanitizeMessageListMetadata(value: unknown): unknown {
  return mapMessageList(value, createOptionalMetadataSanitizer());
}

function sanitizeHistoryResponseData(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return mapRecordField(value as Record<string, unknown>, "messages", sanitizeMessageListMetadata);
}

function projectSessionStateResponseData(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of [
    "model",
    "thinkingLevel",
    "isStreaming",
    "isCompacting",
    "sessionId",
    "autoCompactionEnabled",
    "contextUsage",
    "sessionFile",
  ] as const) {
    if (Object.hasOwn(source, key)) projected[key] = source[key];
  }
  return projected;
}

function runtimeFrameCollectionLimit(frame: Record<string, unknown>): number {
  const type = frame.type;
  if (
    type === "message_start" ||
    type === "message_update" ||
    type === "message_end" ||
    type === "agent_end" ||
    type === "subagent_event"
  ) {
    return OMP_MAX_CONTENT_PARTS;
  }
  return 1_024;
}
const OmpModelsResultSchema = z.object({
  models: z.array(OmpModelSchema).min(1).max(MAX_MODEL_CATALOG_ITEMS),
});
const OmpPromptAckSchema = z.object({ agentInvoked: z.boolean().optional() }).optional();
const OmpAvailableCommandsResultSchema = z.object({
  commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
});
const OmpBranchMessagesResultSchema = z.object({
  messages: z.array(z.object({ entryId: IDENTIFIER, text: TEXT })).max(1_024),
});
const OmpBranchResultSchema = z.object({ text: TEXT, cancelled: z.boolean() });
const OmpMessagesResultSchema = z.object({
  messages: z.array(OmpMessageSchema).max(MAX_REPLAY_MESSAGES),
});
const OmpMessagesPageResultSchema = z.object({
  messages: z.array(OmpMessageSchema).max(OMP_MESSAGE_PAGE_LIMIT),
  nextCursor: boundedString(2_048, 1).refine(isSafeOpaqueCursor).optional(),
  totalMessages: z.number().int().nonnegative().max(MAX_REPLAY_MESSAGES),
});
const OmpSubagentsResultSchema = z.object({
  subagents: z
    .array(
      z.object({
        id: IDENTIFIER,
        index: z.number().int().nonnegative().max(10_000),
        agent: NAME,
        agentSource: NAME.optional(),
        description: TEXT.optional(),
        status: OmpSubagentStatusSchema,
        task: TEXT.optional(),
        assignment: TEXT.optional(),
        sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
        lastUpdate: z.number().finite().nonnegative(),
        parentToolCallId: IDENTIFIER.optional(),
      }),
    )
    .max(1_024),
});
const OmpSubagentMessagesResultSchema = z.object({
  sessionFile: boundedString(MAX_PATH_LENGTH),
  fromByte: z.number().int().nonnegative(),
  nextByte: z.number().int().nonnegative(),
  reset: z.boolean(),
  messages: z.array(OmpMessageSchema).max(MAX_REPLAY_MESSAGES),
});
const ProtocolNegotiationResultSchema = z.object({
  protocolVersion: z.literal(2),
  clientCapabilities: z.object({ typedToolApprovals: z.literal(1).optional() }).optional(),
});

export type OmpModel = z.infer<typeof OmpModelSchema>;
export type OmpBranchResult = z.infer<typeof OmpBranchResultSchema>;
export type OmpSessionState = z.infer<typeof OmpSessionStateSchema>;
export type OmpSessionStats = z.infer<typeof OmpSessionStatsSchema>;
export type OmpCompactionResult = z.infer<typeof OmpCompactionResultSchema>;
export type OmpHostToolDefinition = z.infer<typeof OmpHostToolDefinitionSchema>;
export type OmpHostToolCall = z.infer<typeof OmpHostToolCallSchema>;
export type OmpHostToolResult = z.infer<typeof OmpHostToolResultSchema>;
export type OmpHostToolUpdate = z.infer<typeof OmpHostToolUpdateSchema>;
export type OmpToolApprovalRequest = z.infer<typeof OmpToolApprovalRequestSchema>;
export type OmpToolApprovalCancel = z.infer<typeof OmpToolApprovalCancelSchema>;
export type OmpToolApprovalResponse = z.infer<typeof OmpToolApprovalResponseSchema>;
export function parseOmpHostToolAgentResult(value: unknown): OmpHostToolResult["result"] {
  return OmpHostToolAgentResultSchema.parse(value);
}
export type OmpRpcEvent =
  | z.infer<typeof OmpRuntimeEventSchema>
  | { type: "prompt_error"; id: string; error: string; code?: string }
  | { type: "process_exit"; error: string };
export type OmpAgentSessionEvent = z.infer<typeof OmpAgentSessionEventSchema>;
export type OmpSubagentSnapshot = z.infer<typeof OmpSubagentsResultSchema>["subagents"][number];
export type OmpSubagentEvent = Extract<
  z.infer<typeof OmpRuntimeEventSchema>,
  { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event" }
>;
export interface OmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: OmpMessage[];
}
export interface OmpPersistedSubagentMessages {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: OmpMessage[];
}
export interface OmpPersistedSessionMessages {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: OmpMessage[];
  imageReplayWarning?: true;
}

export type OmpAvailableCommand = z.infer<typeof OmpAvailableCommandSchema>;
export type OmpImage = { type: "image"; data: string; mimeType: string };
export type OmpExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

export interface OmpRuntimeSession {
  readonly maxHostToolFrameBytes?: number;
  /** Maximum bytes accepted for one unchunked stdin JSONL frame, including its newline. */
  readonly maxInputFrameBytes?: number;
  readonly supportsTypedToolApprovals: boolean;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  getState(): Promise<OmpSessionState>;
  getSessionStats(): Promise<OmpSessionStats>;
  getAvailableModels(): Promise<OmpModel[]>;
  getAvailableCommands(): Promise<OmpAvailableCommand[]>;
  setSubagentSubscription(level: "events"): Promise<void>;
  readonly inheritedRedactionValues?: readonly string[];
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult>;
  prompt(
    message: string,
    images?: readonly OmpImage[],
    onAccepted?: () => void,
    onRequested?: (requestId: string) => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }>;
  compact(customInstructions?: string): Promise<OmpCompactionResult>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: string): Promise<void>;
  steer(message: string, images?: readonly OmpImage[]): Promise<void>;
  followUp(message: string, images?: readonly OmpImage[]): Promise<void>;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void>;
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  branch(entryId: string): Promise<OmpBranchResult>;
  readonly canReplayHistory: boolean;
  getMessages(signal?: AbortSignal): Promise<OmpMessage[]>;
  abort(): Promise<void>;
  setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpHostToolResult): void;
  sendHostToolUpdate(update: OmpHostToolUpdate): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  readonly supportsPersistence: boolean;
  startSession(options: OmpStartOptions): Promise<OmpRuntimeSession>;
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]>;
  readPersistedSessionTranscript?(options: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSessionMessages>;
  readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages>;
}

export interface OmpRpcRuntimeOptions {
  spawnProcess?: (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number) => Promise<boolean | "uncertain">;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  reportProtocolViolation?: (diagnostic: OmpProtocolViolationDiagnostic) => void | Promise<void>;
  listSessions?: (
    options: OmpSessionListOptions,
  ) => OmpSessionDescriptor[] | Promise<OmpSessionDescriptor[]>;
}

export type OmpRpcRequestRejectionCode = "session_busy" | "stale_cursor" | "unsupported_command";

export class OmpRpcRequestRejectedError extends Error {
  constructor(
    readonly command?: OmpRpcDiagnosticCommand,
    readonly code?: OmpRpcRequestRejectionCode,
  ) {
    super("OMP RPC request failed");
    this.name = "OmpRpcRequestRejectedError";
  }
}

export class OmpRpcResponseLimitError extends Error {
  constructor(
    readonly command: OmpRpcDiagnosticCommand | undefined,
    readonly bound: OmpRpcBoundDimension,
    readonly actual: number,
    readonly limit: number,
  ) {
    super("OMP RPC response exceeded command limits");
    this.name = "OmpRpcResponseLimitError";
  }
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: TimerHandle;
  command: string;
  beforeResolve?: (value: unknown) => void;
};
type StartedRequest = { id: string; promise: Promise<unknown> };

type ReadyFrame = z.infer<typeof OmpReadyFrameSchema>;
type ChunkFrame = z.infer<typeof OmpChunkFrameSchema>;

type ChunkState = {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  receivedBytes: number;
  timer: TimerHandle;
};

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const result = Promise.withResolvers<T>();
  const timer = setTimeout(() => result.reject(new Error(message)), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      result.resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      result.reject(error);
    },
  );
  return result.promise;
}

class OmpRpcProcess {
  readonly ready: Promise<ReadyFrame>;
  readonly inheritedRedactionValues: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queuedWrites = new Map<string, number>();
  private readonly pendingOneWayWrites = new Map<
    string,
    { reject(error: Error): void; timer: TimerHandle }
  >();
  private readonly acceptedPromptIds = new Set<string>();
  private readonly exitPromise: Promise<void>;
  private readonly resolveExit: () => void;
  private readonly resolveReady: (frame: ReadyFrame) => void;
  private readonly rejectReady: (error: Error) => void;
  private readonly terminateProcessTree: (pid: number) => Promise<ProcessTreeCleanup>;
  private readonly streamedBlocks = new Map<number, string>();
  private readonly activeToolCallIds = new Set<string>();
  private pendingWriteBytes = 0;
  private commandTextLength = 0;
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private discardingLine = false;
  private discardedLineBytes = 0;
  private chunk: ChunkState | null = null;
  private physicalFrameLimit = MAX_PHYSICAL_FRAME_BYTES;
  private reassembledFrameLimit = MAX_REASSEMBLED_FRAME_BYTES;
  private closed = false;
  private exited = false;
  private fatalError: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private treeCleanupPromise: Promise<ProcessTreeCleanup> | null = null;
  private spawnFailedWithoutProcess = false;
  private readyReceived = false;
  private outputSettled = false;
  private turnActive = false;
  private readonly pendingProtocolViolations = new Map<
    ProtocolViolationKey,
    PendingProtocolViolation
  >();
  private protocolViolationTimer: TimerHandle | null = null;

  constructor(
    options: OmpStartOptions,
    spawnProcess?: OmpRpcRuntimeOptions["spawnProcess"],
    terminateProcessTree?: OmpRpcRuntimeOptions["terminateProcessTree"],
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly reportProtocolViolation: (
      diagnostic: OmpProtocolViolationDiagnostic,
    ) => void | Promise<void> = (diagnostic) => console.error("OMP protocol violation", diagnostic),
  ) {
    const ready = Promise.withResolvers<ReadyFrame>();
    this.rejectReady = ready.reject;
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    const request = buildOmpSpawnRequest(options);
    this.inheritedRedactionValues = request.inheritedRedactionValues;
    this.terminateProcessTree = terminateProcessTree
      ? async (pid) => {
          const outcome = await terminateProcessTree(pid);
          return outcome === true ? "verified" : outcome === "uncertain" ? "uncertain" : "failed";
        }
      : async (pid) =>
          process.platform === "win32"
            ? stopWindowsTree(pid)
            : (await terminatePosixProcessTree(pid, PROCESS_STOP_TIMEOUT_MS))
              ? "verified"
              : "failed";
    try {
      this.child = spawnProcess
        ? spawnProcess(request)
        : spawn(request.command, request.args, {
            cwd: request.cwd,
            env: request.env,
            detached: request.detached,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      throw new Error(
        code === "ENOENT"
          ? "OMP executable was not found"
          : code === "EACCES" || code === "EPERM"
            ? "OMP executable is not runnable"
            : "OMP process could not be launched",
      );
    }
    this.child.stdout.on("data", (chunk: Buffer | string) => this.receiveData(chunk));
    this.child.stdout.once("end", () => this.handleStdoutEnd());
    this.child.stderr.on("data", () => {
      // Stderr is intentionally drained and discarded. It may contain credentials or paths.
    });
    this.child.stdin.on("error", () => {
      this.fail(new Error("OMP RPC input channel failed"));
    });
    const exited = Promise.withResolvers<void>();
    this.exitPromise = exited.promise;
    this.resolveExit = exited.resolve;
    this.child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    this.child.once("close", () => this.settleOutput());
    this.child.once("error", (cause) => {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (this.child.pid === undefined && isConfirmedNoProcessSpawnFailure(cause)) {
        this.spawnFailedWithoutProcess = true;
      }
      this.fail(
        new Error(
          code === "ENOENT"
            ? "OMP executable was not found"
            : code === "EACCES" || code === "EPERM"
              ? "OMP executable is not runnable"
              : "OMP process could not be launched",
        ),
      );
    });
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    void this.startTreeCleanup();
    const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    const error = new Error(`OMP RPC process exited (${detail})`);
    this.rejectReady(error);
    this.failPending(error);
    this.resolveExit();
    if (!this.closed && !this.fatalError) this.fail(error);
  }

  private handleStdoutEnd(): void {
    this.settleOutput();
    if (!this.exited && !this.closed) this.fail(new Error("OMP RPC output channel closed"));
  }

  private settleOutput(): void {
    if (this.outputSettled) return;
    this.outputSettled = true;
    if (this.lineBytes > 0 || this.discardingLine) {
      this.recordProtocolViolation("incomplete-frame", {
        reason: "output-ended-mid-frame",
        field: "frame",
        expected: "complete-json-line",
        actualType: "partial-frame",
        maxByteSize: this.discardingLine ? this.discardedLineBytes : this.lineBytes,
      });
    }
    this.lineParts = [];
    this.lineBytes = 0;
    this.discardingLine = false;
    this.discardedLineBytes = 0;
  }

  get outboundFrameLimit(): number {
    return this.physicalFrameLimit;
  }

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyReadyLimits(frame: ReadyFrame): void {
    if (frame.maxFrameBytes !== undefined) this.physicalFrameLimit = frame.maxFrameBytes;
    if (frame.maxReassembledFrameBytes !== undefined) {
      this.reassembledFrameLimit = frame.maxReassembledFrameBytes;
    }
  }

  startRequest(
    command: Record<string, unknown>,
    timeoutMs: number | null = this.requestTimeoutMs,
    beforeResolve?: (value: unknown) => void,
  ): StartedRequest {
    const id = randomUUID();
    if (this.fatalError) return { id, promise: Promise.reject(this.fatalError) };
    if (this.closed || this.exited || !this.child.stdin.writable) {
      return { id, promise: Promise.reject(new Error("OMP RPC process is closed")) };
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify({ ...command, id })}\n`);
    } catch {
      return { id, promise: Promise.reject(new Error("OMP RPC request could not be encoded")) };
    }
    if (payload.byteLength > this.physicalFrameLimit) {
      return {
        id,
        promise: Promise.reject(new Error("OMP RPC request exceeds the negotiated frame limit")),
      };
    }
    if (
      this.pending.size >= MAX_PENDING_REQUESTS ||
      this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES
    ) {
      return { id, promise: Promise.reject(new Error("OMP RPC has too many pending requests")) };
    }
    const result = Promise.withResolvers<unknown>();
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            result.reject(new Error("OMP RPC request timed out"));
          }, timeoutMs);
    this.pending.set(id, {
      resolve: result.resolve,
      reject: result.reject,
      timer,
      command: typeof command.type === "string" ? command.type : "unknown",
      ...(beforeResolve ? { beforeResolve } : {}),
    });
    this.queuedWrites.set(id, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        this.releaseQueuedWrite(id);
        if (cause) this.fail(new Error("OMP RPC input channel failed"));
      });
    } catch {
      this.releaseQueuedWrite(id);
      this.fail(new Error("OMP RPC input channel failed"));
    }
    return { id, promise: result.promise };
  }

  request(
    command: Record<string, unknown>,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(frame: OmpHostToolResult | OmpHostToolUpdate): void {
    if (this.fatalError) throw this.fatalError;
    if (this.closed || this.exited || !this.child.stdin.writable) {
      throw new Error("OMP RPC process is closed");
    }
    const parsed =
      frame.type === "host_tool_result"
        ? OmpHostToolResultSchema.parse(frame)
        : OmpHostToolUpdateSchema.parse(frame);
    const payload = Buffer.from(`${JSON.stringify(parsed)}\n`);
    if (payload.byteLength > this.physicalFrameLimit) {
      throw new Error("OMP host tool frame exceeds the negotiated frame limit");
    }
    if (this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES) {
      throw new Error("OMP RPC has too many pending writes");
    }
    const writeId = randomUUID();
    this.queuedWrites.set(writeId, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        this.releaseQueuedWrite(writeId);
        if (cause) this.fail(new Error("OMP RPC input channel failed"));
      });
    } catch {
      this.releaseQueuedWrite(writeId);
      this.fail(new Error("OMP RPC input channel failed"));
      throw new Error("OMP RPC input channel failed");
    }
  }

  sendFrame(frame: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.closed || this.exited || !this.child.stdin.writable) {
      return Promise.reject(new Error("OMP RPC process is closed"));
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify(frame)}\n`);
    } catch {
      return Promise.reject(new Error("OMP RPC frame could not be encoded"));
    }
    if (payload.byteLength > this.physicalFrameLimit) {
      return Promise.reject(new Error("OMP RPC frame exceeds the negotiated frame limit"));
    }
    if (
      this.pendingOneWayWrites.size >= MAX_PENDING_ONE_WAY_WRITES ||
      this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES
    ) {
      return Promise.reject(new Error("OMP RPC has too many pending writes"));
    }
    const token = randomUUID();
    const written = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      if (!this.pendingOneWayWrites.delete(token)) return;
      this.releaseQueuedWrite(token);
      const error = new Error("OMP RPC write timed out");
      written.reject(error);
      this.fail(error);
    }, timeoutMs);
    this.pendingOneWayWrites.set(token, { reject: written.reject, timer });
    this.queuedWrites.set(token, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        const pending = this.pendingOneWayWrites.get(token);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingOneWayWrites.delete(token);
        this.releaseQueuedWrite(token);
        if (cause) {
          const error = new Error("OMP RPC input channel failed");
          written.reject(error);
          this.fail(error);
        } else {
          written.resolve();
        }
      });
    } catch {
      clearTimeout(timer);
      this.pendingOneWayWrites.delete(token);
      this.releaseQueuedWrite(token);
      const error = new Error("OMP RPC input channel failed");
      written.reject(error);
      this.fail(error);
    }
    return written.promise;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    this.closed = true;
    this.flushProtocolViolations();
    this.clearChunk();
    this.failPending(new Error("OMP RPC process was closed"));
    const cleanupPromise = this.startTreeCleanup();
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        // Continue waiting for process-tree cleanup when the input channel is already closed.
      }
    }
    const cleanup = await cleanupPromise;
    if (cleanup !== "verified") throw new Error("OMP RPC process tree cleanup failed");
    if (
      !this.spawnFailedWithoutProcess &&
      !this.exited &&
      !(await this.waitForExit(PROCESS_STOP_TIMEOUT_MS))
    ) {
      throw new Error("OMP RPC process did not close after tree cleanup");
    }
  }

  private startTreeCleanup(): Promise<ProcessTreeCleanup> {
    if (this.treeCleanupPromise) return this.treeCleanupPromise;
    const pid = this.child.pid;
    this.treeCleanupPromise = (
      pid === undefined
        ? Promise.resolve<ProcessTreeCleanup>(
            this.spawnFailedWithoutProcess ? "verified" : "uncertain",
          )
        : this.terminateProcessTree(pid)
    ).catch(() => "failed");
    return this.treeCleanupPromise;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const timeout = Promise.withResolvers<false>();
    const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
    try {
      return await Promise.race([this.exitPromise.then(() => true), timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private receiveData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 10) continue;
      const part = bytes.subarray(start, index);
      if (this.discardingLine) {
        this.discardedLineBytes += part.byteLength;
        if (this.discardedLineBytes > MAX_SEMANTIC_FRAME_BYTES) {
          this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
          return;
        }
        this.resetDiscardedLine();
      } else {
        this.appendLinePart(part);
        if (this.fatalError) return;
        if (this.discardingLine) {
          if (this.discardedLineBytes > MAX_SEMANTIC_FRAME_BYTES) {
            this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
            return;
          }
          this.resetDiscardedLine();
        } else this.completeLine();
      }
      start = index + 1;
    }
    if (start >= bytes.length) return;
    const trailing = bytes.subarray(start);
    if (this.discardingLine) {
      this.discardedLineBytes += trailing.byteLength;
      if (this.discardedLineBytes > MAX_SEMANTIC_FRAME_BYTES) {
        this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      }
    } else {
      this.appendLinePart(trailing);
    }
  }

  private resetDiscardedLine(): void {
    this.discardingLine = false;
    this.discardedLineBytes = 0;
    this.lineParts = [];
    this.lineBytes = 0;
  }

  private appendLinePart(part: Buffer): void {
    if (part.byteLength === 0) return;
    const nextBytes = this.lineBytes + part.byteLength;
    if (nextBytes > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (this.lineParts.length >= MAX_LINE_PARTS || nextBytes > this.physicalFrameLimit) {
      this.discardedLineBytes = nextBytes;
      this.lineParts = [];
      this.lineBytes = 0;
      this.discardingLine = true;
      this.recordProtocolViolation("frame-limit", {
        reason: "physical-frame-limit",
        field: "frame.byteLength",
        expected: "within-byte-limit",
        actualType: "oversized",
        maxByteSize: nextBytes,
        limitBytes: this.physicalFrameLimit,
      });
      return;
    }
    this.lineParts.push(part);
    this.lineBytes = nextBytes;
  }

  private completeLine(): void {
    if (this.lineBytes === 0) return;
    const line = Buffer.concat(this.lineParts, this.lineBytes);
    this.lineParts = [];
    this.lineBytes = 0;
    const payload = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      this.recordProtocolViolation("invalid-json", {
        reason: "json-decode",
        field: "frame",
        expected: "valid-json",
        actualType: "invalid-json",
        maxByteSize: payload.byteLength,
      });
      return;
    }
    this.receiveDecodedFrame(decoded, payload.byteLength);
  }

  private receiveChunk(frame: ChunkFrame): void {
    if (
      frame.byteLength > MAX_SEMANTIC_FRAME_BYTES &&
      ![...this.pending.values()].some(
        (pending) =>
          pending.command === "get_messages" ||
          pending.command === "get_messages_page" ||
          pending.command === "get_subagent_messages" ||
          pending.command === "get_state",
      )
    ) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (
      frame.index >= frame.count ||
      frame.byteLength > this.reassembledFrameLimit ||
      frame.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)
    ) {
      this.rejectChunk("chunk-metadata", {
        field: "chunk",
        expected: "valid-chunk-frame",
        actualType: "object",
      });
      return;
    }
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.byteLength > MAX_CHUNK_BYTES) {
      this.rejectChunk("chunk-size", {
        field: "chunk.data",
        expected: "within-byte-limit",
        actualType: "oversized",
        limitBytes: MAX_CHUNK_BYTES,
      });
      return;
    }
    if (!this.chunk) {
      if (frame.index !== 0) {
        this.rejectChunk("chunk-start-index", {
          field: "chunk.index",
          expected: "first-chunk-index-zero",
          actualType: "out-of-order",
        });
        return;
      }
      this.chunk = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
        receivedBytes: 0,
        timer: setTimeout(
          () =>
            this.rejectChunk("chunk-timeout", {
              field: "chunk.sequence",
              expected: "chunk-before-deadline",
              actualType: "timeout",
            }),
          CHUNK_STALE_MS,
        ),
      };
    }
    const chunk = this.chunk;
    if (
      chunk.id !== frame.chunkId ||
      chunk.count !== frame.count ||
      chunk.byteLength !== frame.byteLength ||
      chunk.parts.length !== frame.index ||
      chunk.receivedBytes + decoded.byteLength > chunk.byteLength ||
      chunk.receivedBytes + decoded.byteLength > this.reassembledFrameLimit
    ) {
      this.rejectChunk("chunk-sequence", {
        field: "chunk.sequence",
        expected: "contiguous-chunk-sequence",
        actualType: "out-of-order",
      });
      return;
    }
    chunk.parts.push(decoded);
    chunk.receivedBytes += decoded.byteLength;
    if (chunk.parts.length !== chunk.count) return;
    if (chunk.receivedBytes !== chunk.byteLength) {
      this.rejectChunk("chunk-byte-count", {
        field: "chunk.byteLength",
        expected: "declared-chunk-byte-count",
        actualType: "mismatched",
      });
      return;
    }
    const reassembled = Buffer.concat(chunk.parts, chunk.receivedBytes);
    this.clearChunk();
    let decodedFrame: unknown;
    try {
      decodedFrame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reassembled));
    } catch {
      this.recordProtocolViolation("invalid-json", {
        reason: "chunk-json-decode",
        field: "chunk.data",
        expected: "valid-json",
        actualType: "invalid-json",
        maxByteSize: reassembled.byteLength,
      });
      return;
    }
    this.receiveDecodedFrame(decodedFrame, reassembled.byteLength);
  }

  private receiveDecodedFrame(value: unknown, rawByteLength: number): void {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const frame = value as Record<string, unknown>;
      const pending = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
      if (
        frame.type === "response" &&
        (pending?.command === "get_messages" ||
          pending?.command === "get_messages_page" ||
          pending?.command === "get_subagent_messages" ||
          pending?.command === "get_state")
      ) {
        this.receiveResponse(frame);
        return;
      }
    }
    if (this.receiveUnsupportedCommandResponse(value)) return;
    if (rawByteLength > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (this.receiveKnownResponse(value)) return;
    const sanitized = sanitizeLiveDisplayFrame(value);
    const frame = JsonObjectSchema.safeParse(sanitized);
    if (!frame.success) {
      this.recordProtocolViolation("invalid-envelope", {
        reason: "object-envelope",
        field: "frame",
        expected: "object-envelope",
        actualType: protocolDiagnosticActualType(sanitized),
        maxByteSize: rawByteLength,
      });
      return;
    }
    this.receiveFrame(frame.data, rawByteLength);
  }

  private receiveKnownResponse(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (
      frame.type !== "response" ||
      typeof frame.id !== "string" ||
      (!this.pending.has(frame.id) && !this.acceptedPromptIds.has(frame.id))
    ) {
      return false;
    }
    this.receiveResponse(frame);
    return true;
  }

  private receiveUnsupportedCommandResponse(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (
      frame.type !== "response" ||
      frame.id !== undefined ||
      frame.success !== false ||
      typeof frame.command !== "string" ||
      frame.error !== `Unknown command: ${frame.command}`
    ) {
      return false;
    }
    const matches = [...this.pending.entries()].filter(
      ([, pending]) => pending.command === frame.command,
    );
    if (matches.length === 0) return false;
    const [id, pending] = matches[0] ?? [];
    if (!id || !pending) return false;
    this.takePending(id)?.reject(
      new OmpRpcRequestRejectedError(rpcDiagnosticCommand(pending.command), "unsupported_command"),
    );
    return true;
  }

  private receiveResponse(frame: Record<string, unknown>): void {
    const rawId = typeof frame.id === "string" ? frame.id : undefined;
    const knownPending = rawId ? this.pending.get(rawId) : undefined;
    const response = OmpResponseFrameSchema.safeParse(frame);
    if (!response.success) {
      const handledAcceptedFailure =
        rawId !== undefined && knownPending === undefined
          ? this.emitAcceptedPromptFailure(rawId, frame)
          : false;
      if (!handledAcceptedFailure) {
        this.recordProtocolViolation("invalid-response", {
          reason: "response-schema",
          frameType: "response",
          field: "response",
          expected: "valid-response-frame",
          actualType: "object",
        });
      }
      if (rawId && knownPending) {
        this.takePending(rawId)?.reject(new Error("OMP RPC response is invalid"));
      }
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      if (!response.data.success) {
        this.emitAcceptedPromptFailure(response.data.id, response.data);
      }
      return;
    }
    const isBranchHistory = pending.command === "get_branch_messages";
    const isHistory =
      pending.command === "get_messages" ||
      pending.command === "get_messages_page" ||
      pending.command === "get_subagent_messages";
    const rawResponseData =
      pending.command === "get_state"
        ? projectSessionStateResponseData(response.data.data)
        : response.data.data;
    const responseData = isHistory ? sanitizeHistoryResponseData(rawResponseData) : rawResponseData;
    const boundedFrame =
      responseData === response.data.data ? frame : { ...frame, data: responseData };
    const responseItemLimit = isBranchHistory
      ? 1_024
      : isHistory
        ? 100_000
        : pending.command === "get_available_models"
          ? MAX_MODEL_CATALOG_ITEMS
          : MAX_ARRAY_ITEMS;
    const responseByteLimit =
      isBranchHistory || isHistory
        ? Math.min(MAX_REASSEMBLED_FRAME_BYTES, this.reassembledFrameLimit)
        : 2 * 1024 * 1024;
    // Model catalogs are truncated before publication, while the transport still enforces
    // aggregate byte and node budgets over the complete response.
    const responseNodeLimit = isBranchHistory
      ? 4_096
      : isHistory
        ? 400_000
        : pending.command === "get_available_models"
          ? 16_384
          : 2_048;
    const violation = jsonBoundViolation(
      boundedFrame,
      responseByteLimit,
      responseItemLimit,
      MAX_IMAGE_DATA_LENGTH,
      responseNodeLimit,
    );
    if (violation) {
      this.takePending(response.data.id)?.reject(
        new OmpRpcResponseLimitError(
          rpcDiagnosticCommand(pending.command),
          violation.dimension,
          violation.actual,
          violation.limit,
        ),
      );
      return;
    }
    const settled = this.takePending(response.data.id);
    if (!settled) return;
    if (response.data.success) {
      try {
        settled.beforeResolve?.(responseData);
        if (settled.command === "prompt") {
          if (this.acceptedPromptIds.size >= MAX_PENDING_REQUESTS) {
            const oldest = this.acceptedPromptIds.values().next().value;
            if (oldest !== undefined) this.acceptedPromptIds.delete(oldest);
          }
          this.acceptedPromptIds.add(response.data.id);
        }
        settled.resolve(responseData);
      } catch {
        settled.reject(new Error("OMP RPC response is invalid"));
      }
    } else {
      const responseCode = response.data.code;
      const code: OmpRpcRequestRejectionCode | undefined =
        responseCode === "session_busy" ||
        responseCode === "stale_cursor" ||
        responseCode === "unsupported_command"
          ? responseCode
          : response.data.error === `Unknown command: ${pending.command}`
            ? "unsupported_command"
            : undefined;
      settled.reject(new OmpRpcRequestRejectedError(rpcDiagnosticCommand(pending.command), code));
    }
  }

  private emitAcceptedPromptFailure(id: string, frame: Record<string, unknown>): boolean {
    if (frame.success !== false || !this.acceptedPromptIds.delete(id)) return false;
    const error = typeof frame.error === "string" ? frame.error : undefined;
    const nativeError =
      error && utf8Bytes(error) <= MAX_RPC_ERROR_BYTES ? error : PROMPT_SCHEDULING_FAILURE;
    const code = typeof frame.code === "string" ? frame.code : undefined;
    const nativeCode = code && utf8Bytes(code) <= MAX_RPC_ERROR_CODE_BYTES ? code : undefined;
    this.emit({
      type: "prompt_error",
      id,
      error: nativeError,
      ...(nativeCode ? { code: nativeCode } : {}),
    });
    return true;
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private releaseQueuedWrite(id: string): void {
    const bytes = this.queuedWrites.get(id);
    if (bytes === undefined) return;
    this.queuedWrites.delete(id);
    this.pendingWriteBytes -= bytes;
  }

  private receiveDegradedAgentEnd(value: unknown, onlyUnsafePayload: boolean): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (frame.type !== "agent_end") return false;
    const envelope = OmpAgentEndEnvelopeSchema.safeParse(frame);
    if (!envelope.success) {
      this.fail(new Error("OMP emitted invalid terminal metadata"));
      return true;
    }
    const structuralFrame = mapRuntimeFrameDetails(frame, omitOptionalDetails);
    const messagesAreSafe =
      frame.messages === undefined ||
      (Array.isArray(frame.messages) &&
        frame.messages.length <= MAX_ARRAY_ITEMS &&
        boundedJsonBytes(
          structuralFrame.messages as unknown[],
          MAX_SEMANTIC_FRAME_BYTES,
          OMP_MAX_CONTENT_PARTS,
          MAX_IMAGE_DATA_LENGTH,
          4_096,
        ) !== Number.POSITIVE_INFINITY);
    const payloadIsSafe =
      messagesAreSafe &&
      boundedJsonBytes(
        structuralFrame,
        MAX_SEMANTIC_FRAME_BYTES,
        OMP_MAX_CONTENT_PARTS,
        MAX_IMAGE_DATA_LENGTH,
        4_096,
      ) !== Number.POSITIVE_INFINITY;
    if (onlyUnsafePayload && payloadIsSafe) return false;
    if (envelope.data.isTerminal === false) {
      this.fail(new Error("OMP emitted an invalid nonterminal agent_end payload"));
      return true;
    }
    const observedCount = Array.isArray(frame.messages)
      ? frame.messages.length
      : Object.hasOwn(frame, "messages")
        ? 1
        : undefined;
    const messageCount = Math.max(envelope.data.messageCount ?? 0, observedCount ?? 0, 1);
    this.emit({
      ...envelope.data,
      messageCount,
    });
    this.streamedBlocks.clear();
    this.commandTextLength = 0;
    return true;
  }

  private receiveFrame(frame: Record<string, unknown>, rawByteLength: number): void {
    const type = typeof frame.type === "string" && frame.type.length <= 64 ? frame.type : null;
    if (!type) {
      this.recordProtocolViolation("invalid-envelope", {
        reason: "missing-frame-type",
        field: "frame.type",
        expected: "bounded-frame-type",
        actualType: protocolDiagnosticActualType(frame.type),
        maxByteSize: rawByteLength,
      });
      return;
    }
    const safeFrame = mapRuntimeFrameDetails(frame, createOptionalMetadataSanitizer());
    if (this.receiveDegradedAgentEnd(safeFrame, true)) return;
    if (
      boundedJsonBytes(
        mapRuntimeFrameDetails(safeFrame, omitOptionalDetails),
        MAX_SEMANTIC_FRAME_BYTES,
        runtimeFrameCollectionLimit(safeFrame),
        MAX_IMAGE_DATA_LENGTH,
        4_096,
      ) === Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation("frame-limit", {
        reason: "semantic-frame-limit",
        field: "frame.byteLength",
        expected: "within-byte-limit",
        actualType: "oversized",
        maxByteSize: rawByteLength,
        limitBytes: MAX_SEMANTIC_FRAME_BYTES,
      });
      return;
    }
    if (type === "rpc_chunk") {
      const chunk = OmpChunkFrameSchema.safeParse(safeFrame);
      if (!chunk.success) {
        this.rejectChunk("chunk-schema", {
          field: "chunk",
          expected: "valid-chunk-frame",
          actualType: "object",
        });
      } else this.receiveChunk(chunk.data);
      return;
    }
    if (this.chunk) {
      this.clearChunk();
      this.recordProtocolViolation("interleaved-chunk", {
        reason: "frame-interleaved-with-chunk",
        field: "chunk.sequence",
        expected: "no-interleaved-frame",
        actualType: "interleaved",
      });
    }
    if (type === "rpc_frame_error") {
      this.recordProtocolViolation("remote-frame-error", {
        reason: "remote-frame-error",
        frameType: "rpc_frame_error",
        field: "frame",
        expected: "no-remote-frame-error",
        actualType: "remote-error",
      });
      return;
    }
    if (type === "ready") {
      if (this.readyReceived) {
        this.recordProtocolViolation("duplicate-ready", {
          reason: "ready-already-received",
          frameType: "ready",
          field: "ready",
          expected: "single-ready-frame",
          actualType: "duplicate",
        });
        return;
      }
      const ready = OmpReadyFrameSchema.safeParse(safeFrame);
      if (!ready.success) {
        this.recordProtocolViolation("invalid-ready", {
          reason: "ready-schema",
          frameType: "ready",
          field: "ready",
          expected: "valid-ready-frame",
          actualType: "object",
        });
      } else {
        this.readyReceived = true;
        this.resolveReady(ready.data);
      }
      return;
    }
    if (type === "response") {
      this.receiveResponse(safeFrame);
      return;
    }
    const event = OmpRuntimeEventSchema.safeParse(safeFrame);
    if (!event.success) {
      this.rejectMatchingToolApproval(safeFrame);
      if (type === "agent_end" && this.receiveDegradedAgentEnd(safeFrame, false)) return;
      this.recordProtocolViolation("invalid-event", {
        ...invalidEventDiagnosticMetadata(safeFrame, type),
        maxByteSize: rawByteLength,
      });
      return;
    }
    if (!this.acceptEventState(event.data)) {
      this.recordProtocolViolation("invalid-event-state", {
        reason: "event-state-transition",
        eventType: event.data.type,
        field: "event.sequence",
        expected: "valid-event-state-transition",
        actualType: "out-of-order",
        maxByteSize: rawByteLength,
      });
      return;
    }
    this.emit(event.data);
    if (event.data.type === "prompt_result" && event.data.id) {
      this.acceptedPromptIds.delete(event.data.id);
    }
    if (event.data.type === "turn_end" || event.data.type === "agent_end") {
      this.turnActive = false;
    }
    if (
      event.data.type === "message_end" ||
      event.data.type === "turn_end" ||
      event.data.type === "agent_end"
    ) {
      this.streamedBlocks.clear();
    }
    if (event.data.type === "turn_end") {
      this.commandTextLength = 0;
      this.activeToolCallIds.clear();
    }
  }

  private rejectMatchingToolApproval(frame: Record<string, unknown>): void {
    if (frame.type !== "tool_approval_request") return;
    const { id, toolCallId } = frame;
    if (!isBoundedToolApprovalId(id) || !isBoundedToolApprovalId(toolCallId)) return;
    void this.sendFrame({
      type: "tool_approval_response",
      id,
      toolCallId,
      cancelled: true,
    }).catch(() => this.fail(new Error("OMP rejected tool approval could not be canceled")));
  }

  private acceptEventState(event: z.infer<typeof OmpRuntimeEventSchema>): boolean {
    if (event.type === "turn_start") {
      this.turnActive = true;
      this.streamedBlocks.clear();
      this.commandTextLength = 0;
      this.activeToolCallIds.clear();
      return true;
    }
    if (event.type === "command_output") {
      const nextLength = this.commandTextLength + utf8Bytes(event.text ?? "");
      if (nextLength > MAX_STREAM_TEXT_LENGTH) return false;
      this.commandTextLength = nextLength;
      return true;
    }
    if (event.type === "tool_execution_start") {
      if (
        !this.activeToolCallIds.has(event.toolCallId) &&
        this.activeToolCallIds.size >= MAX_ACTIVE_TOOLS
      ) {
        return false;
      }
      this.activeToolCallIds.add(event.toolCallId);
      return true;
    }
    if (event.type === "tool_execution_update" || event.type === "tool_stream_update") {
      return this.activeToolCallIds.has(event.toolCallId);
    }
    if (event.type === "tool_execution_end") {
      if (!this.activeToolCallIds.has(event.toolCallId)) return false;
      this.activeToolCallIds.delete(event.toolCallId);
      return true;
    }
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return true;
    }
    if (event.message.role !== "assistant") return true;
    const nextBlocks =
      event.type === "message_start" ? new Map<number, string>() : new Map(this.streamedBlocks);
    const content = event.message.content;
    if (typeof content === "string") {
      nextBlocks.set(0, content);
    } else if (Array.isArray(content)) {
      for (const [index, part] of content.entries()) {
        const text =
          part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined;
        if (text !== undefined) nextBlocks.set(index, text);
      }
    }
    const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
    if (
      update?.contentIndex !== undefined &&
      update.delta !== undefined &&
      (content === undefined ||
        (Array.isArray(content) && content[update.contentIndex] === undefined))
    ) {
      const current = nextBlocks.get(update.contentIndex) ?? "";
      nextBlocks.set(update.contentIndex, `${current}${update.delta}`);
    }
    let totalLength = 0;
    for (const text of nextBlocks.values()) {
      totalLength += utf8Bytes(text);
      if (totalLength > MAX_STREAM_TEXT_LENGTH) return false;
    }
    this.streamedBlocks.clear();
    for (const [index, text] of nextBlocks) this.streamedBlocks.set(index, text);
    return true;
  }

  private protocolDiagnosticPhase(): OmpProtocolDiagnosticPhase {
    if (this.closed || this.exited || this.outputSettled) return "closing";
    if (!this.readyReceived) return "startup";
    for (const pending of this.pending.values()) {
      if (pending.command === "negotiate_protocol") return "negotiation";
      if (pending.command === "prompt") return "active-turn";
    }
    if (this.turnActive || this.acceptedPromptIds.size > 0) return "active-turn";
    return "idle";
  }

  private rejectChunk(
    reason: OmpProtocolViolationReason,
    metadata: Omit<
      OmpProtocolViolationDiagnostic,
      "category" | "reason" | "occurrenceCount" | "phase" | "frameType"
    > = {},
  ): void {
    this.clearChunk();
    this.recordProtocolViolation("invalid-chunk", {
      reason,
      frameType: "rpc_chunk",
      ...metadata,
    });
  }

  private recordProtocolViolation(
    category: OmpProtocolViolationCategory,
    metadata: Omit<OmpProtocolViolationDiagnostic, "category" | "occurrenceCount" | "phase">,
  ): void {
    const phase = this.protocolDiagnosticPhase();
    if (!this.protocolViolationTimer) {
      this.emitProtocolViolation({ category, occurrenceCount: 1, phase, ...metadata });
      this.protocolViolationTimer = setTimeout(
        () => this.flushProtocolViolations(),
        PROTOCOL_VIOLATION_COALESCE_MS,
      );
      return;
    }
    const key = `${category}:${metadata.reason}` as ProtocolViolationKey;
    const pending = this.pendingProtocolViolations.get(key);
    if (!pending) {
      this.pendingProtocolViolations.set(key, {
        category,
        occurrenceCount: 1,
        phase,
        ...metadata,
      });
      return;
    }
    pending.occurrenceCount = Math.min(Number.MAX_SAFE_INTEGER, pending.occurrenceCount + 1);
    pending.maxByteSize =
      Math.max(pending.maxByteSize ?? 0, metadata.maxByteSize ?? 0) || undefined;
    pending.reason = metadata.reason;
    pending.phase = phase;
    pending.frameType = metadata.frameType;
    pending.field = metadata.field;
    pending.expected = metadata.expected;
    pending.actualType = metadata.actualType;
    pending.limitBytes = metadata.limitBytes;
  }

  private flushProtocolViolations(): void {
    if (this.protocolViolationTimer) clearTimeout(this.protocolViolationTimer);
    this.protocolViolationTimer = null;
    for (const diagnostic of this.pendingProtocolViolations.values()) {
      this.emitProtocolViolation(diagnostic);
    }
    this.pendingProtocolViolations.clear();
  }

  private emitProtocolViolation(diagnostic: OmpProtocolViolationDiagnostic): void {
    try {
      const reporting = this.reportProtocolViolation(diagnostic);
      if (reporting) void reporting.catch(() => undefined);
    } catch {
      // Diagnostics must never alter transport flow or cleanup.
    }
  }

  private fail(error: Error): void {
    if (this.fatalError || this.closed) return;
    this.fatalError = error;
    this.rejectReady(error);
    this.failPending(error);
    this.emit({ type: "process_exit", error: error.message });
    void this.close().catch(() => undefined);
  }

  private clearChunk(): void {
    const chunk = this.chunk;
    if (chunk) clearTimeout(chunk.timer);
    this.chunk = null;
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingOneWayWrites.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.acceptedPromptIds.clear();
    this.pendingOneWayWrites.clear();
    this.queuedWrites.clear();
    this.pendingWriteBytes = 0;
  }

  private emit(event: OmpRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function validateReadyMetadata(frame: ReadyFrame): void {
  const metadata = [
    frame.protocolVersion,
    frame.supportedProtocolVersions,
    frame.maxFrameBytes,
    frame.maxReassembledFrameBytes,
  ];
  if (metadata.every((value) => value === undefined)) {
    throw new OmpPublicError("OMP provider requires OMP RPC protocol v2");
  }
  if (metadata.some((value) => value === undefined)) {
    throw new Error("OMP ready frame contains incomplete protocol metadata");
  }
  if (
    frame.protocolVersion !== 1 ||
    !frame.supportedProtocolVersions?.includes(1) ||
    !frame.maxFrameBytes ||
    frame.maxFrameBytes > MAX_PHYSICAL_FRAME_BYTES ||
    !frame.maxReassembledFrameBytes ||
    frame.maxReassembledFrameBytes > MAX_REASSEMBLED_FRAME_BYTES ||
    frame.maxReassembledFrameBytes < frame.maxFrameBytes
  ) {
    throw new Error("OMP ready frame advertises unsupported protocol limits");
  }
  if (frame.maxFrameBytes < MIN_HOST_TOOL_RESULT_FRAME_BYTES) {
    throw new Error("OMP ready frame cannot carry terminal host tool results");
  }
  if (!frame.supportedProtocolVersions.includes(2)) {
    throw new OmpPublicError("OMP provider requires OMP RPC protocol v2");
  }
}

class OmpRpcSession implements OmpRuntimeSession {
  get maxHostToolFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }
  get maxInputFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }

  constructor(
    private readonly process: OmpRpcProcess,
    private readonly removeAbortListener: () => void,
    readonly canReplayHistory: boolean,
    readonly inheritedRedactionValues: readonly string[],
    readonly supportsTypedToolApprovals: boolean,
  ) {}
  private messagePagingSupport: "unknown" | "supported" | "unsupported" = "unknown";

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    return this.process.onEvent(listener);
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.process.request({ type: "get_state" }));
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return OmpSessionStatsSchema.parse(await this.process.request({ type: "get_session_stats" }));
  }

  async getMessages(signal?: AbortSignal): Promise<OmpMessage[]> {
    if (!this.canReplayHistory) {
      throw new Error("OMP history replay requires negotiated RPC protocol v2");
    }
    if (this.messagePagingSupport === "unsupported") {
      const legacy = OmpMessagesResultSchema.parse(
        await this.requestWithSignal({ type: "get_messages" }, signal),
      );
      return legacy.messages;
    }
    let staleRestarts = 0;
    let busyRetries = 0;
    while (true) {
      const messages: OmpMessage[] = [];
      const seenCursors = new Set<string>();
      const seenMessageIdentities = new Set<string>();
      let pageCount = 0;
      let cursor: string | undefined;
      let totalMessages: number | undefined;
      let aggregateBytes = 0;
      let aggregateNodes = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          let rawPage: unknown;
          try {
            rawPage = await this.requestWithSignal(
              {
                type: "get_messages_page",
                ...(cursor ? { cursor } : {}),
                limit: OMP_MESSAGE_PAGE_LIMIT,
              },
              signal,
            );
          } catch (error) {
            if (
              error instanceof OmpRpcRequestRejectedError &&
              error.code === "unsupported_command"
            ) {
              this.messagePagingSupport = "unsupported";
              const legacy = OmpMessagesResultSchema.parse(
                await this.requestWithSignal({ type: "get_messages" }, signal),
              );
              return legacy.messages;
            }
            if (
              error instanceof OmpRpcRequestRejectedError &&
              error.code === "session_busy" &&
              busyRetries < MAX_MESSAGE_PAGE_BUSY_RETRIES
            ) {
              const delayMs = MESSAGE_PAGE_RETRY_BASE_MS * 2 ** busyRetries;
              busyRetries += 1;
              await this.waitForReplayRetry(delayMs, signal);
              continue;
            }
            throw error;
          }
          pageCount += 1;
          if (pageCount > MAX_MESSAGE_PAGES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "items",
              pageCount,
              MAX_MESSAGE_PAGES,
            );
          }
          const page = OmpMessagesPageResultSchema.parse(rawPage);
          this.messagePagingSupport = "supported";
          if (totalMessages !== undefined && page.totalMessages !== totalMessages) {
            throw new Error("OMP message pagination returned an inconsistent total");
          }
          totalMessages ??= page.totalMessages;
          const nextMessageCount = messages.length + page.messages.length;
          if (nextMessageCount > totalMessages || nextMessageCount > MAX_REPLAY_MESSAGES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "items",
              nextMessageCount,
              Math.min(totalMessages, MAX_REPLAY_MESSAGES),
            );
          }
          const pageIdentities = new Set<string>();
          for (const message of page.messages) {
            const identity = message.entryId ?? message.id ?? message.responseId;
            if (!identity) continue;
            if (seenMessageIdentities.has(identity)) {
              throw new Error("OMP message pagination repeated a message identity");
            }
            pageIdentities.add(identity);
          }
          const inspection = inspectJsonBounds(
            page.messages,
            MAX_REPLAY_BYTES,
            MAX_REPLAY_MESSAGES,
            MAX_IMAGE_DATA_LENGTH,
            MAX_REPLAY_NODES,
          );
          if (inspection.violation) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              inspection.violation.dimension,
              inspection.violation.actual,
              inspection.violation.limit,
            );
          }
          aggregateBytes += inspection.bytes;
          aggregateNodes += inspection.nodes;
          if (aggregateBytes > MAX_REPLAY_BYTES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "bytes",
              aggregateBytes,
              MAX_REPLAY_BYTES,
            );
          }
          if (aggregateNodes > MAX_REPLAY_NODES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "nodes",
              aggregateNodes,
              MAX_REPLAY_NODES,
            );
          }
          for (const identity of pageIdentities) seenMessageIdentities.add(identity);
          messages.push(...page.messages);
          const nextCursor = page.nextCursor;
          if (!nextCursor) {
            if (messages.length !== totalMessages) {
              throw new Error("OMP message pagination ended before the advertised total");
            }
            return messages;
          }
          if (page.messages.length === 0 || messages.length >= totalMessages) {
            throw new Error("OMP message pagination did not make progress");
          }
          if (seenCursors.has(nextCursor)) {
            throw new Error("OMP message pagination repeated a cursor");
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } catch (error) {
        if (
          error instanceof OmpRpcRequestRejectedError &&
          error.code === "stale_cursor" &&
          staleRestarts < MAX_MESSAGE_PAGE_STALE_RESTARTS
        ) {
          staleRestarts += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private async requestWithSignal(
    command: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const request = this.process.request(command);
    if (!signal) return request;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([request, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      void request.catch(() => undefined);
    }
  }

  private async waitForReplayRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) {
      await waitMs(delayMs);
      return;
    }
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([waitMs(delayMs), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async compact(customInstructions?: string): Promise<OmpCompactionResult> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "compaction instructions", MAX_TEXT_LENGTH);
    return OmpCompactionResultSchema.parse(
      await this.process.request(
        {
          type: "compact",
          ...(instructions ? { customInstructions: instructions } : {}),
        },
        null,
      ),
    );
  }
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.process.request({ type: "set_auto_compaction", enabled });
  }

  async getAvailableModels(): Promise<OmpModel[]> {
    const result = OmpModelsResultSchema.parse(
      await this.process.request({ type: "get_available_models" }),
    );
    if (result.models.length === 0) throw new Error("OMP reported no available models");
    return result.models;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    const safeProvider = validateBoundedText(provider, "model provider", MAX_NAME_LENGTH);
    const safeModelId = validateBoundedText(modelId, "model identifier", MAX_NAME_LENGTH);
    return OmpModelSchema.parse(
      await this.process.request({
        type: "set_model",
        provider: safeProvider,
        modelId: safeModelId,
      }),
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    const parsed = OmpThinkingLevelSchema.parse(level);
    await this.process.request({ type: "set_thinking_level", level: parsed });
  }

  async getAvailableCommands(): Promise<OmpAvailableCommand[]> {
    const result = OmpAvailableCommandsResultSchema.parse(
      await this.process.request({ type: "get_available_commands" }),
    );
    return result.commands;
  }
  async setSubagentSubscription(level: "events"): Promise<void> {
    await this.process.request({ type: "set_subagent_subscription", level });
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    return OmpSubagentsResultSchema.parse(await this.process.request({ type: "get_subagents" }))
      .subagents;
  }

  async getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult> {
    const subagentId = selector.subagentId
      ? validateBoundedText(selector.subagentId, "subagent identifier", MAX_ID_LENGTH)
      : undefined;
    const sessionFile = selector.sessionFile
      ? validateBoundedText(selector.sessionFile, "subagent transcript", MAX_PATH_LENGTH)
      : undefined;
    if ((subagentId ? 1 : 0) + (sessionFile ? 1 : 0) !== 1) {
      throw new OmpPublicError("OMP subagent history requires one transcript selector");
    }
    return OmpSubagentMessagesResultSchema.parse(
      await this.process.request({
        type: "get_subagent_messages",
        ...(subagentId ? { subagentId } : { sessionFile }),
      }),
    );
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const result = OmpBranchMessagesResultSchema.parse(
      await this.process.request({ type: "get_branch_messages" }),
    );
    return result.messages;
  }
  async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const safeEntryId = validateBoundedText(entryId, "branch entry identifier", MAX_ID_LENGTH);
    const result = OmpBranchResultSchema.safeParse(
      await this.process.request({ type: "branch", entryId: safeEntryId }),
    );
    if (!result.success) throw new Error("OMP RPC response is invalid");
    return result.data;
  }

  async setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]> {
    const safeTools = z.array(OmpHostToolDefinitionSchema).max(MAX_HOST_TOOLS).parse(tools);
    if (safeTools.length === 0) return [];
    const result = z
      .object({ toolNames: z.array(NAME).max(MAX_HOST_TOOLS).optional() })
      .parse(await this.process.request({ type: "set_host_tools", tools: safeTools }));
    return result.toolNames ?? [];
  }

  sendHostToolResult(result: OmpHostToolResult): void {
    this.process.send(result);
  }

  sendHostToolUpdate(update: OmpHostToolUpdate): void {
    this.process.send(update);
  }

  async prompt(
    message: string,
    images: readonly OmpImage[] = [],
    onAccepted?: () => void,
    onRequested?: (requestId: string) => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }> {
    const safeMessage = validateBoundedText(message, "prompt", MAX_TEXT_LENGTH);
    let acknowledgement: z.infer<typeof OmpPromptAckSchema> | undefined;
    const request = this.process.startRequest(
      { type: "prompt", message: safeMessage, ...(images.length > 0 ? { images } : {}) },
      undefined,
      (value) => {
        acknowledgement = OmpPromptAckSchema.parse(value) ?? {};
        onAccepted?.();
      },
    );
    onRequested?.(request.id);
    await request.promise;
    return { requestId: request.id, ...acknowledgement };
  }

  async steer(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "steer", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "steer",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }
  async followUp(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "follow-up", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "follow_up",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }

  async handoff(customInstructions?: string): Promise<void> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "handoff instructions", MAX_TEXT_LENGTH);
    await this.process.request({
      type: "handoff",
      ...(instructions ? { customInstructions: instructions } : {}),
    });
  }

  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void> {
    return this.process.sendFrame(response);
  }
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void> {
    return this.process.sendFrame(OmpToolApprovalResponseSchema.parse(response));
  }

  async abort(): Promise<void> {
    await this.process.request({ type: "abort", clearQueue: true, reason: "Interrupted in Paseo" });
  }

  async close(): Promise<void> {
    this.removeAbortListener();
    await this.process.close();
  }
}

export class OmpRpcRuntime implements OmpRuntime {
  readonly supportsPersistence = true;
  constructor(private readonly options: OmpRpcRuntimeOptions = {}) {}
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]> {
    return Promise.resolve(
      this.options.listSessions?.(options) ??
        listOmpSessionDescriptors(options, this.options.environment ?? process.env),
    );
  }
  async readPersistedSessionTranscript(options: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSessionMessages> {
    const transcript = await readOmpPersistedSessionTranscript(
      options.sessionFile,
      options.sessionId,
      options.cwd,
      options.signal,
      join(ompDataDir(this.options.environment ?? process.env), "blobs"),
    );
    return {
      ...transcript,
      messages: z
        .array(OmpMessageSchema)
        .max(MAX_REPLAY_MESSAGES)
        .parse(sanitizeMessageListMetadata(transcript.messages)),
    };
  }
  async readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages> {
    const transcript = await readOmpPersistedSubagentTranscript(
      options.parentSessionFile,
      options.childTranscriptId,
      options.cwd,
      options.signal,
      options.sessionFile,
    );
    return {
      ...transcript,
      messages: z
        .array(OmpMessageSchema)
        .max(MAX_REPLAY_MESSAGES)
        .parse(sanitizeMessageListMetadata(transcript.messages)),
    };
  }

  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    options.signal?.throwIfAborted();
    const effectiveOptions = {
      ...options,
      environment: options.environment ?? this.options.environment,
    };
    const process = new OmpRpcProcess(
      effectiveOptions,
      this.options.spawnProcess,
      this.options.terminateProcessTree,
      options.requestTimeoutMs ?? this.options.requestTimeoutMs,
      this.options.reportProtocolViolation,
    );
    const abort = () => void process.close().catch(() => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    const removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    try {
      const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const ready = await waitWithTimeout(
        process.ready,
        readyTimeoutMs,
        `OMP RPC did not become ready within ${readyTimeoutMs}ms`,
      );
      validateReadyMetadata(ready);
      process.applyReadyLimits(ready);
      options.signal?.throwIfAborted();
      const advertiseTypedToolApprovals = ready.features?.typedToolApprovals === 1;
      const negotiation = ProtocolNegotiationResultSchema.parse(
        await process.request({
          type: "negotiate_protocol",
          protocolVersion: 2,
          ...(advertiseTypedToolApprovals
            ? { clientCapabilities: { typedToolApprovals: 1 as const } }
            : {}),
        }),
      );
      options.signal?.throwIfAborted();
      return new OmpRpcSession(
        process,
        removeAbortListener,
        true,
        process.inheritedRedactionValues,
        advertiseTypedToolApprovals && negotiation.clientCapabilities?.typedToolApprovals === 1,
      );
    } catch (error) {
      removeAbortListener();
      const cleanup = process.close();
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure("OMP runtime startup cleanup failed", cleanup);
      }
      throw error;
    }
  }
}
