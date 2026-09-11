import { describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  buildOmpSpawnRequest,
  collectAmbientMcpSecrets,
  type OmpMcpFileOps,
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
const TEST_RUNTIME_ENV: NodeJS.ProcessEnv = {
  HOME: "/__paseo_omp_test_no_home__",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
  PI_CONFIG_DIR: ".omp-no-config",
};

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
function writeChunked(child: FakeRpcChild, frame: Record<string, unknown>, chunkId: string): void {
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
    environment: TEST_RUNTIME_ENV,
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
    const modelSelector = `${"p".repeat(256)}/${"m".repeat(256)}`;
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
      model: modelSelector,
    });
    child.write(READY_FRAME);
    const session = await opening;

    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--resume", "native-session-42"]));
    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--model", modelSelector]));
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

  test("accepts 1,024 branch entries and isolates an oversized response", async () => {
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
          messages: Array.from({ length: 1_024 }, (_, index) => ({
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
    expect(messages).toHaveLength(1_024);
    expect(messages.at(-1)).toEqual({ entryId: "entry-1023", text: "x" });
    await session.close();
  });

  test("enforces chunked UTF-8 assistant and image boundaries without stale corruption", async () => {
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
    const terminal = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_end") terminal.resolve();
    });

    const nearText = "é".repeat((1024 * 1024) / 2);
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "text", content: nearText },
      },
      "near-text",
    );
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "oversized-text", content: `${nearText}é` },
      },
      "oversized-text",
    );
    const imageData = "A".repeat(8 * 1024 * 1024);
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "image", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: imageData, mimeType: "image/png" },
        },
      },
      "near-image",
    );
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "oversized-image", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: `${imageData}AAAA`, mimeType: "image/png" },
        },
      },
      "oversized-image",
    );
    child.write({
      type: "agent_end",
      messages: Array.from({ length: 513 }, () => ({ role: "assistant", content: "ok" })),
      messageCount: 513,
      isTerminal: true,
    });
    await terminal.promise;

    expect(events).toHaveLength(3);
    const receivedText = events[0];
    expect(receivedText?.type === "message_update" ? receivedText.message.content : null).toBe(
      nearText,
    );
    const receivedImage = events[1];
    expect(
      receivedImage?.type === "message_update" &&
        receivedImage.assistantMessageEvent?.content &&
        typeof receivedImage.assistantMessageEvent.content === "object" &&
        "data" in receivedImage.assistantMessageEvent.content
        ? receivedImage.assistantMessageEvent.content.data
        : null,
    ).toBe(imageData);
    expect(events[2]).toEqual({
      type: "agent_end",
      messageCount: 513,
      isTerminal: true,
    });
    expect(
      events.some(
        (event) =>
          event.type === "message_update" &&
          (event.message.responseId === "oversized-text" ||
            event.message.responseId === "oversized-image"),
      ),
    ).toBe(false);
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

    child.write({ type: "agent_end", messages: "not-an-array", isTerminal: false });
    child.writeRaw(`${"x".repeat(1_048_577)}\n`);
    child.write({
      type: "rpc_chunk",
      chunkId: "bad-order",
      index: 1,
      count: 2,
      byteLength: 4,
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
  for (const chunking of ["same stdout chunk", "separate stdout chunks"] as const) {
    test(`isolates a complete oversized physical line from a valid frame in ${chunking}`, async () => {
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
      const observed: OmpRpcEvent[] = [];
      const unsubscribe = session.onEvent((event) => observed.push(event));
      const oversized = "x".repeat(1_048_577);
      const valid = JSON.stringify({ type: "notice", level: "info", message: "still healthy" });

      if (chunking === "same stdout chunk") child.writeRaw(`${oversized}\n${valid}\n`);
      else {
        child.writeRaw(`${oversized}\n`);
        child.writeRaw(`${valid}\n`);
      }

      expect(observed).toContainEqual({
        type: "notice",
        level: "info",
        message: "still healthy",
      });
      unsubscribe();
      await session.close();
    });
  }

  test("fails the runtime on a complete oversized physical frame", async () => {
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
    const failure = nextEvent((listener) => session.onEvent(listener));
    child.writeRaw(`${"x".repeat(12 * 1024 * 1024 + 1)}\n`);
    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC frame exceeds the semantic byte limit",
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

  test("preserves frame-valid tool payloads and isolates malformed events", async () => {
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
    const noticeDelivered = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") noticeDelivered.resolve();
    });

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
      toolCallId: "large-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, (_, index) => `value-${index}`),
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
    await noticeDelivered.promise;

    expect(events).toHaveLength(2);
    const toolEvent = events[0];
    if (toolEvent?.type !== "tool_execution_start" || !Array.isArray(toolEvent.args)) {
      throw new Error("Expected preserved tool event");
    }
    expect(toolEvent.args).toHaveLength(513);
    expect(events[1]).toEqual({
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
    const proxy = "https://proxy-user:proxy-pass@example.test?token=proxy-token";
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        model: "provider/model; touch /tmp/not-run",
        env: { TEST_ENV: "explicit", CUSTOMER_API_KEY: "session-secret" },
      },
      {
        ...TEST_RUNTIME_ENV,
        OMP_COMMAND: "/opt/omp/bin/omp",
        HOME: "/home/runner",
        HTTPS_PROXY: proxy,
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
      PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
      PI_CONFIG_DIR: ".omp-no-config",
      HOME: "/home/runner",
      HTTPS_PROXY: proxy,
      OPENAI_API_KEY: "daemon-secret",
      TEST_ENV: "explicit",
      CUSTOMER_API_KEY: "session-secret",
    });
    expect(request.sensitiveValues).toEqual(
      expect.arrayContaining(["proxy-user", "proxy-pass", "proxy-token"]),
    );
    expect(request.env.UNRELATED_DAEMON_VALUE).toBeUndefined();
    expect(request.env.NODE_OPTIONS).toBeUndefined();
    expect(request.env.RANDOM_TOKEN).toBeUndefined();
    expect(request.env.node_options).toBeUndefined();
    const benignShortValues = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: { DEBUG: "1", NODE_ENV: "dev" } },
      TEST_RUNTIME_ENV,
    );
    expect(benignShortValues.env).toEqual({
      ...TEST_RUNTIME_ENV,
      DEBUG: "1",
      NODE_ENV: "dev",
    });
    expect(benignShortValues.sensitiveValues).toEqual([]);
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { API_TOKEN: "x" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("credential is too short");
    for (const proxy of [
      "https://abc:long-password@example.test",
      "https://example.test?token=xyz",
    ]) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { HTTPS_PROXY: proxy } },
          TEST_RUNTIME_ENV,
        ),
      ).toThrow("proxy credential is too short");
    }
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { LD_PRELOAD: "/tmp/evil.so" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { node_options: "--require attacker.js" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    for (const name of [
      "PI_CONFIG_FILES",
      "PI_SHELL_PREFIX",
      "CLAUDE_CODE_SHELL_PREFIX",
      "PI_CODING_AGENT_SESSION_DIR",
      "OMP_WORKTREE_DIR",
      "XDG_DATA_HOME",
      "PATH",
      "HOME",
      "LD_PRELOAD",
      "NODE_OPTIONS",
    ].flatMap((name) => [name, name.toLowerCase()])) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { [name]: "/tmp/redirect" } },
          TEST_RUNTIME_ENV,
        ),
      ).toThrow("forbidden variable");
    }
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full" },
        { ...TEST_RUNTIME_ENV, OPENAI_API_KEY: "x" },
      ),
    ).toThrow("too short");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "x".repeat(64 * 1024 + 1) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "é".repeat(40_000) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() => buildOmpSpawnRequest({ cwd: "relative", mode: "full" }, TEST_RUNTIME_ENV)).toThrow(
      "absolute",
    );
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
            url: "https://user%40name:pass%20word@example.test/long%2Dsecret%2Dpath?token=url%2Dsecret&code=long%2Dprivate%2Dvalue",
            headers: {
              Authorization: "Bearer header-secret",
              "X-License": "license-secret",
              "User-Agent": "agent-secret",
            },
          },
          local: {
            type: "stdio",
            command: "server",
            env: {
              API_KEY: "env-secret",
              CUSTOM_VALUE: "custom-secret",
              DEBUG: "1",
              NODE_ENV: "dev",
            },
          },
          debugSecret: {
            type: "stdio",
            command: "server",
            env: { DEBUG: "debug-secret" },
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
          "https://user%40name:pass%20word@example.test/long%2Dsecret%2Dpath?token=url%2Dsecret&code=long%2Dprivate%2Dvalue",
          "user@name",
          "pass word",
          "url-secret",
          "long-secret-path",
          "long-private-value",
          "Bearer header-secret",
          "env-secret",
          "license-secret",
          "custom-secret",
          "agent-secret",
          "debug-secret",
        ]),
      );
      expect(request.sensitiveValues).not.toContain("1");
      for (const config of [
        {
          servers: {
            unsafe: { type: "http", url: "https://example.test", headers: { "X-License": "abc" } },
          },
        },
        { servers: { unsafe: { type: "stdio", command: "server", env: { PIN: "123" } } } },
        { servers: { unsafe: { type: "http", url: "https://user:abc@example.test/mcp" } } },
        { servers: { unsafe: { type: "http", url: "https://example.test/mcp?token=xyz" } } },
      ]) {
        writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(config));
        expect(() =>
          buildOmpSpawnRequest(
            { cwd: root, mode: "full" },
            { PATH: "/usr/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
          ),
        ).toThrow("credential is too short");
      }
      writeFileSync(
        join(agentDir, "mcp.json"),
        JSON.stringify({
          servers: { unsafe: { type: "stdio", command: "server", env: { token: "x" } } },
        }),
      );
      const isolated = buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", environment: TEST_RUNTIME_ENV },
        { PATH: "/usr/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
      );
      expect(isolated.sensitiveValues).toEqual([]);
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: root, mode: "full" },
          { PATH: "/usr/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
        ),
      ).toThrow("credential is too short");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opens MCP candidates nonblocking and never reads non-regular descriptors", () => {
    const opens: Array<{ path: string; flags: number }> = [];
    const closed: number[] = [];
    let reads = 0;
    const fileOps: OmpMcpFileOps = {
      open(path, flags) {
        opens.push({ path, flags });
        return opens.length;
      },
      stat() {
        return { size: 0, isFile: () => false };
      },
      read() {
        reads += 1;
        return 0;
      },
      close(descriptor) {
        closed.push(descriptor);
      },
    };

    expect(collectAmbientMcpSecrets("/repo", { HOME: "/home/runner" }, fileOps)).toEqual([]);
    expect(opens.map(({ path }) => path)).toEqual([
      "/home/runner/.omp/agent/mcp.json",
      "/repo/.omp/mcp.json",
    ]);
    expect(opens.every(({ flags }) => (flags & constants.O_NONBLOCK) !== 0)).toBe(true);
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow === "number" && noFollow !== 0) {
      expect(opens.every(({ flags }) => (flags & noFollow) !== 0)).toBe(true);
    }
    expect(reads).toBe(0);
    expect(closed).toEqual([1, 2]);
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
      environment: TEST_RUNTIME_ENV,
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
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });
  test("treats uncertain injected process-tree cleanup as unsuccessful", async () => {
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
      terminateProcessTree: () => Promise.resolve("uncertain"),
      environment: TEST_RUNTIME_ENV,
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
        environment: TEST_RUNTIME_ENV,
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
