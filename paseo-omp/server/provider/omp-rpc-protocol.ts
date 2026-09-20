import { z } from "zod";
import { isValidImagePayload } from "./image";
import { MAX_ID_LENGTH, MAX_NAME_LENGTH, MAX_PATH_LENGTH, MAX_TEXT_LENGTH } from "./omp-rpc-values";
import { boundedJsonBytes, boundedJsonMetrics, utf8Bytes } from "./security";

export const OMP_MAX_CONTENT_PARTS = 4_096;

export const MAX_CHUNK_BYTES = 256 * 1024;
export const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
export const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_SEMANTIC_FRAME_BYTES = 12 * 1024 * 1024;
export const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;
export const MAX_CONFIG_EVENT_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
export const MAX_TOOL_PAYLOAD_LENGTH = 256 * 1024;
export const MAX_TOOL_APPROVAL_FRAME_BYTES = 64 * 1024;
export const MAX_TOOL_APPROVAL_STRING_BYTES = 8 * 1024;
export const MAX_TOOL_APPROVAL_COLLECTION_ITEMS = 32;
export const MAX_TOOL_APPROVAL_INPUT_NODES = 256;
export const MAX_TOOL_APPROVAL_DEPTH = 4;
export const MAX_TOOL_APPROVAL_ID_BYTES = 512;
export const MAX_TOOL_APPROVAL_NAME_BYTES = 256;
export const MAX_TOOL_APPROVAL_DETAIL_LINES = 16;
export const MAX_TOOL_APPROVAL_DETAIL_BYTES = 2 * 1024;
export const MAX_TOOL_APPROVAL_METADATA_FIELDS = 33;
export const MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES = 64;
export const MAX_TOOL_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_TOOL_APPROVAL_PATH_BYTES = 4 * 1024;
export const MAX_TOOL_APPROVAL_CONTENT_BYTES = 20 * 1024;
export const MAX_ARRAY_ITEMS = 512;
export const MAX_OPTIONAL_METADATA_BYTES = MAX_TOOL_PAYLOAD_LENGTH;
export const MAX_OPTIONAL_METADATA_ITEMS = 2_048;
export const MAX_OPTIONAL_METADATA_NODES = 4_096;
export const MAX_TASK_CORRELATION_BYTES = 256 * 1024;
export const MAX_TASK_CORRELATION_ITEMS = 1_024;
export const MAX_TASK_CORRELATION_NODES = 4_096;
export const MAX_MODEL_CATALOG_ITEMS = 4_096;
export const MAX_TODOS = 256;
export const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
export const MAX_COST_USD = 1_000_000_000;
export const MAX_RPC_ERROR_BYTES = 4_096;
export const MAX_RPC_ERROR_CODE_BYTES = 256;
export const MAX_REPLAY_MESSAGES = 100_000;
export const OMP_MESSAGE_PAGE_LIMIT = 256;

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

export function protocolDiagnosticActualType(value: unknown): OmpProtocolDiagnosticActualType {
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

export function invalidEventDiagnosticMetadata(
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

export type PendingProtocolViolation = Omit<OmpProtocolViolationDiagnostic, "occurrenceCount"> & {
  occurrenceCount: number;
};
export type ProtocolViolationKey = `${OmpProtocolViolationCategory}:${OmpProtocolViolationReason}`;
const MAX_CONTEXT_PERCENT = 1_000_000;
function boundedJsonString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
    return bytes >= minBytes && bytes <= maxBytes;
  });
}
export function isBoundedToolApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

export const OMP_HOST_TOOL_FRAME_LIMIT_ERROR =
  "MCP host tool result exceeds the OMP RPC frame limit";
export const MIN_HOST_TOOL_RESULT_FRAME_BYTES = Buffer.byteLength(
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
export const NAME = boundedString(MAX_NAME_LENGTH, 1);
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

export function sanitizeLiveDisplayFrame(value: unknown): unknown {
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

export function rpcDiagnosticCommand(value: string): OmpRpcDiagnosticCommand | undefined {
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

export function inspectJsonBounds(
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

export function jsonBoundViolation(
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

export function omitOptionalDetails(value: unknown, preserveTaskCorrelation = false): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "details")) return value;
  const { details: _details, ...structural } = record;
  if (!preserveTaskCorrelation) return structural;
  const correlation = taskCorrelationDetails(record.details);
  return correlation === undefined ? structural : { ...structural, details: correlation };
}

export function createOptionalMetadataSanitizer(): (
  value: unknown,
  taskResult?: boolean,
) => unknown {
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

export const OmpMessageSchema = z.discriminatedUnion("role", [
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
export const OmpModelSchema = z.object({
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
export const OmpSessionStatsSchema = z.object({
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
export const OmpCompactionResultSchema = z.object({
  tokensBefore: OptionalTokenCountSchema,
  preTokens: OptionalTokenCountSchema,
});
export const OmpSessionStateSchema = z.object({
  model: OmpModelSchema.nullable().optional(),
  thinkingLevel: OmpCurrentThinkingLevelSchema,
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  sessionId: IDENTIFIER,
  autoCompactionEnabled: z.boolean().optional(),
  contextUsage: OmpContextUsageSchema.nullable().optional().catch(undefined),
  sessionFile: boundedString(MAX_PATH_LENGTH).optional().catch(undefined),
});
export const OmpReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number().int().positive().max(16).optional(),
  supportedProtocolVersions: z.array(z.number().int().positive().max(16)).max(8).optional(),
  maxFrameBytes: z.number().int().positive().optional(),
  maxReassembledFrameBytes: z.number().int().positive().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});
export const OmpResponseFrameSchema = z.object({
  type: z.literal("response"),
  id: IDENTIFIER,
  command: boundedString(64, 1).optional(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: boundedString(MAX_RPC_ERROR_BYTES).optional(),
  code: boundedString(MAX_RPC_ERROR_CODE_BYTES, 1).optional(),
});
export const OmpChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: IDENTIFIER,
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(MAX_CHUNK_COUNT),
  byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
  data: boundedString(MAX_ENCODED_CHUNK_BYTES),
});
export const JsonObjectSchema = z.record(z.string(), z.unknown());
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
export const OmpHostToolDefinitionSchema = z.object({
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
export const OmpHostToolResultSchema = z.object({
  type: z.literal("host_tool_result"),
  id: IDENTIFIER,
  result: OmpHostToolAgentResultSchema,
  isError: z.boolean().optional(),
});
export const OmpHostToolUpdateSchema = z.object({
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
export const OmpToolApprovalResponseSchema = z.union([
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
export const OmpAgentEndEnvelopeSchema = z.object({
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
export const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
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

export function mapRuntimeFrameDetails(
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

export function sanitizeMessageListMetadata(value: unknown): unknown {
  return mapMessageList(value, createOptionalMetadataSanitizer());
}

export function sanitizeHistoryResponseData(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return mapRecordField(value as Record<string, unknown>, "messages", sanitizeMessageListMetadata);
}

export function projectSessionStateResponseData(value: unknown): unknown {
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

export function runtimeFrameCollectionLimit(frame: Record<string, unknown>): number {
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
export const OmpModelsResultSchema = z.object({
  models: z.array(OmpModelSchema).min(1).max(MAX_MODEL_CATALOG_ITEMS),
});
export const OmpPromptAckSchema = z.object({ agentInvoked: z.boolean().optional() }).optional();
export const OmpAvailableCommandsResultSchema = z.object({
  commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
});
export const OmpBranchMessagesResultSchema = z.object({
  messages: z.array(z.object({ entryId: IDENTIFIER, text: TEXT })).max(1_024),
});
export const OmpBranchResultSchema = z.object({ text: TEXT, cancelled: z.boolean() });
export const OmpMessagesResultSchema = z.object({
  messages: z.array(OmpMessageSchema).max(MAX_REPLAY_MESSAGES),
});
export const OmpMessagesPageResultSchema = z.object({
  messages: z.array(OmpMessageSchema).max(OMP_MESSAGE_PAGE_LIMIT),
  nextCursor: boundedString(2_048, 1).refine(isSafeOpaqueCursor).optional(),
  totalMessages: z.number().int().nonnegative().max(MAX_REPLAY_MESSAGES),
});
export const OmpSubagentsResultSchema = z.object({
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
export const OmpSubagentMessagesResultSchema = z.object({
  sessionFile: boundedString(MAX_PATH_LENGTH),
  fromByte: z.number().int().nonnegative(),
  nextByte: z.number().int().nonnegative(),
  reset: z.boolean(),
  messages: z.array(OmpMessageSchema).max(MAX_REPLAY_MESSAGES),
});
export const ProtocolNegotiationResultSchema = z.object({
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
