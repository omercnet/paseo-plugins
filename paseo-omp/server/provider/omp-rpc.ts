import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 750;
const CHUNK_STALE_MS = 30_000;
const MAX_STDERR_BYTES = 16_384;
const MAX_UNKNOWN_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_BYTES = 256;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;

const OmpThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OmpContentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough();
const OmpAssistantMessageEventSchema = z
  .object({
    type: z.string(),
    contentIndex: z.number().int().nonnegative().optional(),
    delta: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();
const OmpMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(OmpContentPartSchema)]).optional(),
    id: z.string().optional(),
    entryId: z.string().optional(),
    responseId: z.string().optional(),
    errorMessage: z.string().nullable().optional(),
    stopReason: z.string().optional(),
  })
  .passthrough();
const OmpModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    thinking: z
      .object({ efforts: z.array(z.string()).optional(), defaultLevel: z.string().optional() })
      .passthrough()
      .optional(),
    contextWindow: z.number().nullable().optional(),
  })
  .passthrough();
const OmpSessionStateSchema = z
  .object({
    model: OmpModelSchema.nullable().optional(),
    thinkingLevel: OmpThinkingLevelSchema.optional(),
    isStreaming: z.boolean(),
    isCompacting: z.boolean(),
    sessionId: z.string(),
  })
  .passthrough();
const OmpReadyFrameSchema = z
  .object({
    type: z.literal("ready"),
    protocolVersion: z.number().int().positive().optional(),
    supportedProtocolVersions: z.array(z.number().int().positive()).optional(),
    maxFrameBytes: z.number().int().positive().optional(),
    maxReassembledFrameBytes: z.number().int().positive().optional(),
  })
  .passthrough();
const OmpResponseFrameSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().min(1),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();
const OmpChunkFrameSchema = z
  .object({
    type: z.literal("rpc_chunk"),
    chunkId: z.string().min(1),
    index: z.number().int().nonnegative(),
    count: z.number().int().positive().max(MAX_CHUNK_COUNT),
    byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
    data: z.string().max(MAX_ENCODED_CHUNK_BYTES),
  })
  .passthrough();
const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }).passthrough(),
  z
    .object({
      type: z.literal("agent_end"),
      messages: z.array(OmpMessageSchema).optional(),
      messageCount: z.number().int().nonnegative().optional(),
      isTerminal: z.boolean().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("turn_start") }).passthrough(),
  z.object({ type: z.literal("turn_end") }).passthrough(),
  z.object({ type: z.literal("message_start"), message: OmpMessageSchema }).passthrough(),
  z
    .object({
      type: z.literal("message_update"),
      message: OmpMessageSchema,
      assistantMessageEvent: OmpAssistantMessageEventSchema.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("message_end"), message: OmpMessageSchema }).passthrough(),
  z
    .object({
      type: z.literal("tool_execution_start"),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_execution_update"),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown().optional(),
      partialResult: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_execution_end"),
      toolCallId: z.string(),
      toolName: z.string(),
      result: z.unknown(),
      isError: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("todo_reminder"),
      todos: z.array(
        z
          .object({
            id: z.string().optional(),
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("notice"),
      id: z.string().optional(),
      level: z.enum(["info", "warning", "error"]),
      message: z.string(),
      source: z.string().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("command_output"), text: z.string().optional() }).passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.string(),
      title: z.string().optional(),
      message: z.string().optional(),
      notifyType: z.enum(["info", "warning", "error"]).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("prompt_result"),
      id: z.string().optional(),
      agentInvoked: z.boolean(),
    })
    .passthrough(),
  z.object({ type: z.literal("process_exit"), error: z.string() }).passthrough(),
]);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const OmpModelsResultSchema = z.object({ models: z.array(OmpModelSchema) }).passthrough();
const OmpPromptAckSchema = z
  .object({ agentInvoked: z.boolean().optional() })
  .passthrough()
  .optional();
const OmpBranchMessagesResultSchema = z
  .object({
    messages: z.array(z.object({ entryId: z.string(), text: z.string() }).passthrough()),
  })
  .passthrough();
const ProtocolNegotiationResultSchema = z.object({ protocolVersion: z.literal(2) }).passthrough();

const RECOGNIZED_FRAME_TYPES: Readonly<Record<string, true>> = {
  agent_end: true,
  agent_start: true,
  command_output: true,
  extension_ui_request: true,
  message_end: true,
  message_start: true,
  message_update: true,
  notice: true,
  process_exit: true,
  prompt_result: true,
  ready: true,
  response: true,
  rpc_chunk: true,
  rpc_frame_error: true,
  todo_reminder: true,
  tool_execution_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  turn_end: true,
  turn_start: true,
};
export type OmpMessage = z.infer<typeof OmpMessageSchema>;
export type OmpModel = z.infer<typeof OmpModelSchema>;
export type OmpSessionState = z.infer<typeof OmpSessionStateSchema>;
export type OmpRpcEvent = z.infer<typeof OmpRuntimeEventSchema>;

export interface OmpStartOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  model?: string;
  mode?: "full";
  thinkingOption?: string;
  systemPrompt?: string;
  noSession?: boolean;
  signal?: AbortSignal;
}

export interface OmpRuntimeSession {
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  getState(): Promise<OmpSessionState>;
  getAvailableModels(): Promise<OmpModel[]>;
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

function buildArgs(options: OmpStartOptions): string[] {
  const args = ["--mode", "rpc-ui", "--approval-mode", "yolo"];
  if (options.model) args.push("--model", options.model);
  if (options.thinkingOption) args.push("--thinking", options.thinkingOption);
  if (options.noSession) args.push("--no-session");
  const systemPrompt = options.systemPrompt?.trim();
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  return args;
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

async function stopWindowsTree(pid: number, force: boolean): Promise<void> {
  const result = Promise.withResolvers<void>();
  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  const taskkill = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
  taskkill.once("error", result.reject);
  taskkill.once("close", () => result.resolve());
  await waitWithTimeout(result.promise, PROCESS_STOP_TIMEOUT_MS, "taskkill timed out");
}

class OmpRpcProcess {
  readonly ready: Promise<ReadyFrame>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private readonly resolveReady: (frame: ReadyFrame) => void;
  private readonly rejectReady: (error: Error) => void;
  private readonly unknownDiagnostics: string[] = [];
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private stderr = "";
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
    const request: OmpSpawnRequest = {
      command: process.env.OMP_COMMAND ?? "omp",
      args: buildArgs(options),
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
    };
    this.child = spawnProcess
      ? spawnProcess(request)
      : spawn(request.command, request.args, {
          cwd: request.cwd,
          env: request.env,
          detached: request.detached,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.child.stdout.on("data", (chunk: Buffer | string) => this.receiveData(chunk));
    this.child.stdout.once("end", () => {
      if (this.lineBytes > 0) this.fail(new Error("OMP RPC stdout ended mid-frame"));
    });
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.stdin.on("error", (cause) => {
      this.fail(new Error(`OMP RPC stdin failed: ${cause.message}`, { cause }));
    });
    const exited = Promise.withResolvers<void>();
    this.exitPromise = exited.promise;
    this.child.once("close", (code, signal) => {
      this.exited = true;
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      const diagnostics = this.unknownDiagnostics.length
        ? `; ignored frames: ${this.unknownDiagnostics.join(" | ")}`
        : "";
      const error = new Error(`OMP RPC process exited with ${detail}${suffix}${diagnostics}`);
      this.rejectReady(error);
      this.failPending(error);
      if (!this.closed && !this.fatalError) this.fail(error);
      exited.resolve();
    });
    this.child.once("error", (cause) => {
      this.fail(new Error(`Unable to launch OMP: ${cause.message}`, { cause }));
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
    const result = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      result.reject(new Error(`OMP RPC '${String(command.type)}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
    const payload = Buffer.from(`${JSON.stringify({ ...command, id })}\n`);
    if (payload.byteLength > this.physicalFrameLimit) {
      clearTimeout(timer);
      this.pending.delete(id);
      result.reject(
        new Error(
          `OMP RPC '${String(command.type)}' exceeds ${this.physicalFrameLimit} byte frame limit`,
        ),
      );
      return { id, promise: result.promise };
    }
    try {
      this.child.stdin.write(payload, (cause) => {
        if (cause) this.fail(new Error(`OMP RPC stdin write failed: ${cause.message}`, { cause }));
      });
    } catch (cause) {
      this.fail(
        new Error(
          `OMP RPC stdin write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
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
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // The child may close stdin before its process exit arrives; continue to tree termination.
    }
    if (await this.waitForExit(PROCESS_STOP_TIMEOUT_MS)) return;
    await this.terminateTree("SIGTERM", false).catch(() => undefined);
    if (await this.waitForExit(PROCESS_STOP_TIMEOUT_MS)) return;
    await this.terminateTree("SIGKILL", true).catch(() => undefined);
    if (await this.waitForExit(PROCESS_STOP_TIMEOUT_MS)) return;
    throw new Error("OMP RPC process tree did not exit after SIGKILL");
  }

  private async terminateTree(signal: NodeJS.Signals, force: boolean): Promise<void> {
    const pid = this.child.pid;
    if (!pid) throw new Error("OMP RPC process has no PID");
    if (process.platform === "win32") {
      await stopWindowsTree(pid, force);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      if (!this.exited) this.child.kill(signal);
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
      this.appendLinePart(bytes.subarray(start, index));
      if (this.fatalError) return;
      this.completeLine();
      if (this.fatalError) return;
      start = index + 1;
    }
    if (start < bytes.length) this.appendLinePart(bytes.subarray(start));
  }

  private appendLinePart(part: Buffer): void {
    if (part.byteLength === 0) return;
    if (this.lineBytes + part.byteLength > this.physicalFrameLimit) {
      this.fail(new Error(`OMP RPC frame exceeds ${this.physicalFrameLimit} byte limit`));
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
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch (cause) {
      this.fail(
        new Error(
          `OMP emitted invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
      return;
    }
    const frame = JsonObjectSchema.safeParse(decoded);
    if (!frame.success) {
      this.fail(new Error("OMP emitted a non-object RPC frame"));
      return;
    }
    this.receiveFrame(frame.data);
  }

  private receiveChunk(frame: ChunkFrame): void {
    if (frame.index >= frame.count || frame.byteLength > this.reassembledFrameLimit) {
      this.fail(new Error("OMP emitted invalid RPC chunk bounds"));
      return;
    }
    if (
      frame.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data) ||
      frame.data.length > MAX_ENCODED_CHUNK_BYTES
    ) {
      this.fail(new Error("OMP emitted invalid RPC chunk encoding"));
      return;
    }
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.byteLength > MAX_CHUNK_BYTES) {
      this.fail(new Error("OMP emitted an oversized decoded RPC chunk"));
      return;
    }
    if (!this.chunk) {
      if (frame.index !== 0) {
        this.fail(new Error("OMP RPC chunk sequence did not start at index 0"));
        return;
      }
      this.chunk = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
        receivedBytes: 0,
        timer: setTimeout(
          () => this.fail(new Error("OMP RPC chunk assembly expired")),
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
      this.fail(new Error("OMP emitted an interleaved or out-of-order RPC chunk"));
      return;
    }
    chunk.parts.push(decoded);
    chunk.receivedBytes += decoded.byteLength;
    if (chunk.parts.length !== chunk.count) return;
    if (chunk.receivedBytes !== chunk.byteLength) {
      this.fail(new Error("OMP RPC chunk byte length mismatch"));
      return;
    }
    const reassembled = Buffer.concat(chunk.parts, chunk.receivedBytes);
    this.clearChunk();
    let decodedFrame: unknown;
    try {
      decodedFrame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reassembled));
    } catch (cause) {
      this.fail(
        new Error(
          `Unable to reassemble OMP RPC frame: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
      return;
    }
    const frameObject = JsonObjectSchema.safeParse(decodedFrame);
    if (!frameObject.success) {
      this.fail(new Error("OMP reassembled a non-object RPC frame"));
      return;
    }
    this.receiveFrame(frameObject.data);
  }

  private receiveFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" ? frame.type : null;
    if (!type) {
      this.fail(new Error("OMP RPC frame is missing a string type"));
      return;
    }
    if (type === "rpc_chunk") {
      const chunk = OmpChunkFrameSchema.safeParse(frame);
      if (!chunk.success) this.fail(new Error("OMP emitted a malformed rpc_chunk frame"));
      else this.receiveChunk(chunk.data);
      return;
    }
    if (type === "rpc_frame_error") {
      const message = typeof frame.error === "string" ? frame.error : "malformed frame";
      this.fail(new Error(`OMP reported rpc_frame_error: ${message}`));
      return;
    }
    if (type === "ready") {
      if (this.readyReceived) {
        this.fail(new Error("OMP emitted more than one ready frame"));
        return;
      }
      const ready = OmpReadyFrameSchema.safeParse(frame);
      if (!ready.success) this.fail(new Error("OMP emitted a malformed ready frame"));
      else {
        this.readyReceived = true;
        this.resolveReady(ready.data);
      }
      return;
    }
    if (type === "response") {
      const response = OmpResponseFrameSchema.safeParse(frame);
      if (!response.success) {
        this.fail(new Error("OMP emitted a malformed response frame"));
        return;
      }
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.data.id);
      if (response.data.success) pending.resolve(response.data.data);
      else pending.reject(new Error(response.data.error ?? "OMP RPC request failed"));
      return;
    }
    const event = OmpRuntimeEventSchema.safeParse(frame);
    if (event.success) {
      this.emit(event.data);
      return;
    }
    if (RECOGNIZED_FRAME_TYPES[type]) {
      this.fail(new Error(`OMP emitted a malformed ${type} frame`));
      return;
    }
    if (this.unknownDiagnostics.length < MAX_UNKNOWN_DIAGNOSTICS) {
      const diagnostic = JSON.stringify(frame) ?? type;
      this.unknownDiagnostics.push(diagnostic.slice(0, MAX_DIAGNOSTIC_BYTES));
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
    return OmpModelSchema.parse(
      await this.process.request({ type: "set_model", provider, modelId }),
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    const parsed = OmpThinkingLevelSchema.parse(level);
    await this.process.request({ type: "set_thinking_level", level: parsed });
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const result = OmpBranchMessagesResultSchema.parse(
      await this.process.request({ type: "get_branch_messages" }),
    );
    return result.messages;
  }

  async prompt(message: string): Promise<{ requestId: string; agentInvoked?: boolean }> {
    const request = this.process.startRequest({ type: "prompt", message });
    const acknowledgement = OmpPromptAckSchema.parse(await request.promise) ?? {};
    return { requestId: request.id, ...acknowledgement };
  }

  async steer(message: string): Promise<void> {
    await this.process.request({ type: "steer", message });
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
