import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
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
} from "./omp-rpc-process";
import {
  createOptionalMetadataSanitizer,
  invalidEventDiagnosticMetadata,
  isBoundedToolApprovalId,
  JsonObjectSchema,
  jsonBoundViolation,
  MAX_ARRAY_ITEMS,
  MAX_CHUNK_BYTES,
  MAX_IMAGE_DATA_LENGTH,
  MAX_MODEL_CATALOG_ITEMS,
  MAX_REASSEMBLED_FRAME_BYTES,
  MAX_RPC_ERROR_BYTES,
  MAX_RPC_ERROR_CODE_BYTES,
  MAX_SEMANTIC_FRAME_BYTES,
  MIN_HOST_TOOL_RESULT_FRAME_BYTES,
  mapRuntimeFrameDetails,
  OMP_MAX_CONTENT_PARTS,
  OmpAgentEndEnvelopeSchema,
  OmpChunkFrameSchema,
  type OmpHostToolResult,
  OmpHostToolResultSchema,
  type OmpHostToolUpdate,
  OmpHostToolUpdateSchema,
  type OmpProtocolDiagnosticPhase,
  type OmpProtocolViolationCategory,
  type OmpProtocolViolationDiagnostic,
  type OmpProtocolViolationReason,
  OmpReadyFrameSchema,
  OmpResponseFrameSchema,
  type OmpRpcBoundDimension,
  type OmpRpcDiagnosticCommand,
  type OmpRpcEvent,
  OmpRuntimeEventSchema,
  omitOptionalDetails,
  type PendingProtocolViolation,
  type ProtocolViolationKey,
  projectSessionStateResponseData,
  protocolDiagnosticActualType,
  rpcDiagnosticCommand,
  runtimeFrameCollectionLimit,
  sanitizeHistoryResponseData,
  sanitizeLiveDisplayFrame,
} from "./omp-rpc-protocol";
import { boundedJsonBytes, OmpPublicError, utf8Bytes } from "./security";

type TimerHandle = number | NodeJS.Timeout;
type SpawnProcess = (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
type TerminateProcessTree = (pid: number) => Promise<boolean | "uncertain">;

const REQUEST_TIMEOUT_MS = 60_000;
const CHUNK_STALE_MS = 30_000;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_ONE_WAY_WRITES = 256;
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_PARTS = 4_096;
const PROMPT_SCHEDULING_FAILURE = "OMP prompt scheduling failed";
const PROTOCOL_VIOLATION_COALESCE_MS = 10_000;

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

export function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
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

export class OmpRpcProcess {
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
    spawnProcess?: SpawnProcess,
    terminateProcessTree?: TerminateProcessTree,
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

export function validateReadyMetadata(frame: ReadyFrame): void {
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
