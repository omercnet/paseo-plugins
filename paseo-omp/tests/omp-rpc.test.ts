import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type OmpRpcEvent, OmpRpcRuntime, type OmpSpawnRequest } from "../server/provider/omp-rpc";

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

    expect(launches[0]?.args).toEqual(
      expect.arrayContaining(["--resume", "native-session-42"]),
    );
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
    await expect(imageEvent).resolves.toEqual(
      expect.objectContaining({
        type: "message_update",
        assistantMessageEvent: expect.objectContaining({ type: "image_end", contentIndex: 0 }),
      }),
    );

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
    await expect(textEvent).resolves.toEqual(
      expect.objectContaining({
        type: "message_update",
        assistantMessageEvent: expect.objectContaining({ type: "text_delta", contentIndex: 1 }),
      }),
    );

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

  test("fails a malformed recognized event exactly once", async () => {
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

    child.write({ type: "agent_end", messages: "not-an-array" });

    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP emitted a malformed agent_end frame",
    });
    await session.close();
  });

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
