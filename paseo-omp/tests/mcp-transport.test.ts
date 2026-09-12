import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, test } from "vitest";
import {
  closeMcpOwnership,
  connectMcpServer,
  connectMcpTransport,
  createBoundedMcpFetch,
  SupervisedStdioClientTransport,
} from "../server/provider/mcp-transport";
import { startFetchServer } from "./helpers/http-server";

const testOnPosix = process.platform === "win32" ? test.skip : test;

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

  test("does not require tree cleanup when stdio spawn fails before owning a PID", async () => {
    const child = new FakeMcpChild();
    Object.defineProperty(child, "pid", { value: undefined });
    const terminations: number[] = [];
    const transport = new SupervisedStdioClientTransport(
      { command: "missing-mcp-server", cwd: "/workspace" },
      {
        platform: "linux",
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async (pid) => {
          terminations.push(pid);
          return false;
        },
      },
    );
    const starting = transport.start();
    child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));

    await expect(starting).rejects.toThrow("spawn failed");
    await expect(transport.close()).resolves.toBeUndefined();
    expect(terminations).toEqual([]);
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

  test("awaits spontaneous stdio tree cleanup after the SDK client clears its transport", async () => {
    const child = new FakeMcpChild();
    const treeCleanup = Promise.withResolvers<boolean>();
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", cwd: "/workspace" },
      {
        platform: "linux",
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async () => await treeCleanup.promise,
      },
    );
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    child.emit("exit", 1, null);

    const closing = closeMcpOwnership({ close: async () => {} }, transport);
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flushMicrotasks();
    expect(settled).toBe(false);
    treeCleanup.resolve(false);
    await expect(closing).rejects.toThrow("transport cleanup failed");
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

  test("sends requests, decodes fragmented responses, and closes exactly once", async () => {
    const child = new FakeMcpChild();
    const writes: string[] = [];
    child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", args: ["--stdio"], env: { TEST_FLAG: "1" }, cwd: "/workspace" },
      {
        platform: "linux",
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async () => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return true;
        },
      },
    );
    const messages: unknown[] = [];
    let closes = 0;
    transport.onmessage = (message) => messages.push(message);
    transport.onclose = () => {
      closes += 1;
    };
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(
      "transport is closed",
    );
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(writes.join("")).toContain('"method":"ping"');
    child.stdout.write('{"jsonrpc":"2.0","id":1,');
    child.stdout.write('"result":{"ok":true}}\n');
    await flushMicrotasks();
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    await transport.close();
    await transport.close();
    expect(closes).toBe(1);
  });

  test("passes bounded ordinary responses and completes successful MCP connection", async () => {
    const boundedFetch = createBoundedMcpFetch(async () =>
      Response.json({ ok: true }, { headers: { "content-length": "11" } }),
    );
    await expect((await boundedFetch("http://127.0.0.1/mcp")).json()).resolves.toEqual({
      ok: true,
    });
    let connectedSignal: AbortSignal | undefined;
    let closes = 0;
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {
        closes += 1;
      },
    };
    const controller = new AbortController();
    await connectMcpTransport(
      {
        async connect(_transport, options) {
          connectedSignal = options?.signal;
        },
      },
      transport,
      controller.signal,
    );
    expect(connectedSignal).toBe(controller.signal);
    await closeMcpOwnership({ close: async () => {} }, transport);
    expect(closes).toBe(1);
  });

  testOnPosix("uses the real stdio boundary for one request and response", async () => {
    const transport = new SupervisedStdioClientTransport({
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.once("data",()=>process.stdout.write('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\\n'))`,
      ],
      cwd: process.cwd(),
    });
    const message = Promise.withResolvers<unknown>();
    transport.onmessage = message.resolve;
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    await expect(message.promise).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    await transport.close();
  });

  test("reports a partial stdio frame before completing cleanup", async () => {
    const child = new FakeMcpChild();
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", cwd: "/workspace" },
      {
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async () => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return true;
        },
      },
    );
    const error = Promise.withResolvers<Error>();
    transport.onerror = error.resolve;
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    child.stdout.write('{"jsonrpc":');
    child.stdout.end();
    await expect(error.promise).resolves.toHaveProperty(
      "message",
      "MCP stdio response ended mid-frame",
    );
    await transport.close();
  });

  test("closes the stdio owner when its input channel fails", async () => {
    const child = new FakeMcpChild();
    const transport = new SupervisedStdioClientTransport(
      { command: "mcp-server", cwd: "/workspace" },
      {
        spawnProcess: () => child.asChildProcess(),
        terminateProcessTree: async () => {
          queueMicrotask(() => child.emit("exit", 1, null));
          return true;
        },
      },
    );
    const observed = Promise.withResolvers<Error>();
    transport.onerror = observed.resolve;
    const starting = transport.start();
    child.emit("spawn");
    await starting;
    child.stdin.emit("error", new Error("input failed"));
    await expect(observed.promise).resolves.toHaveProperty("message", "input failed");
    await transport.close();
  });

  test("lists and calls tools through the bounded HTTP transport", async () => {
    const server = await startFetchServer(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const payload = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const result =
        payload.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "bounded-http-test", version: "1" },
            }
          : payload.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Echo input",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: JSON.stringify(payload.params) }],
              };
      return Response.json({ jsonrpc: "2.0", id: payload.id, result });
    });
    const controller = new AbortController();
    try {
      const client = await connectMcpServer(
        "remote",
        { type: "http", url: `http://127.0.0.1:${server.port}` },
        process.cwd(),
        controller.signal,
      );
      await expect(client.listTools({ signal: controller.signal })).resolves.toEqual({
        tools: [expect.objectContaining({ name: "echo" })],
      });
      await expect(
        client.callTool(
          "echo",
          { value: "ok" },
          { signal: controller.signal, onProgress() {}, maxTotalTimeoutMs: 5_000 },
        ),
      ).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });
      await client.close();
    } finally {
      server.stop(true);
    }
  });
});
