import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { OmpPublicDataFilter } from "./security";

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 750;
const CHUNK_STALE_MS = 30_000;
const MAX_UNKNOWN_DIAGNOSTICS = 8;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_LENGTH = 64 * 1024;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const MAX_TOOL_PAYLOAD_LENGTH = 256 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_PENDING_REQUESTS = 256;
const MAX_LINE_PARTS = 4_096;
const MAX_ARRAY_ITEMS = 512;
const MAX_CONTENT_PARTS = 64;
const MAX_TODOS = 256;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_LENGTH = 64 * 1024;
const MAX_ENV_TOTAL_LENGTH = 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";

const IDENTIFIER = z.string().min(1).max(MAX_ID_LENGTH);
const NAME = z.string().min(1).max(MAX_NAME_LENGTH);
const TEXT = z.string().max(MAX_TEXT_LENGTH);
const OmpThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isBoundedJson(value: unknown, maxTextLength = MAX_TOOL_PAYLOAD_LENGTH): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let textLength = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 24) return false;
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item === "string") {
      if (item.length > MAX_TEXT_LENGTH) return false;
      textLength += item.length;
      if (textLength > maxTextLength) return false;
      continue;
    }
    if (typeof item !== "object") return false;
    const entries = Array.isArray(item)
      ? item.map((child) => ["", child] as const)
      : Object.entries(item);
    if (entries.length > MAX_ARRAY_ITEMS) return false;
    for (const [key, child] of entries) {
      if (key.length > MAX_NAME_LENGTH) return false;
      textLength += key.length;
      if (textLength > maxTextLength) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

const OmpContentPartSchema = z
  .object({
    type: NAME,
    text: TEXT.optional(),
    thinking: TEXT.optional(),
    data: z.string().max(MAX_IMAGE_DATA_LENGTH).optional(),
    mimeType: z.string().max(128).optional(),
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
      .refine((value) => isBoundedJson(value))
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
  role: z.string().min(1).max(32),
  content: z.union([TEXT, z.array(OmpContentPartSchema).max(MAX_CONTENT_PARTS)]).optional(),
  id: IDENTIFIER.optional(),
  entryId: IDENTIFIER.optional(),
  responseId: IDENTIFIER.optional(),
  errorMessage: z.string().max(4_096).nullable().optional(),
  stopReason: z.string().max(64).optional(),
});
const OmpAvailableCommandSchema = z.object({
  name: NAME,
  aliases: z.array(NAME).max(32).optional(),
});
const OmpModelSchema = z.object({
  provider: NAME,
  id: NAME,
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  reasoning: z.boolean().optional(),
  thinking: z
    .object({
      efforts: z.array(z.string().max(32)).max(16).optional(),
      defaultLevel: z.string().max(32).optional(),
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
  data: z
    .unknown()
    .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES))
    .optional(),
  error: z.string().max(4_096).optional(),
});
const OmpChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: IDENTIFIER,
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(MAX_CHUNK_COUNT),
  byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
  data: z.string().max(MAX_ENCODED_CHUNK_BYTES),
});
const BoundedToolPayloadSchema = z.unknown().refine((value) => isBoundedJson(value));
const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({
    type: z.literal("agent_end"),
    messages: z.array(OmpMessageSchema).max(MAX_ARRAY_ITEMS).optional(),
    messageCount: z.number().int().nonnegative().max(MAX_ARRAY_ITEMS).optional(),
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
          content: z.string().max(16_384),
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
    message: z.string().max(64 * 1024),
    source: z.string().max(MAX_NAME_LENGTH).optional(),
  }),
  z.object({ type: z.literal("command_output"), text: TEXT.optional() }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: IDENTIFIER,
    method: z.string().min(1).max(64),
    title: z.string().max(4_096).optional(),
    message: z
      .string()
      .max(64 * 1024)
      .optional(),
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
}

export interface OmpRpcRuntimeOptions {
  spawnProcess?: (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
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
// the daemon's unrelated environment into OMP.
const INHERITED_RUNTIME_ENV = {
  APPDATA: true,
  COLORTERM: true,
  HOME: true,
  HTTPS_PROXY: true,
  HTTP_PROXY: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LOGNAME: true,
  LOCALAPPDATA: true,
  NO_PROXY: true,
  PATH: true,
  PATHEXT: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SSH_AUTH_SOCK: true,
  SHELL: true,
  SystemRoot: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  USERPROFILE: true,
  TZ: true,
  USER: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
  http_proxy: true,
  https_proxy: true,
  no_proxy: true,
} satisfies Readonly<Record<string, true>>;
const INHERITED_PROVIDER_ENV =
  /^(?:ANTHROPIC|AWS|AZURE|BEDROCK|CLAUDE|CODEX|GEMINI|GITHUB|GITLAB|GOOGLE|GROQ|MISTRAL|OLLAMA|OMP|OPENAI|OPENROUTER|VERTEX|XAI)_[A-Z0-9_]+$/u;
const INHERITED_CREDENTIAL_ENV =
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CREDENTIALS|PRIVATE_KEY|SECRET|SESSION_TOKEN|TOKEN)$/u;
const BLOCKED_SESSION_ENV =
  /^(?:BASH_ENV|BUN_INSTALL.*|BUN_OPTIONS|CLASSPATH|DYLD_.*|ELECTRON_RUN_AS_NODE|ENV|GEM_HOME|GEM_PATH|GIT_CONFIG.*|GIT_SSH_COMMAND|HOME|JAVA_TOOL_OPTIONS|LD_.*|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*|PATH|PATHEXT|PERL5LIB|PERL5OPT|PYTHONHOME|PYTHONINSPECT|PYTHONPATH|PYTHONSTARTUP|RUBYLIB|RUBYOPT|SHELL|SystemRoot|USERPROFILE|_JAVA_OPTIONS)$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function validateBoundedText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid OMP ${field}`);
  }
  return value;
}

function buildOmpEnvironment(
  sessionEnv: Readonly<Record<string, string>> | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (
    sessionEnv !== undefined &&
    (sessionEnv === null || typeof sessionEnv !== "object" || Array.isArray(sessionEnv))
  ) {
    throw new Error("OMP session environment is invalid");
  }
  const env: NodeJS.ProcessEnv = {};
  let totalLength = 0;
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined || name === "OMP_COMMAND") continue;
    if (
      !(name in INHERITED_RUNTIME_ENV) &&
      !INHERITED_PROVIDER_ENV.test(name) &&
      !INHERITED_CREDENTIAL_ENV.test(name)
    ) {
      continue;
    }
    if (!ENV_NAME.test(name) || value.length > MAX_ENV_VALUE_LENGTH || value.includes("\0"))
      continue;
    totalLength += name.length + value.length;
    if (totalLength > MAX_ENV_TOTAL_LENGTH)
      throw new Error("OMP inherited environment is too large");
    env[name] = value;
  }
  const entries = Object.entries(sessionEnv ?? {});
  if (entries.length > MAX_ENV_ENTRIES)
    throw new Error("OMP session environment has too many entries");
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name) || BLOCKED_SESSION_ENV.test(name)) {
      throw new Error("OMP session environment contains a forbidden variable");
    }
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_LENGTH || value.includes("\0")) {
      throw new Error("OMP session environment contains an invalid value");
    }
    totalLength += name.length + value.length;
    if (totalLength > MAX_ENV_TOTAL_LENGTH) throw new Error("OMP session environment is too large");
    env[name] = value;
  }
  return env;
}

export function buildOmpSpawnRequest(
  options: OmpStartOptions,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): OmpSpawnRequest {
  const cwd = validateBoundedText(options.cwd, "working directory", MAX_PATH_LENGTH);
  if (!isAbsolute(cwd)) throw new Error("OMP working directory must be absolute");
  const command = validateBoundedText(sourceEnv.OMP_COMMAND ?? "omp", "command", MAX_PATH_LENGTH);
  if (/[\r\n]/u.test(command)) throw new Error("Invalid OMP command");
  if (options.mode !== undefined && options.mode !== "full") throw new Error("Invalid OMP mode");
  if (options.noSession !== undefined && typeof options.noSession !== "boolean") {
    throw new Error("Invalid OMP no-session option");
  }
  const args = ["--mode", "rpc-ui", "--approval-mode", "yolo"];
  if (options.model !== undefined) {
    args.push("--model", validateBoundedText(options.model, "model", MAX_NAME_LENGTH));
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
  return {
    command,
    args,
    cwd,
    env: buildOmpEnvironment(options.env, sourceEnv),
    detached: process.platform !== "win32",
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

async function stopWindowsTree(pid: number): Promise<boolean> {
  const result = Promise.withResolvers<boolean>();
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
    return false;
  }
  taskkill.stdout.resume();
  taskkill.stderr.resume();
  let settled = false;
  let deadline: NodeJS.Timeout | undefined;
  let finalDeadline: NodeJS.Timeout | undefined;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(finalDeadline);
    result.resolve(success);
  };
  deadline = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finalDeadline = setTimeout(() => finish(false), PROCESS_STOP_TIMEOUT_MS);
  }, PROCESS_STOP_TIMEOUT_MS);
  taskkill.once("error", () => finish(false));
  taskkill.once("close", (code, signal) => {
    finish((code === 0 || code === 128) && signal === null);
  });
  return result.promise;
}

class OmpRpcProcess {
  readonly ready: Promise<ReadyFrame>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private readonly resolveReady: (frame: ReadyFrame) => void;
  private readonly rejectReady: (error: Error) => void;
  private readonly dataFilter: OmpPublicDataFilter;
  private readonly streamedBlocks = new Map<number, string>();
  private readonly activeToolCallIds = new Set<string>();
  private unknownDiagnosticCount = 0;
  private commandTextLength = 0;
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private discardingLine = false;
  private chunk: ChunkState | null = null;
  private physicalFrameLimit = MAX_PHYSICAL_FRAME_BYTES;
  private reassembledFrameLimit = MAX_REASSEMBLED_FRAME_BYTES;
  private closed = false;
  private exited = false;
  private fatalError: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private readyReceived = false;

  constructor(options: OmpStartOptions, spawnProcess?: OmpRpcRuntimeOptions["spawnProcess"]) {
    const ready = Promise.withResolvers<ReadyFrame>();
    this.rejectReady = ready.reject;
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    const request = buildOmpSpawnRequest(options);
    this.dataFilter = new OmpPublicDataFilter(
      Object.values(request.env).filter((value): value is string => value !== undefined),
    );
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
    this.child.stdout.once("end", () => {
      if (this.lineBytes > 0 || this.discardingLine) this.recordProtocolViolation();
      this.lineParts = [];
      this.lineBytes = 0;
      this.discardingLine = false;
    });
    this.child.stderr.on("data", () => {
      // Stderr is intentionally drained and discarded. It may contain credentials or paths.
    });
    this.child.stdin.on("error", () => {
      this.fail(new Error("OMP RPC input channel failed"));
    });
    const exited = Promise.withResolvers<void>();
    this.exitPromise = exited.promise;
    this.child.once("close", (code, signal) => {
      this.exited = true;
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      const error = new Error(`OMP RPC process exited (${detail})`);
      this.rejectReady(error);
      this.failPending(error);
      if (!this.closed && !this.fatalError) this.fail(error);
      exited.resolve();
    });
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

  startRequest(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): StartedRequest {
    const id = randomUUID();
    if (this.fatalError) return { id, promise: Promise.reject(this.fatalError) };
    if (this.closed || this.exited || !this.child.stdin.writable) {
      return { id, promise: Promise.reject(new Error("OMP RPC process is closed")) };
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return { id, promise: Promise.reject(new Error("OMP RPC has too many pending requests")) };
    }
    const result = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      result.reject(new Error("OMP RPC request timed out"));
    }, timeoutMs);
    this.pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify({ ...command, id })}\n`);
    } catch {
      clearTimeout(timer);
      this.pending.delete(id);
      result.reject(new Error("OMP RPC request could not be encoded"));
      return { id, promise: result.promise };
    }
    if (payload.byteLength > this.physicalFrameLimit) {
      clearTimeout(timer);
      this.pending.delete(id);
      result.reject(new Error("OMP RPC request exceeds the negotiated frame limit"));
      return { id, promise: result.promise };
    }
    try {
      this.child.stdin.write(payload, (cause) => {
        if (cause) this.fail(new Error("OMP RPC input channel failed"));
      });
    } catch {
      this.fail(new Error("OMP RPC input channel failed"));
    }
    return { id, promise: result.promise };
  }

  request(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
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
      await this.waitForExit(PROCESS_STOP_TIMEOUT_MS);
    }
    const pid = this.child.pid;
    if (pid !== undefined) {
      const treeStopped =
        process.platform === "win32"
          ? await stopWindowsTree(pid).catch(() => false)
          : await terminatePosixProcessTree(pid, PROCESS_STOP_TIMEOUT_MS).catch(() => false);
      if (!treeStopped) throw new Error("OMP RPC process tree cleanup failed");
    }
    if (!this.exited && !(await this.waitForExit(PROCESS_STOP_TIMEOUT_MS))) {
      throw new Error("OMP RPC process did not close after tree cleanup");
    }
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
      if (!this.discardingLine) this.appendLinePart(bytes.subarray(start, index));
      if (this.discardingLine) {
        this.discardingLine = false;
        this.lineParts = [];
        this.lineBytes = 0;
      } else {
        this.completeLine();
      }
      start = index + 1;
    }
    if (start < bytes.length && !this.discardingLine) this.appendLinePart(bytes.subarray(start));
  }

  private appendLinePart(part: Buffer): void {
    if (part.byteLength === 0) return;
    if (
      this.lineParts.length >= MAX_LINE_PARTS ||
      this.lineBytes + part.byteLength > this.physicalFrameLimit
    ) {
      this.lineParts = [];
      this.lineBytes = 0;
      this.discardingLine = true;
      this.recordProtocolViolation();
      return;
    }
    this.lineParts.push(part);
    this.lineBytes += part.byteLength;
  }

  private completeLine(): void {
    if (this.lineBytes === 0) return;
    const line = Buffer.concat(this.lineParts, this.lineBytes);
    this.lineParts = [];
    this.lineBytes = 0;
    const payload = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    if (payload.byteLength > MAX_SEMANTIC_FRAME_BYTES) {
      this.recordProtocolViolation();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
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
    if (
      frame.index >= frame.count ||
      frame.byteLength > this.reassembledFrameLimit ||
      frame.byteLength > MAX_SEMANTIC_FRAME_BYTES ||
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
    const frameObject = JsonObjectSchema.safeParse(decodedFrame);
    if (!frameObject.success) {
      this.recordProtocolViolation();
      return;
    }
    this.receiveFrame(frameObject.data);
  }

  private receiveFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" && frame.type.length <= 64 ? frame.type : null;
    if (!type) {
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
      const response = OmpResponseFrameSchema.safeParse(frame);
      if (!response.success) {
        this.recordProtocolViolation();
        return;
      }
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.data.id);
      if (response.data.success) {
        pending.resolve(
          response.data.data === undefined ? undefined : this.dataFilter.json(response.data.data),
        );
      } else {
        pending.reject(new Error("OMP RPC request failed"));
      }
      return;
    }
    const event = OmpRuntimeEventSchema.safeParse(frame);
    if (!event.success) {
      this.recordProtocolViolation();
      return;
    }
    if (!this.acceptEventState(event.data)) {
      this.recordProtocolViolation();
      return;
    }
    const publicEvent = OmpRuntimeEventSchema.safeParse(
      this.dataFilter.json(event.data, MAX_IMAGE_DATA_LENGTH),
    );
    if (!publicEvent.success) {
      this.recordProtocolViolation();
      return;
    }
    const sanitized = publicEvent.data;
    this.emit(sanitized);
    if (
      sanitized.type === "message_end" ||
      sanitized.type === "turn_end" ||
      sanitized.type === "agent_end"
    ) {
      this.streamedBlocks.clear();
    }
    if (sanitized.type === "turn_end" || sanitized.type === "agent_end") {
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
      const nextLength = this.commandTextLength + (event.text?.length ?? 0);
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
      totalLength += text.length;
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
    if (this.unknownDiagnosticCount < MAX_UNKNOWN_DIAGNOSTICS) this.unknownDiagnosticCount += 1;
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
  constructor(
    private readonly process: OmpRpcProcess,
    private readonly removeAbortListener: () => void,
  ) {}

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
    const process = new OmpRpcProcess(options, this.options.spawnProcess);
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
      await process.close().catch(() => undefined);
      throw error;
    }
  }
}
