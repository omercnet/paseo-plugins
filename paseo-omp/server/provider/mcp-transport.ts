import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { terminateSpawnedProcessTree } from "./omp-rpc";
import { OmpCleanupFailure } from "./security";

const MAX_MCP_TRANSPORT_FRAME_BYTES = 1024 * 1024;
const PROCESS_EXIT_TIMEOUT_MS = 750;

type TimerHandle = ReturnType<typeof setTimeout>;

function isConfirmedNoProcessSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

type StdioTransportDependencies = {
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      windowsHide: boolean;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number, platform: NodeJS.Platform) => Promise<boolean>;
  platform?: NodeJS.Platform;
};

export interface ConnectedMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ConnectedMcpToolPage {
  tools: readonly ConnectedMcpTool[];
  nextCursor?: string;
}

export interface ConnectedMcpClient {
  listTools(options: { signal: AbortSignal; cursor?: string }): Promise<ConnectedMcpToolPage>;
  callTool(
    name: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      onProgress: (progress: unknown) => void;
      maxTotalTimeoutMs: number;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
}

function waitForExit(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  const result = Promise.withResolvers<boolean>();
  const timeout: TimerHandle = setTimeout(() => result.resolve(false), timeoutMs);
  void exit.then(() => result.resolve(true));
  return result.promise.finally(() => clearTimeout(timeout));
}

export class SupervisedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private exited = false;
  private closeNotified = false;
  private readonly exit = Promise.withResolvers<void>();
  private treeCleanup: Promise<boolean> | null = null;
  private closePromise: Promise<void> | null = null;
  private spawnFailedWithoutProcess = false;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly server: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd: string;
    },
    private readonly dependencies: StdioTransportDependencies = {},
  ) {
    this.platform = dependencies.platform ?? process.platform;
  }

  start(): Promise<void> {
    if (this.child || this.closePromise) {
      return Promise.reject(new Error("MCP stdio transport already started or closed"));
    }
    const spawnProcess =
      this.dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(this.server.command, this.server.args ?? [], {
        cwd: this.server.cwd,
        env: { ...getDefaultEnvironment(), ...this.server.env },
        detached: this.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(error);
    }
    this.child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.receiveData(chunk));
    child.stdout.once("end", () => {
      if (this.lineBytes > 0) this.fail(new Error("MCP stdio response ended mid-frame"));
    });
    child.stderr.resume();
    child.stdin.on("error", (error) => this.fail(error));
    child.once("exit", () => {
      this.exited = true;
      this.exit.resolve();
      void this.startTreeCleanup().catch((error) => this.onerror?.(error));
      this.notifyClose();
    });
    const started = Promise.withResolvers<void>();
    child.once("spawn", started.resolve);
    child.once("error", (error) => {
      if (child.pid === undefined && isConfirmedNoProcessSpawnFailure(error)) {
        this.spawnFailedWithoutProcess = true;
      }
      started.reject(error);
      this.fail(error);
    });
    return started.promise;
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable || this.closePromise) {
      return Promise.reject(new Error("MCP stdio transport is closed"));
    }
    const payload = Buffer.from(serializeMessage(message));
    if (payload.byteLength > MAX_MCP_TRANSPORT_FRAME_BYTES) {
      return Promise.reject(new Error("MCP stdio request exceeds the transport frame limit"));
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeTransport();
    return this.closePromise;
  }

  private receiveData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.byteLength : newline;
      const part = bytes.subarray(offset, end);
      this.lineBytes += part.byteLength;
      if (this.lineBytes > MAX_MCP_TRANSPORT_FRAME_BYTES) {
        this.fail(new Error("MCP stdio response exceeds the transport frame limit"));
        return;
      }
      if (part.byteLength > 0) this.lineParts.push(part);
      if (newline < 0) return;
      this.emitLine();
      offset = newline + 1;
    }
  }

  private emitLine(): void {
    const payload = Buffer.concat(this.lineParts, this.lineBytes);
    this.lineParts = [];
    this.lineBytes = 0;
    if (payload.byteLength === 0) return;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      this.onmessage?.(deserializeMessage(text));
    } catch {
      this.fail(new Error("MCP stdio response is invalid"));
    }
  }

  private fail(error: Error): void {
    this.onerror?.(error);
    void this.close().catch((cleanupError) => this.onerror?.(cleanupError));
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  private startTreeCleanup(): Promise<boolean> {
    if (this.treeCleanup) return this.treeCleanup;
    const pid = this.child?.pid;
    this.treeCleanup =
      pid === undefined
        ? Promise.resolve(this.spawnFailedWithoutProcess)
        : (this.dependencies.terminateProcessTree ?? terminateSpawnedProcessTree)(
            pid,
            this.platform,
          );
    return this.treeCleanup;
  }

  private async closeTransport(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.notifyClose();
      return;
    }
    if (!this.exited) {
      try {
        child.stdin.end();
      } catch {
        // Process-tree cleanup remains authoritative when stdin is already closed.
      }
    }
    const terminated = await this.startTreeCleanup();
    const exited =
      this.spawnFailedWithoutProcess ||
      this.exited ||
      (await waitForExit(this.exit.promise, PROCESS_EXIT_TIMEOUT_MS));
    this.notifyClose();
    if (!terminated || !exited) throw new Error("MCP stdio process tree cleanup failed");
  }
}

function boundedBody(
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
): ReadableStream<Uint8Array> {
  let frameBytes = 0;
  let lineBytes = 0;
  let previousByte = -1;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          frameBytes += 1;
          lineBytes += 1;
          if (frameBytes > MAX_MCP_TRANSPORT_FRAME_BYTES) {
            controller.error(new Error("MCP response exceeds the transport frame limit"));
            return;
          }
          if (eventStream && byte === 10) {
            const blankLine = lineBytes === 1 || (lineBytes === 2 && previousByte === 13);
            if (blankLine) frameBytes = 0;
            lineBytes = 0;
          }
          previousByte = byte;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export function createBoundedMcpFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_TRANSPORT_FRAME_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("MCP response exceeds the transport frame limit");
    }
    if (!response.body) return response;
    const eventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ?? false;
    return new Response(boundedBody(response.body, eventStream), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export interface McpConnectingClient {
  connect(transport: Transport, options?: { signal?: AbortSignal }): Promise<void>;
}

export async function closeMcpOwnership(
  client: Pick<Client, "close">,
  transport: Transport,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    Promise.resolve().then(() => transport.close()),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "OMP MCP transport cleanup failed");
}

export async function connectMcpTransport(
  client: McpConnectingClient,
  transport: Transport,
  signal: AbortSignal,
): Promise<void> {
  const interrupted = Promise.withResolvers<never>();
  let abortCleanup: Promise<void> | null = null;
  const abort = () => {
    abortCleanup ??= Promise.resolve().then(() => transport.close());
    void abortCleanup.catch(() => undefined);
    interrupted.reject(
      new OmpCleanupFailure("OMP MCP connection initialization was interrupted", abortCleanup),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
    signal.removeEventListener("abort", abort);
    return await interrupted.promise;
  }
  try {
    const connecting = client.connect(transport, { signal });
    await Promise.race([connecting, interrupted.promise]);
  } catch (error) {
    if (error instanceof OmpCleanupFailure) throw error;
    const cleanup = abortCleanup ?? Promise.resolve().then(() => transport.close());
    try {
      await cleanup;
    } catch {
      throw new OmpCleanupFailure("OMP MCP connection cleanup failed", cleanup);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function connectMcpServer(
  _name: string,
  config: ProviderMcpServerConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<ConnectedMcpClient> {
  const client = new Client({ name: "paseo-omp-provider", version: "1.0.0" });
  const requestInit = config.type === "stdio" ? undefined : { headers: config.headers };
  const boundedFetch = createBoundedMcpFetch();
  const transport =
    config.type === "stdio"
      ? new SupervisedStdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd,
        })
      : config.type === "http"
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit,
            fetch: boundedFetch,
          })
        : new SSEClientTransport(new URL(config.url), {
            requestInit,
            fetch: boundedFetch,
          });
  await connectMcpTransport(client, transport, signal);
  return {
    async listTools(options) {
      const page = await client.listTools(options.cursor ? { cursor: options.cursor } : {}, {
        signal: options.signal,
      });
      return { tools: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async callTool(name, input, options) {
      return await client.callTool({ name, arguments: input }, undefined, {
        signal: options.signal,
        onprogress: (progress) => options.onProgress(progress),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: options.maxTotalTimeoutMs,
      });
    },
    async close() {
      await closeMcpOwnership(client, transport);
    },
  };
}
