import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  boundedJsonBytes,
  OmpCleanupFailure,
  OmpPublicDataFilter,
  OmpPublicError,
  utf8Bytes,
} from "./security";

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 750;
const CHUNK_STALE_MS = 30_000;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_MODEL_SELECTOR_BYTES = MAX_NAME_LENGTH * 2 + 1;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_LENGTH = 64 * 1024;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const MAX_TOOL_PAYLOAD_LENGTH = 256 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_PARTS = 4_096;
const MAX_ARRAY_ITEMS = 512;
const MAX_CONTENT_PARTS = 64;
const MAX_TODOS = 256;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_LENGTH = 64 * 1024;
const MAX_MCP_CONFIG_BYTES = 256 * 1024;
const MAX_ENV_TOTAL_LENGTH = 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";

function boundedString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = utf8Bytes(value);
    return bytes >= minBytes && bytes <= maxBytes;
  });
}

const IDENTIFIER = boundedString(MAX_ID_LENGTH, 1);
const NAME = boundedString(MAX_NAME_LENGTH, 1);
const OMP_PROVIDER_NAME = NAME.refine((provider) => !provider.includes("/"));
const TEXT = boundedString(MAX_TEXT_LENGTH);
const OmpThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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

const OmpContentPartSchema = z
  .object({
    type: NAME,
    text: TEXT.optional(),
    thinking: TEXT.optional(),
    data: boundedString(MAX_IMAGE_DATA_LENGTH).optional(),
    mimeType: boundedString(128).optional(),
  })
  .superRefine((part, context) => {
    if (part.type !== "image") return;
    if (
      part.data === undefined ||
      part.data.length === 0 ||
      part.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(part.data) ||
      !/^image\/(?:gif|jpeg|png|webp)$/u.test(part.mimeType ?? "")
    ) {
      context.addIssue({ code: "custom", message: "invalid image payload" });
    }
  });
const OmpAssistantMessageEventSchema = z
  .object({
    type: NAME,
    contentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CONTENT_PARTS - 1)
      .optional(),
    delta: TEXT.optional(),
    content: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_IMAGE_DATA_LENGTH + 1_024))
      .optional(),
  })
  .superRefine((event, context) => {
    if (!event.type.startsWith("image_")) return;
    const image = OmpContentPartSchema.safeParse(event.content);
    if (!image.success || image.data.type !== "image") {
      context.addIssue({ code: "custom", message: "invalid image event" });
    }
  });
const OmpMessageSchema = z.object({
  role: boundedString(32, 1),
  content: z.union([TEXT, z.array(OmpContentPartSchema).max(MAX_CONTENT_PARTS)]).optional(),
  id: IDENTIFIER.optional(),
  entryId: IDENTIFIER.optional(),
  responseId: IDENTIFIER.optional(),
  errorMessage: boundedString(4_096).nullable().optional(),
  stopReason: boundedString(64).optional(),
});
const OmpAvailableCommandSchema = z.object({
  name: NAME,
  aliases: z.array(NAME).max(32).optional(),
});
const OmpModelSchema = z.object({
  provider: OMP_PROVIDER_NAME,
  id: NAME,
  name: boundedString(MAX_NAME_LENGTH).optional(),
  reasoning: z.boolean().optional(),
  thinking: z
    .object({
      efforts: z.array(boundedString(32)).max(16).optional(),
      defaultLevel: boundedString(32).optional(),
    })
    .optional(),
  contextWindow: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
});
const OmpSessionStateSchema = z.object({
  model: OmpModelSchema.nullable().optional(),
  thinkingLevel: OmpThinkingLevelSchema.optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  sessionId: IDENTIFIER,
});
const OmpReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number().int().positive().max(16).optional(),
  supportedProtocolVersions: z.array(z.number().int().positive().max(16)).max(8).optional(),
  maxFrameBytes: z.number().int().positive().optional(),
  maxReassembledFrameBytes: z.number().int().positive().optional(),
});
const OmpResponseFrameSchema = z.object({
  type: z.literal("response"),
  id: IDENTIFIER,
  success: z.boolean(),
  data: z.unknown().optional(),
  error: boundedString(4_096).optional(),
});
const OmpChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: IDENTIFIER,
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(MAX_CHUNK_COUNT),
  byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
  data: boundedString(MAX_ENCODED_CHUNK_BYTES),
});
const BoundedToolPayloadSchema = z
  .unknown()
  .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 4_096));
const OmpAgentEndEnvelopeSchema = z.object({
  type: z.literal("agent_end"),
  messageCount: z.number().int().nonnegative().optional(),
  isTerminal: z.boolean().optional(),
});
const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({
    type: z.literal("agent_end"),
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
    partialResult: BoundedToolPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    result: BoundedToolPayloadSchema,
    isError: z.boolean().optional(),
  }),
  z.object({
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
  }),
  z.object({
    type: z.literal("available_commands_update"),
    commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
  }),
  z.object({
    type: z.literal("notice"),
    id: IDENTIFIER.optional(),
    level: z.enum(["info", "warning", "error"]),
    message: boundedString(64 * 1024),
    source: boundedString(MAX_NAME_LENGTH).optional(),
  }),
  z.object({ type: z.literal("command_output"), text: TEXT.optional() }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: IDENTIFIER,
    method: boundedString(64, 1),
    title: boundedString(4_096).optional(),
    message: boundedString(64 * 1024).optional(),
    notifyType: z.enum(["info", "warning", "error"]).optional(),
  }),
  z.object({
    type: z.literal("prompt_result"),
    id: IDENTIFIER.optional(),
    agentInvoked: z.boolean(),
  }),
]);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const OmpModelsResultSchema = z.object({
  models: z.array(OmpModelSchema).min(1).max(256),
});
const OmpPromptAckSchema = z.object({ agentInvoked: z.boolean().optional() }).optional();
const OmpAvailableCommandsResultSchema = z.object({
  commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
});
const OmpBranchMessagesResultSchema = z.object({
  messages: z.array(z.object({ entryId: IDENTIFIER, text: TEXT })).max(1_024),
});
const ProtocolNegotiationResultSchema = z.object({ protocolVersion: z.literal(2) });

export type OmpMessage = z.infer<typeof OmpMessageSchema>;
export type OmpModel = z.infer<typeof OmpModelSchema>;
export type OmpSessionState = z.infer<typeof OmpSessionStateSchema>;
export type OmpRpcEvent =
  | z.infer<typeof OmpRuntimeEventSchema>
  | { type: "process_exit"; error: string };

export interface OmpStartOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Server-owned environment source; tests provide isolated roots instead of ambient process.env. */
  environment?: NodeJS.ProcessEnv;
  model?: string;
  mode?: "full";
  thinkingOption?: string;
  systemPrompt?: string;
  /** Resume this exact native OMP session; never use this to start a new conversation. */
  resumeSessionId?: string;
  noSession?: boolean;
  signal?: AbortSignal;
}

export interface OmpRuntimeSession {
  readonly redactionValues?: readonly string[];
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  getState(): Promise<OmpSessionState>;
  getAvailableModels(): Promise<OmpModel[]>;
  getAvailableCommands(): Promise<Array<{ name: string; aliases?: string[] }>>;
  prompt(message: string): Promise<{ requestId: string; agentInvoked?: boolean }>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: string): Promise<void>;
  steer(message: string): Promise<void>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface OmpRuntime {
  startSession(options: OmpStartOptions): Promise<OmpRuntimeSession>;
}

export interface OmpSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  sensitiveValues: string[];
}

export interface OmpRpcRuntimeOptions {
  spawnProcess?: (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number) => Promise<boolean | "uncertain">;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  command: string;
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
  timer: NodeJS.Timeout;
};

// The daemon contributes only process/runtime discovery variables plus provider authentication
// families. Session-scoped values are explicit host input and are overlaid after rejecting loader
// and executable-resolution controls; this keeps provider credentials available without copying
const INHERITED_RUNTIME_ENV: Readonly<Record<string, true>> = {
  ALL_PROXY: true,
  APPDATA: true,
  COLORTERM: true,
  HOME: true,
  HTTPS_PROXY: true,
  HTTP_PROXY: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NO_PROXY: true,
  OMP_PROFILE: true,
  PATH: true,
  PATHEXT: true,
  PI_CODING_AGENT_DIR: true,
  PI_CONFIG_DIR: true,
  PI_PROFILE: true,
  SHELL: true,
  SSH_AUTH_SOCK: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SYSTEMROOT: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  TZ: true,
  USER: true,
  USERPROFILE: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_RUNTIME_DIR: true,
};
const INHERITED_PROVIDER_AUTH_ENV: Readonly<Record<string, true>> = {
  ANTHROPIC_API_KEY: true,
  AWS_ACCESS_KEY_ID: true,
  AWS_DEFAULT_REGION: true,
  AWS_PROFILE: true,
  AWS_REGION: true,
  AWS_SECRET_ACCESS_KEY: true,
  AWS_SESSION_TOKEN: true,
  AZURE_CLIENT_ID: true,
  AZURE_CLIENT_SECRET: true,
  AZURE_OPENAI_API_KEY: true,
  AZURE_OPENAI_ENDPOINT: true,
  AZURE_TENANT_ID: true,
  COHERE_API_KEY: true,
  DEEPSEEK_API_KEY: true,
  FIREWORKS_API_KEY: true,
  GEMINI_API_KEY: true,
  GOOGLE_API_KEY: true,
  GOOGLE_APPLICATION_CREDENTIALS: true,
  GROQ_API_KEY: true,
  MISTRAL_API_KEY: true,
  OLLAMA_HOST: true,
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_AUTH_BROKER_URL: true,
  OPENAI_API_KEY: true,
  OPENROUTER_API_KEY: true,
  TOGETHER_API_KEY: true,
  XAI_API_KEY: true,
};
const BLOCKED_SESSION_ENV =
  /^(?:BASH_ENV|BUN_INSTALL.*|BUN_OPTIONS|CLASSPATH|CLAUDE_BASH_NO_CI|CLAUDE_BASH_NO_LOGIN|CLAUDE_CODE_SHELL_PREFIX|DYLD_.*|EDITOR|ELECTRON_RUN_AS_NODE|ENV|GEM_HOME|GEM_PATH|GIT_CONFIG.*|GIT_SSH_COMMAND|HOME|JAVA_TOOL_OPTIONS|LD_.*|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*|OMP_AUTORESEARCH_DB_DIR|OMP_COMMAND|OMP_GITHUB_CACHE_DB|OMP_PROFILE|OMP_WORKTREE_DIR|PATH|PATHEXT|PERL5LIB|PERL5OPT|PI_BASH_NO_CI|PI_BASH_NO_LOGIN|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_CONFIG_FILES|PI_GIT_COMMON_DIR|PI_PACKAGE_DIR|PI_PROFILE|PI_PROJECT_DIR|PI_SESSION_ID|PI_SHELL_PREFIX|PI_SUBPROCESS_CMD|PI_WORKTREE_DIR|PWD|PYTHONHOME|PYTHONINSPECT|PYTHONPATH|PYTHONSTARTUP|RUBYLIB|RUBYOPT|SHELL|SYSTEMROOT|USERPROFILE|VISUAL|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|_JAVA_OPTIONS)$/u;
const SESSION_CREDENTIAL_ENV =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|AUTH|AUTHORIZATION|COOKIE|CREDENTIALS|OAUTH|PASSWORD|PRIVATE_KEY|SECRET|SESSION_TOKEN|TOKEN)(?:$|_)/iu;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
function collectUrlComponents(
  value: string,
  isCredentialKey: (key: string) => boolean,
  collect: (component: string, required: boolean) => void,
  invalidMessage: string,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const collectRawAndDecoded = (raw: string, required: boolean, queryEncoded = false) => {
    if (!raw) return;
    collect(raw, required);
    const decoded = decodeURIComponent(queryEncoded ? raw.replace(/\+/gu, " ") : raw);
    if (decoded !== raw) collect(decoded, required);
  };
  try {
    collectRawAndDecoded(url.username, true);
    collectRawAndDecoded(url.password, true);
    for (const segment of url.pathname.split("/")) {
      collectRawAndDecoded(segment, false);
    }
    for (const field of url.search.slice(1).split("&")) {
      if (!field) continue;
      const separator = field.indexOf("=");
      const rawName = separator < 0 ? field : field.slice(0, separator);
      const rawValue = separator < 0 ? "" : field.slice(separator + 1);
      const name = decodeURIComponent(rawName.replace(/\+/gu, " "));
      collectRawAndDecoded(rawValue, isCredentialKey(name), true);
    }
    const fragment = url.hash.slice(1);
    collectRawAndDecoded(fragment, false);
    for (const field of fragment.split(/[&/]/u)) {
      if (!field) continue;
      const separator = field.indexOf("=");
      if (separator < 0) {
        collectRawAndDecoded(field, false);
        continue;
      }
      const rawName = field.slice(0, separator);
      const rawValue = field.slice(separator + 1);
      const name = decodeURIComponent(rawName);
      collectRawAndDecoded(rawValue, isCredentialKey(name));
    }
  } catch (error) {
    if (error instanceof OmpPublicError) throw error;
    throw new OmpPublicError(invalidMessage);
  }
}

function validateBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) === 0 ||
    utf8Bytes(value) > maxBytes ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid OMP ${field}`);
  }
  return value;
}

function buildOmpEnvironment(
  sessionEnv: Readonly<Record<string, string>> | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; sensitiveValues: string[] } {
  if (
    sessionEnv !== undefined &&
    (sessionEnv === null || typeof sessionEnv !== "object" || Array.isArray(sessionEnv))
  ) {
    throw new Error("OMP session environment is invalid");
  }
  const env: NodeJS.ProcessEnv = {};
  const sensitiveValues: string[] = [];
  let totalBytes = 0;
  const collectProxyCredentials = (value: string) => {
    if (utf8Bytes(value) >= 4) sensitiveValues.push(value);
    const collectComponent = (component: string, required: boolean) => {
      if (!component) return;
      if (utf8Bytes(component) < 4) {
        if (required) {
          throw new OmpPublicError("OMP proxy credential is too short for safe redaction");
        }
        return;
      }
      sensitiveValues.push(component);
    };
    collectUrlComponents(
      value,
      (key) => SESSION_CREDENTIAL_ENV.test(key),
      collectComponent,
      "OMP proxy URL components cannot be decoded safely",
    );
  };
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined || name.toUpperCase() === "OMP_COMMAND") continue;
    const normalizedName = name.toUpperCase();
    const isRuntime = normalizedName in INHERITED_RUNTIME_ENV;
    const isProviderAuth = normalizedName in INHERITED_PROVIDER_AUTH_ENV;
    if (!isRuntime && !isProviderAuth) continue;
    const valueBytes = utf8Bytes(value);
    if (!ENV_NAME.test(name) || valueBytes > MAX_ENV_VALUE_LENGTH || value.includes("\0")) continue;
    if (isProviderAuth && valueBytes > 0 && valueBytes < 4) {
      throw new Error("OMP provider credential is too short for safe redaction");
    }
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH)
      throw new Error("OMP inherited environment is too large");
    env[name] = value;
    if (isProviderAuth && value.length > 0) sensitiveValues.push(value);
    if (
      isRuntime &&
      (normalizedName === "HTTP_PROXY" ||
        normalizedName === "HTTPS_PROXY" ||
        normalizedName === "ALL_PROXY") &&
      value.length > 0
    ) {
      collectProxyCredentials(value);
    }
  }
  let entryCount = 0;
  for (const name in sessionEnv ?? {}) {
    if (!Object.hasOwn(sessionEnv ?? {}, name)) continue;
    entryCount += 1;
    if (entryCount > MAX_ENV_ENTRIES)
      throw new Error("OMP session environment has too many entries");
    const value = (sessionEnv as Readonly<Record<string, string>>)[name];
    const normalizedName = name.toUpperCase();
    if (!ENV_NAME.test(name) || BLOCKED_SESSION_ENV.test(normalizedName)) {
      throw new Error("OMP session environment contains a forbidden variable");
    }
    if (
      typeof value !== "string" ||
      utf8Bytes(value) > MAX_ENV_VALUE_LENGTH ||
      value.includes("\0")
    ) {
      throw new Error("OMP session environment contains an invalid value");
    }
    const valueBytes = utf8Bytes(value);
    const isCredential =
      normalizedName in INHERITED_PROVIDER_AUTH_ENV || SESSION_CREDENTIAL_ENV.test(normalizedName);
    if (valueBytes > 0 && valueBytes < 4 && isCredential) {
      throw new OmpPublicError("OMP session credential is too short for safe redaction");
    }
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH) throw new Error("OMP session environment is too large");
    env[name] = value;
    const isProxy =
      normalizedName === "HTTP_PROXY" ||
      normalizedName === "HTTPS_PROXY" ||
      normalizedName === "ALL_PROXY";
    if (isProxy && value.length > 0) collectProxyCredentials(value);
    else if (valueBytes >= 4) sensitiveValues.push(value);
  }
  return { env, sensitiveValues };
}

export interface OmpMcpFileOps {
  open(path: string, flags: number): number;
  stat(descriptor: number): { size: number; isFile(): boolean };
  read(
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  close(descriptor: number): void;
}

const DEFAULT_MCP_FILE_OPS: OmpMcpFileOps = {
  open: (path, flags) => openSync(path, flags),
  stat: (descriptor) => fstatSync(descriptor),
  read: (descriptor, buffer, offset, length, position) =>
    readSync(descriptor, buffer, offset, length, position),
  close: (descriptor) => closeSync(descriptor),
};

export function collectAmbientMcpSecrets(
  cwd: string,
  env: NodeJS.ProcessEnv,
  fileOps: OmpMcpFileOps = DEFAULT_MCP_FILE_OPS,
): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, env.PI_CONFIG_DIR ?? ".omp", "agent");
  const paths = [join(agentDir, "mcp.json"), join(cwd, env.PI_CONFIG_DIR ?? ".omp", "mcp.json")];
  const secrets: string[] = [];
  const credentialKey =
    /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|OAUTH|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SESSION_TOKEN|TOKEN)(?:$|_)/u;
  const isCredentialKey = (key: string) =>
    credentialKey.test(
      key
        .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
        .replace(/[^A-Za-z0-9]+/gu, "_")
        .toUpperCase(),
    );
  const collectCredential = (value: string) => {
    if (value.length === 0) return;
    if (utf8Bytes(value) < 4) {
      throw new OmpPublicError("OMP MCP credential is too short for safe redaction");
    }
    secrets.push(value);
  };
  const collectContainer = (root: unknown, kind: "auth" | "env" | "headers" | "oauth") => {
    const stack: Array<{ value: unknown; sensitive: boolean }> = [
      { value: root, sensitive: kind === "auth" || kind === "oauth" },
    ];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      if (typeof current.value === "string") {
        if (current.sensitive || utf8Bytes(current.value) >= 4) {
          collectCredential(current.value);
        }
        continue;
      }
      if (Array.isArray(current.value)) {
        if (current.value.length > MAX_ARRAY_ITEMS) {
          throw new OmpPublicError("OMP MCP configuration exceeds safe limits");
        }
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: current.value[index], sensitive: current.sensitive });
        }
        continue;
      }
      if (!current.value || typeof current.value !== "object") continue;
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        const sensitive = current.sensitive || isCredentialKey(key);
        stack.push({
          value: (current.value as Record<string, unknown>)[key],
          sensitive,
        });
      }
    }
  };
  const collectUrlSecrets = (value: string) => {
    if (utf8Bytes(value) >= 4) secrets.push(value);
    collectUrlComponents(
      value,
      isCredentialKey,
      (component, required) => {
        if (utf8Bytes(component) >= 4 || required) collectCredential(component);
      },
      "OMP MCP URL components cannot be decoded safely",
    );
  };
  for (const path of paths) {
    let descriptor: number;
    try {
      descriptor = fileOps.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR") continue;
      throw new OmpPublicError("OMP MCP configuration cannot be read safely");
    }
    let raw: string;
    try {
      const stats = fileOps.stat(descriptor);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_MCP_CONFIG_BYTES) {
        throw new OmpPublicError("OMP MCP configuration exceeds safe limits");
      }
      const buffer = Buffer.allocUnsafe(MAX_MCP_CONFIG_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead <= MAX_MCP_CONFIG_BYTES) {
        const count = fileOps.read(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead > MAX_MCP_CONFIG_BYTES) {
        throw new OmpPublicError("OMP MCP configuration exceeds safe limits");
      }
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fileOps.close(descriptor);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      boundedJsonBytes(parsed, MAX_MCP_CONFIG_BYTES, MAX_ARRAY_ITEMS) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("OMP MCP configuration exceeds safe limits");
    }
    if (!parsed || typeof parsed !== "object") continue;
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const child = (value as Record<string, unknown>)[key];
        const normalized = key.toLowerCase();
        if (normalized === "url" && typeof child === "string") {
          collectUrlSecrets(child);
        } else if (
          normalized === "auth" ||
          normalized === "env" ||
          normalized === "headers" ||
          normalized === "oauth"
        ) {
          collectContainer(child, normalized);
        } else if (child && typeof child === "object") {
          stack.push(child);
        }
      }
    }
  }
  return secrets;
}

export function buildOmpSpawnRequest(
  options: OmpStartOptions,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): OmpSpawnRequest {
  const environmentSource = options.environment ?? sourceEnv;
  const cwd = validateBoundedText(options.cwd, "working directory", MAX_PATH_LENGTH);
  if (!isAbsolute(cwd)) throw new Error("OMP working directory must be absolute");
  const command = validateBoundedText(
    environmentSource.OMP_COMMAND ?? "omp",
    "command",
    MAX_PATH_LENGTH,
  );
  if (/[\r\n]/u.test(command)) throw new Error("Invalid OMP command");
  if (options.mode !== undefined && options.mode !== "full") throw new Error("Invalid OMP mode");
  if (options.noSession !== undefined && typeof options.noSession !== "boolean") {
    throw new Error("Invalid OMP no-session option");
  }
  const args = ["--mode", "rpc-ui", "--approval-mode", "yolo"];
  if (options.model !== undefined) {
    args.push("--model", validateBoundedText(options.model, "model", MAX_MODEL_SELECTOR_BYTES));
  }
  if (options.thinkingOption !== undefined) {
    const thinking = OmpThinkingLevelSchema.safeParse(options.thinkingOption);
    if (!thinking.success) throw new Error("Invalid OMP thinking option");
    args.push("--thinking", thinking.data);
  }
  if (options.resumeSessionId !== undefined) {
    args.push(
      "--resume",
      validateBoundedText(options.resumeSessionId, "resume session identifier", MAX_ID_LENGTH),
    );
  }
  if (options.noSession) args.push("--no-session");
  const systemPrompt = options.systemPrompt?.trim();
  if (systemPrompt) {
    args.push(
      "--append-system-prompt",
      validateBoundedText(systemPrompt, "system prompt", MAX_SYSTEM_PROMPT_LENGTH),
    );
  }
  const environment = buildOmpEnvironment(options.env, environmentSource);
  const sensitiveValues = [
    ...environment.sensitiveValues,
    ...collectAmbientMcpSecrets(cwd, environment.env),
  ];
  new OmpPublicDataFilter(sensitiveValues);
  return {
    command,
    args,
    cwd,
    env: environment.env,
    detached: process.platform !== "win32",
    sensitiveValues,
  };
}

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

function waitMs(ms: number): Promise<void> {
  const result = Promise.withResolvers<void>();
  setTimeout(result.resolve, ms);
  return result.promise;
}

function processIsGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

/**
 * Terminates the detached process group created for OMP. This covers descendants that remain in
 * that group after the leader exits; descendants that deliberately re-parent into another process
 * group are outside this transport's containment boundary.
 */
export async function terminatePosixProcessTree(
  pid: number,
  graceMs: number,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
  wait: (ms: number) => Promise<void> = waitMs,
): Promise<boolean> {
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGTERM");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGKILL");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
    return false;
  } catch (error) {
    return processIsGone(error);
  }
}

type ProcessTreeCleanup = "verified" | "uncertain" | "failed";

async function stopWindowsTree(pid: number): Promise<ProcessTreeCleanup> {
  const result = Promise.withResolvers<ProcessTreeCleanup>();
  const systemRoot = process.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT;
  let taskkill: ChildProcessWithoutNullStreams;
  try {
    taskkill = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { SystemRoot: systemRoot },
      },
    );
  } catch {
    return "failed";
  }
  taskkill.stdout.resume();
  taskkill.stderr.resume();
  let settled = false;
  let deadline: NodeJS.Timeout | undefined;
  let finalDeadline: NodeJS.Timeout | undefined;
  const finish = (outcome: ProcessTreeCleanup) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(finalDeadline);
    result.resolve(outcome);
  };
  deadline = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finalDeadline = setTimeout(() => finish("failed"), PROCESS_STOP_TIMEOUT_MS);
  }, PROCESS_STOP_TIMEOUT_MS);
  taskkill.once("error", () => finish("failed"));
  taskkill.once("close", (code, signal) => {
    finish(
      code === 0 && signal === null
        ? "verified"
        : code === 128 && signal === null
          ? "uncertain"
          : "failed",
    );
  });
  return result.promise;
}

class OmpRpcProcess {
  readonly ready: Promise<ReadyFrame>;
  readonly redactionValues: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queuedWrites = new Map<string, number>();
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
  private readyReceived = false;
  private outputSettled = false;

  constructor(
    options: OmpStartOptions,
    spawnProcess?: OmpRpcRuntimeOptions["spawnProcess"],
    terminateProcessTree?: OmpRpcRuntimeOptions["terminateProcessTree"],
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const ready = Promise.withResolvers<ReadyFrame>();
    this.rejectReady = ready.reject;
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    const request = buildOmpSpawnRequest(options);
    this.redactionValues = request.sensitiveValues;
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
    if (this.lineBytes > 0 || this.discardingLine) this.recordProtocolViolation();
    this.lineParts = [];
    this.lineBytes = 0;
    this.discardingLine = false;
    this.discardedLineBytes = 0;
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
    timeoutMs = this.requestTimeoutMs,
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
    const timer = setTimeout(() => {
      this.pending.delete(id);
      result.reject(new Error("OMP RPC request timed out"));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: result.resolve,
      reject: result.reject,
      timer,
      command: typeof command.type === "string" ? command.type : "unknown",
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

  request(command: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    this.closed = true;
    this.clearChunk();
    this.failPending(new Error("OMP RPC process was closed"));
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        // Continue to process-tree cleanup when the input channel is already closed.
      }
    }
    const cleanupPromise = this.startTreeCleanup();
    const cleanup = await cleanupPromise;
    if (cleanup !== "verified") throw new Error("OMP RPC process tree cleanup failed");
    if (!this.exited && !(await this.waitForExit(PROCESS_STOP_TIMEOUT_MS))) {
      throw new Error("OMP RPC process did not close after tree cleanup");
    }
  }

  private startTreeCleanup(): Promise<ProcessTreeCleanup> {
    if (this.treeCleanupPromise) return this.treeCleanupPromise;
    const pid = this.child.pid;
    this.treeCleanupPromise = (
      pid === undefined
        ? Promise.resolve<ProcessTreeCleanup>("uncertain")
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
        if (this.discardingLine) this.resetDiscardedLine();
        else this.completeLine();
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
      this.recordProtocolViolation();
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
    if (payload.byteLength > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveKnownResponse(decoded)) return;
    if (this.receiveDegradedAgentEnd(decoded, true)) return;
    if (
      boundedJsonBytes(decoded, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) ===
      Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    const frame = JsonObjectSchema.safeParse(decoded);
    if (!frame.success) {
      this.recordProtocolViolation();
      return;
    }
    this.receiveFrame(frame.data);
  }

  private receiveChunk(frame: ChunkFrame): void {
    if (frame.byteLength > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (
      frame.index >= frame.count ||
      frame.byteLength > this.reassembledFrameLimit ||
      frame.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)
    ) {
      this.rejectChunk();
      return;
    }
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.byteLength > MAX_CHUNK_BYTES) {
      this.rejectChunk();
      return;
    }
    if (!this.chunk) {
      if (frame.index !== 0) {
        this.rejectChunk();
        return;
      }
      this.chunk = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
        receivedBytes: 0,
        timer: setTimeout(() => this.rejectChunk(), CHUNK_STALE_MS),
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
      this.rejectChunk();
      return;
    }
    chunk.parts.push(decoded);
    chunk.receivedBytes += decoded.byteLength;
    if (chunk.parts.length !== chunk.count) return;
    if (chunk.receivedBytes !== chunk.byteLength) {
      this.rejectChunk();
      return;
    }
    const reassembled = Buffer.concat(chunk.parts, chunk.receivedBytes);
    this.clearChunk();
    let decodedFrame: unknown;
    try {
      decodedFrame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reassembled));
    } catch {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveKnownResponse(decodedFrame)) return;
    if (this.receiveDegradedAgentEnd(decodedFrame, true)) return;
    if (
      boundedJsonBytes(
        decodedFrame,
        MAX_SEMANTIC_FRAME_BYTES,
        1_024,
        MAX_IMAGE_DATA_LENGTH,
        4_096,
      ) === Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    const frameObject = JsonObjectSchema.safeParse(decodedFrame);
    if (!frameObject.success) {
      this.recordProtocolViolation();
      return;
    }
    this.receiveFrame(frameObject.data);
  }

  private receiveKnownResponse(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (frame.type !== "response" || typeof frame.id !== "string" || !this.pending.has(frame.id)) {
      return false;
    }
    this.receiveResponse(frame);
    return true;
  }

  private receiveResponse(frame: Record<string, unknown>): void {
    const rawId = typeof frame.id === "string" ? frame.id : undefined;
    const knownPending = rawId ? this.pending.get(rawId) : undefined;
    const response = OmpResponseFrameSchema.safeParse(frame);
    if (!response.success) {
      if (rawId && knownPending) {
        this.takePending(rawId)?.reject(new Error("OMP RPC response is invalid"));
      } else {
        this.recordProtocolViolation();
      }
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) return;
    const responseItemLimit = pending.command === "get_branch_messages" ? 1_024 : MAX_ARRAY_ITEMS;
    const responseByteLimit =
      pending.command === "get_branch_messages" ? MAX_SEMANTIC_FRAME_BYTES : 2 * 1024 * 1024;
    if (
      boundedJsonBytes(
        frame,
        responseByteLimit,
        responseItemLimit,
        MAX_IMAGE_DATA_LENGTH,
        responseItemLimit === 1_024 ? 4_096 : 2_048,
      ) === Number.POSITIVE_INFINITY
    ) {
      this.takePending(response.data.id)?.reject(
        new Error("OMP RPC response exceeded command limits"),
      );
      return;
    }
    const settled = this.takePending(response.data.id);
    if (!settled) return;
    if (response.data.success) settled.resolve(response.data.data);
    else settled.reject(new Error("OMP RPC request failed"));
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
    const messagesAreSafe =
      frame.messages === undefined ||
      (Array.isArray(frame.messages) &&
        frame.messages.length <= MAX_ARRAY_ITEMS &&
        boundedJsonBytes(
          frame.messages,
          MAX_SEMANTIC_FRAME_BYTES,
          MAX_ARRAY_ITEMS,
          MAX_TEXT_LENGTH,
          4_096,
        ) !== Number.POSITIVE_INFINITY);
    const payloadIsSafe =
      messagesAreSafe &&
      boundedJsonBytes(frame, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) !==
        Number.POSITIVE_INFINITY;
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
    const messageCount =
      observedCount === undefined
        ? envelope.data.messageCount
        : Math.max(envelope.data.messageCount ?? 0, observedCount);
    this.emit({
      ...envelope.data,
      ...(messageCount === undefined ? {} : { messageCount }),
    });
    this.streamedBlocks.clear();
    this.commandTextLength = 0;
    this.activeToolCallIds.clear();
    return true;
  }

  private receiveFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" && frame.type.length <= 64 ? frame.type : null;
    if (!type) {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveDegradedAgentEnd(frame, true)) return;
    if (
      boundedJsonBytes(frame, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) ===
      Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    if (type === "rpc_chunk") {
      const chunk = OmpChunkFrameSchema.safeParse(frame);
      if (!chunk.success) this.rejectChunk();
      else this.receiveChunk(chunk.data);
      return;
    }
    if (this.chunk) {
      this.clearChunk();
      this.recordProtocolViolation();
    }
    if (type === "rpc_frame_error") {
      this.recordProtocolViolation();
      return;
    }
    if (type === "ready") {
      if (this.readyReceived) {
        this.recordProtocolViolation();
        return;
      }
      const ready = OmpReadyFrameSchema.safeParse(frame);
      if (!ready.success) {
        this.recordProtocolViolation();
      } else {
        this.readyReceived = true;
        this.resolveReady(ready.data);
      }
      return;
    }
    if (type === "response") {
      this.receiveResponse(frame);
      return;
    }
    const event = OmpRuntimeEventSchema.safeParse(frame);
    if (!event.success) {
      if (type === "agent_end" && this.receiveDegradedAgentEnd(frame, false)) return;
      this.recordProtocolViolation();
      return;
    }
    if (!this.acceptEventState(event.data)) {
      this.recordProtocolViolation();
      return;
    }
    this.emit(event.data);
    if (
      event.data.type === "message_end" ||
      event.data.type === "turn_end" ||
      event.data.type === "agent_end"
    ) {
      this.streamedBlocks.clear();
    }
    if (event.data.type === "turn_end" || event.data.type === "agent_end") {
      this.commandTextLength = 0;
      this.activeToolCallIds.clear();
    }
  }

  private acceptEventState(event: z.infer<typeof OmpRuntimeEventSchema>): boolean {
    if (event.type === "turn_start") {
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
    if (event.type === "tool_execution_update") {
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

  private rejectChunk(): void {
    this.clearChunk();
    this.recordProtocolViolation();
  }

  private recordProtocolViolation(): void {
    // Malformed bounded frames are isolated so the following frame starts from clean state.
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
    this.queuedWrites.clear();
    this.pendingWriteBytes = 0;
  }

  private emit(event: OmpRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function validateReadyMetadata(frame: ReadyFrame): "legacy-v1" | "v1" | "v2" {
  const metadata = [
    frame.protocolVersion,
    frame.supportedProtocolVersions,
    frame.maxFrameBytes,
    frame.maxReassembledFrameBytes,
  ];
  if (metadata.every((value) => value === undefined)) return "legacy-v1";
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
  return frame.supportedProtocolVersions.includes(2) ? "v2" : "v1";
}

class OmpRpcSession implements OmpRuntimeSession {
  readonly redactionValues: readonly string[];

  constructor(
    private readonly process: OmpRpcProcess,
    private readonly removeAbortListener: () => void,
  ) {
    this.redactionValues = process.redactionValues;
  }

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    return this.process.onEvent(listener);
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.process.request({ type: "get_state" }));
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

  async getAvailableCommands(): Promise<Array<{ name: string; aliases?: string[] }>> {
    const result = OmpAvailableCommandsResultSchema.parse(
      await this.process.request({ type: "get_available_commands" }),
    );
    return result.commands;
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const result = OmpBranchMessagesResultSchema.parse(
      await this.process.request({ type: "get_branch_messages" }),
    );
    return result.messages;
  }

  async prompt(message: string): Promise<{ requestId: string; agentInvoked?: boolean }> {
    const safeMessage = validateBoundedText(message, "prompt", MAX_TEXT_LENGTH);
    const request = this.process.startRequest({ type: "prompt", message: safeMessage });
    const acknowledgement = OmpPromptAckSchema.parse(await request.promise) ?? {};
    return { requestId: request.id, ...acknowledgement };
  }

  async steer(message: string): Promise<void> {
    const safeMessage = validateBoundedText(message, "steer", MAX_TEXT_LENGTH);
    await this.process.request({ type: "steer", message: safeMessage });
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
  constructor(private readonly options: OmpRpcRuntimeOptions = {}) {}

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
      this.options.requestTimeoutMs,
    );
    const abort = () => void process.close().catch(() => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    const removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    try {
      const ready = await waitWithTimeout(
        process.ready,
        READY_TIMEOUT_MS,
        `OMP RPC did not become ready within ${READY_TIMEOUT_MS}ms`,
      );
      const protocol = validateReadyMetadata(ready);
      process.applyReadyLimits(ready);
      options.signal?.throwIfAborted();
      if (protocol === "v2") {
        ProtocolNegotiationResultSchema.parse(
          await process.request({ type: "negotiate_protocol", protocolVersion: 2 }),
        );
      }
      options.signal?.throwIfAborted();
      return new OmpRpcSession(process, removeAbortListener);
    } catch (error) {
      removeAbortListener();
      const cleanup = process.close();
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure(
          "OMP runtime startup cleanup failed",
          cleanup.catch(() => undefined),
        );
      }
      throw error;
    }
  }
}
