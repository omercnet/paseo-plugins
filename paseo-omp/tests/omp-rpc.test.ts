import { describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  buildOmpSpawnRequest,
  type OmpRpcEvent,
  OmpRpcRuntime,
  type OmpSpawnRequest,
  terminatePosixProcessTree,
} from "../server/provider/omp-rpc";

const READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
} as const;

class FakeRpcChild extends EventEmitter {
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

function observeCommands(
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

function runtimeFor(child: FakeRpcChild, launches: OmpSpawnRequest[] = []): OmpRpcRuntime {
  return new OmpRpcRuntime({
    spawnProcess(request) {
      launches.push(request);
      return child.asChildProcess();
    },
    terminateProcessTree: () => Promise.resolve(true),
  });
}

function nextEvent(
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

describe("OMP RPC transport", () => {
  test("accepts the real ready frame and a dataless steer response", async () => {
    const child = new FakeRpcChild();
    const launches: OmpSpawnRequest[] = [];
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "steer") {
        child.write({
          type: "response",
          id: command.id,
          command: "steer",
          success: true,
        });
      }
    });
    const runtime = runtimeFor(child, launches);
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const promptResult = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "prompt_result", id: "prompt-1", agentInvoked: false });
    await expect(promptResult).resolves.toEqual({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    });

    await session.steer("focus");

    expect(launches[0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--mode", "rpc-ui", "--approval-mode", "yolo"]),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "negotiate_protocol", protocolVersion: 2 }),
    );
    expect(commands).toContainEqual({
      type: "steer",
      message: "focus",
      id: expect.any(String),
    });
    await session.close();
  });

  test("passes an exact native session handle to OMP resume", async () => {
    const child = new FakeRpcChild();
    const launches: OmpSpawnRequest[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child, launches).startSession({
      cwd: "/repo",
      mode: "full",
      resumeSessionId: "native-session-42",
    });
    child.write(READY_FRAME);
    const session = await opening;

    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--resume", "native-session-42"]));
    await session.close();
  });

  test("accepts image stream events and blocked todos without breaking later frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const imageEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    });
    await expect(imageEvent).resolves.toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    });

    const textEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });
    await expect(textEvent).resolves.toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });

    const todoEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "todo_reminder",
      todos: [{ id: "blocked-1", content: "Waiting", status: "blocked" }],
    });
    await expect(todoEvent).resolves.toEqual({
      type: "todo_reminder",
      todos: [{ id: "blocked-1", content: "Waiting", status: "blocked" }],
    });

    const commandsEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await expect(commandsEvent).resolves.toEqual({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await session.close();
  });

  test("rejects incomplete ready metadata instead of guessing v1", async () => {
    const child = new FakeRpcChild();
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready", protocolVersion: 1 });

    await expect(opening).rejects.toThrow("incomplete protocol metadata");
  });

  test("rejects an invalid v2 negotiation result", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 1 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);

    await expect(opening).rejects.toThrow();
  });

  test("accepts a metadata-free legacy ready frame as v1", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "get_state") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "legacy",
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready" });
    const session = await opening;

    expect(await session.getState()).toEqual(
      expect.objectContaining({ sessionId: "legacy", isStreaming: false }),
    );
    expect(commands.some((command) => command.type === "negotiate_protocol")).toBe(false);
    await session.close();
  });

  test("reassembles bounded v2 chunk frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_state") return;
      const payload = Buffer.from(
        JSON.stringify({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "chunked",
          },
        }),
      );
      const split = Math.ceil(payload.byteLength / 2);
      const parts = [payload.subarray(0, split), payload.subarray(split)];
      for (const [index, part] of parts.entries()) {
        child.write({
          type: "rpc_chunk",
          chunkId: "chunk-1",
          index,
          count: parts.length,
          byteLength: payload.byteLength,
          data: part.toString("base64"),
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    expect(await session.getState()).toEqual(expect.objectContaining({ sessionId: "chunked" }));
    await session.close();
  });

  test("accepts 513 branch entries and isolates an oversized response", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_branch_messages") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: {
          messages: Array.from({ length: 1_025 }, (_, index) => ({
            entryId: `bad-${index}`,
            text: "x",
          })),
        },
      });
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: {
          messages: Array.from({ length: 513 }, (_, index) => ({
            entryId: `entry-${index}`,
            text: "x",
          })),
        },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const messages = await session.getBranchMessages();
    expect(messages).toHaveLength(513);
    expect(messages.at(-1)).toEqual({ entryId: "entry-512", text: "x" });
    await session.close();
  });

  test("isolates malformed recognized and physical frames from later valid events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({ type: "agent_end", messages: "not-an-array" });
    child.writeRaw(`${"x".repeat(1_048_577)}\n`);
    child.write({
      type: "rpc_chunk",
      chunkId: "bad-order",
      index: 1,
      count: 2,
      byteLength: 4,
      data: "e30=",
    });
    child.write({
      type: "rpc_chunk",
      chunkId: "semantic-overflow",
      index: 0,
      count: 1,
      byteLength: 13 * 1024 * 1024,
      data: "e30=",
    });
    for (let index = 0; index < 100; index += 1) {
      child.write({ type: `unknown_${index}`, detail: "API_KEY=must-not-surface" });
    }
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });

  test("preserves validated events internally while keeping stderr out of failures", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({
      cwd: "/repo",
      mode: "full",
      env: { OPENAI_API_KEY: "credential-value-1234" },
    });
    child.write(READY_FRAME);
    const session = await opening;
    const notice = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });
    expect(await notice).toEqual({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });

    const exit = nextEvent((listener) => session.onEvent(listener));
    child.stderr.write("OPENAI_API_KEY=credential-value-1234 /home/private/config raw stderr");
    child.close(7);
    expect(await exit).toEqual({ type: "process_exit", error: "OMP RPC process exited (code 7)" });
    await session.close();
  });

  test("rejects frame-valid semantic overflows without poisoning later events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({
      type: "todo_reminder",
      todos: Array.from({ length: 257 }, (_, index) => ({
        id: `todo-${index}`,
        content: "bounded",
        status: "pending",
      })),
    });
    child.write({
      type: "tool_execution_start",
      toolCallId: "oversized-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, () => null),
    });
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      },
      assistantMessageEvent: { type: "image_end", contentIndex: 0 },
    });
    child.write({ type: "notice", level: "warning", message: "valid after rejected frames" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "warning",
      message: "valid after rejected frames",
    });
    await session.close();
  });

  test("bounds cumulative streamed text while retaining later protocol events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const recovered = Promise.withResolvers<OmpRpcEvent>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") recovered.resolve(event);
    });
    child.write({
      type: "message_start",
      message: { role: "assistant", responseId: "bounded", content: [] },
    });
    for (let index = 0; index < 5; index += 1) {
      child.write({
        type: "message_update",
        message: { role: "assistant", responseId: "bounded", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(900_000) },
      });
    }
    child.write({ type: "notice", level: "info", message: "after stream bound" });
    await recovered.promise;

    expect(events.filter((event) => event.type === "message_update")).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "notice", level: "info", message: "after stream bound" });
    await session.close();
  });

  test("drops spoofed lifecycle and malformed permission frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "process_exit", error: "spoofed", sessionId: "other-session" });
    child.write({ type: "extension_ui_request", id: "permission", method: 42, approved: true });
    child.write({
      type: "notice",
      level: "info",
      message: "safe",
      sessionId: "other-session",
      capabilities: ["admin"],
    });

    await expect(recovered).resolves.toEqual({ type: "notice", level: "info", message: "safe" });
    await session.close();
  });

  test("builds argv-only launches with a minimal authenticated environment", () => {
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        model: "provider/model; touch /tmp/not-run",
        env: { TEST_ENV: "explicit", CUSTOMER_API_KEY: "session-secret" },
      },
      {
        OMP_COMMAND: "/opt/omp/bin/omp",
        PATH: "/usr/bin",
        HOME: "/home/runner",
        OPENAI_API_KEY: "daemon-secret",
        UNRELATED_DAEMON_VALUE: "must-not-pass",
        NODE_OPTIONS: "--require attacker.js",
        RANDOM_TOKEN: "must-not-pass-either",
        node_options: "--require lower-case-attacker.js",
      },
    );

    expect(request.command).toBe("/opt/omp/bin/omp");
    expect(request.args).toContain("provider/model; touch /tmp/not-run");
    expect(request.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      OPENAI_API_KEY: "daemon-secret",
      TEST_ENV: "explicit",
      CUSTOMER_API_KEY: "session-secret",
    });
    expect(request.env.UNRELATED_DAEMON_VALUE).toBeUndefined();
    expect(request.env.NODE_OPTIONS).toBeUndefined();
    expect(request.env.RANDOM_TOKEN).toBeUndefined();
    expect(request.env.node_options).toBeUndefined();
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { LD_PRELOAD: "/tmp/evil.so" } },
        { PATH: "/usr/bin" },
      ),
    ).toThrow("forbidden variable");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { node_options: "--require attacker.js" } },
        { PATH: "/usr/bin" },
      ),
    ).toThrow("forbidden variable");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full" },
        { PATH: "/usr/bin", OPENAI_API_KEY: "x" },
      ),
    ).toThrow("too short");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "x".repeat(64 * 1024 + 1) },
        { PATH: "/usr/bin" },
      ),
    ).toThrow("system prompt");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "é".repeat(40_000) },
        { PATH: "/usr/bin" },
      ),
    ).toThrow("system prompt");
    expect(() =>
      buildOmpSpawnRequest({ cwd: "relative", mode: "full" }, { PATH: "/usr/bin" }),
    ).toThrow("absolute");
  });

  test("collects ambient MCP URL, header, and environment secrets for redaction", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-omp-mcp-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".omp"));
    writeFileSync(join(root, ".omp", "mcp.json"), "{not-json");
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://user%40name:pass%20word@example.test/mcp?token=url%2Dsecret",
            headers: { Authorization: "Bearer header-secret" },
          },
          local: {
            type: "stdio",
            command: "server",
            env: { API_KEY: "env-secret", DEBUG: "1" },
          },
        },
      }),
    );
    try {
      const request = buildOmpSpawnRequest(
        { cwd: root, mode: "full" },
        { PATH: "/usr/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
      );
      expect(request.sensitiveValues).toEqual(
        expect.arrayContaining([
          "https://user%40name:pass%20word@example.test/mcp?token=url%2Dsecret",
          "user@name",
          "pass word",
          "url-secret",
          "Bearer header-secret",
          "env-secret",
        ]),
      );
      expect(request.sensitiveValues).not.toContain("1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminates a surviving POSIX process group after its leader exited", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    let descendantsAlive = true;
    const stopped = await terminatePosixProcessTree(
      42,
      0,
      (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") descendantsAlive = false;
        if (signal === 0 && !descendantsAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
      () => Promise.resolve(),
    );

    expect(stopped).toBe(true);
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
  });

  test("starts descendant cleanup once when the leader exit is observed", async () => {
    const child = new FakeRpcChild();
    const cleanup = Promise.withResolvers<boolean>();
    const cleanedPids: number[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree(pid) {
        cleanedPids.push(pid);
        return cleanup.promise;
      },
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    child.close(7);
    expect(cleanedPids).toEqual([child.pid]);
    const closing = session.close();
    cleanup.resolve(true);
    await closing;
    expect(cleanedPids).toEqual([child.pid]);
  });

  test("surfaces unverified process-tree cleanup", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(false),
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });

  if (process.platform !== "win32") {
    test("session close terminates descendants left by an exited POSIX leader", async () => {
      const script = `
        const { spawn } = require("node:child_process");
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: false,
          stdio: "ignore",
        });
        descendant.unref();
        process.stdout.write(JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }) + "\\n");
        let input = "";
        process.stdin.on("data", chunk => {
          input += String(chunk);
          const newline = input.indexOf("\\n");
          if (newline < 0) return;
          const command = JSON.parse(input.slice(0, newline));
          process.stdout.write(JSON.stringify({ type: "notice", level: "info", message: String(descendant.pid) }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "response",
            id: command.id,
            success: true,
            data: { model: null, isStreaming: false, isCompacting: false, sessionId: "tree" },
          }) + "\\n");
        });
        process.stdin.on("end", () => process.exit(0));
      `;
      const runtime = new OmpRpcRuntime({
        spawnProcess(request) {
          return spawn(process.execPath, ["-e", script], {
            cwd: request.cwd,
            env: request.env,
            detached: request.detached,
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
      });
      const session = await runtime.startSession({ cwd: process.cwd(), mode: "full" });
      const descendantPid = nextEvent((listener) => session.onEvent(listener));
      await session.getState();
      const notice = await descendantPid;
      if (notice.type !== "notice") throw new Error("Expected descendant PID notice");
      const pid = Number(notice.message);
      try {
        await session.close();
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    });
  }

  test("fails the session once when child stdin closes with EPIPE", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));

    child.stdin.destroy(new Error("EPIPE"));

    const event = await failure;
    expect(event.type).toBe("process_exit");
    await expect(session.steer("after-close")).rejects.toThrow();
    await session.close();
  });
});
