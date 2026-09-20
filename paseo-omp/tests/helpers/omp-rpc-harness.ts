import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { OmpRpcRuntime } from "../../server/provider/omp-rpc";
import type { OmpSpawnRequest } from "../../server/provider/omp-rpc-environment";
import type {
  OmpProtocolViolationDiagnostic,
  OmpRpcEvent,
} from "../../server/provider/omp-rpc-protocol";

export const READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
} as const;
export const READY_WITH_TYPED_APPROVALS = {
  ...READY_FRAME,
  features: { typedToolApprovals: 1 },
} as const;
export const NATIVE_TOOL_APPROVAL_FRAME_BYTES = 64 * 1024;
export const TEST_RUNTIME_ENV: NodeJS.ProcessEnv = {
  HOME: "/__paseo_omp_test_no_home__",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
  PI_CONFIG_DIR: ".omp-no-config",
};
export const testOnWindows = process.platform === "win32" ? test : test.skip;

export class FakeRpcChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 424_242;
  private didClose = false;

  constructor() {
    super();
    this.stdin.once("error", () => this.close(1));
    this.stdin.once("finish", () => this.close());
  }

  kill(): boolean {
    this.close(null, "SIGTERM");
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.didClose) return;
    this.didClose = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  write(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  writeRaw(value: string): void {
    this.stdout.write(value);
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
export function writeChunked(
  child: FakeRpcChild,
  frame: Record<string, unknown>,
  chunkId: string,
): void {
  const payload = Buffer.from(JSON.stringify(frame));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += 256 * 1024) {
    parts.push(payload.subarray(offset, offset + 256 * 1024));
  }
  for (const [index, part] of parts.entries()) {
    child.write({
      type: "rpc_chunk",
      chunkId,
      index,
      count: parts.length,
      byteLength: payload.byteLength,
      data: part.toString("base64"),
    });
  }
}

export function observeCommands(
  child: FakeRpcChild,
  handler: (command: Record<string, unknown>) => void,
): void {
  let buffered = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffered += String(chunk);
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

export function runtimeFor(
  child: FakeRpcChild,
  launches: OmpSpawnRequest[] = [],
  requestTimeoutMs?: number,
  reportProtocolViolation?: (diagnostic: OmpProtocolViolationDiagnostic) => void | Promise<void>,
): OmpRpcRuntime {
  return new OmpRpcRuntime({
    spawnProcess(request) {
      launches.push(request);
      return child.asChildProcess();
    },
    environment: TEST_RUNTIME_ENV,
    terminateProcessTree: () => Promise.resolve(true),
    requestTimeoutMs,
    reportProtocolViolation,
  });
}

export function nextEvent(
  subscribe: (listener: (event: OmpRpcEvent) => void) => () => void,
): Promise<OmpRpcEvent> {
  const result = Promise.withResolvers<OmpRpcEvent>();
  let remove = () => {};
  remove = subscribe((event) => {
    remove();
    result.resolve(event);
  });
  return result.promise;
}
