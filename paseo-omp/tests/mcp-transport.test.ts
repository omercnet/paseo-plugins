import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  connectMcpTransport,
  createBoundedMcpFetch,
  SupervisedStdioClientTransport,
} from "../server/provider/mcp-transport";

class FakeMcpChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 424_243;

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("MCP transport boundaries", () => {
  test("rejects oversized HTTP and SSE response frames before downstream parsing", async () => {
    const oversized = new Uint8Array(1024 * 1024 + 1).fill(65);
    for (const contentType of ["application/json", "text/event-stream"]) {
      const boundedFetch = createBoundedMcpFetch(
        async () => new Response(oversized, { headers: { "content-type": contentType } }),
      );
      const response = await boundedFetch("http://127.0.0.1/mcp");
      await expect(response.arrayBuffer()).rejects.toThrow("transport frame limit");
    }
  });

  test("closes a created transport immediately when initialization is aborted", async () => {
    let closes = 0;
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {
        closes += 1;
      },
    };
    const client = {
      connect: async () => await new Promise<void>(() => {}),
    };
    const controller = new AbortController();
    const connecting = connectMcpTransport(client, transport, controller.signal);
    controller.abort(new Error("test timeout"));

    await expect(connecting).rejects.toThrow("initialization was interrupted");
    expect(closes).toBe(1);
  });

  test("supervises the stdio process group and rejects oversized frames before JSON parsing", async () => {
    const child = new FakeMcpChild();
    const launches: Array<{ detached: boolean; cwd: string }> = [];
    const terminations: Array<{ pid: number; platform: NodeJS.Platform }> = [];
    const errors: Error[] = [];
    let messages = 0;
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", cwd: "/workspace" },
      {
        platform: "linux",
        spawnProcess: (_command, _args, options) => {
          launches.push({ detached: options.detached, cwd: options.cwd });
          return child.asChildProcess();
        },
        terminateProcessTree: async (pid, platform) => {
          terminations.push({ pid, platform });
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return true;
        },
      },
    );
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = () => {
      messages += 1;
    };
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65));
    await flushMicrotasks();
    await transport.close();

    expect(launches).toEqual([{ detached: true, cwd: "/workspace" }]);
    expect(terminations).toEqual([{ pid: child.pid, platform: "linux" }]);
    expect(errors.some((error) => error.message.includes("transport frame limit"))).toBe(true);
    expect(messages).toBe(0);
  });

  test("fails cleanup when stdio process-tree termination is not verified", async () => {
    const child = new FakeMcpChild();
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", cwd: "C:\\workspace" },
      {
        platform: "win32",
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async () => false,
      },
    );
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    await expect(transport.close()).rejects.toThrow("process tree cleanup failed");
  });
});
