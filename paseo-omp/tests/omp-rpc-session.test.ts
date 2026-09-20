import { describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import type { OmpSpawnRequest } from "../server/provider/omp-rpc-environment";
import type {
  OmpProtocolViolationDiagnostic,
  OmpRpcEvent,
} from "../server/provider/omp-rpc-protocol";
import {
  FakeRpcChild,
  nextEvent,
  observeCommands,
  READY_FRAME,
  runtimeFor,
  TEST_RUNTIME_ENV,
  writeChunked,
} from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
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

  test("does not release queued-write capacity when requests time out", async () => {
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
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      requestTimeoutMs: 0,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const writeCallbacks: Array<() => void> = [];
    Object.defineProperty(child.stdin, "write", {
      configurable: true,
      value: (_chunk: unknown, callback?: () => void) => {
        if (callback) writeCallbacks.push(callback);
        return false;
      },
    });
    const largePrompt = "x".repeat(900_000);

    for (let index = 0; index < 9; index += 1) {
      await expect(session.prompt(largePrompt)).rejects.toThrow("request timed out");
    }
    await expect(session.prompt(largePrompt)).rejects.toThrow("too many pending requests");
    expect(writeCallbacks).toHaveLength(9);
    for (const callback of writeCallbacks.splice(0)) callback();
    await expect(session.prompt(largePrompt)).rejects.toThrow("request timed out");

    child.close();
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
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    await expect(imageEvent).resolves.toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
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
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
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
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
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

  test("accepts OMP 18.2 passive and streamed-tool events without protocol violations", async () => {
    const child = new FakeRpcChild();
    const diagnostics: OmpProtocolViolationDiagnostic[] = [];
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
    const opening = runtimeFor(child, [], undefined, (diagnostic) => {
      diagnostics.push(diagnostic);
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const complete = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (events.length === 6) complete.resolve();
    });

    child.write({ type: "config_warnings_changed" });
    child.write({ type: "advisor_cost_changed" });
    child.write({ type: "ttsr_triggered", rules: [{ id: "rule", content: "safe" }] });
    child.write({
      type: "irc_message",
      message: { role: "custom", customType: "irc", content: "hello", display: true },
    });
    child.write({ type: "tool_execution_start", toolCallId: "call", toolName: "edit", args: {} });
    child.write({
      type: "tool_stream_update",
      toolCallId: "call",
      toolName: "edit",
      update: { lines: 2 },
    });
    await complete.promise;

    expect(events.map((event) => event.type)).toEqual([
      "config_warnings_changed",
      "advisor_cost_changed",
      "ttsr_triggered",
      "irc_message",
      "tool_execution_start",
      "tool_stream_update",
    ]);
    expect(diagnostics).toEqual([]);
    await session.close();
  });

  test("rejects incomplete ready metadata instead of guessing v1", async () => {
    const child = new FakeRpcChild();
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready", protocolVersion: 1 });

    await expect(opening).rejects.toThrow("incomplete protocol metadata");
  });

  test("rejects a frame limit too small for a maximum-ID terminal host result", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ ...READY_FRAME, maxFrameBytes: 400 });

    await expect(opening).rejects.toThrow("cannot carry terminal host tool results");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
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

  test("rejects a metadata-free legacy ready frame before opening a session", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready" });

    await expect(opening).rejects.toThrow("requires OMP RPC protocol v2");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  test("accepts nullable usage and sparse compaction payloads", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      const response = {
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
      };
      if (command.type === "negotiate_protocol") {
        child.write({ ...response, data: { protocolVersion: 2 } });
        return;
      }
      if (command.type === "get_state") {
        child.write({
          ...response,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "nullable-usage",
            contextUsage: { tokens: null, contextWindow: null, percent: null },
          },
        });
      } else if (command.type === "get_session_stats") {
        child.write({
          ...response,
          data: {
            tokens: { input: null, output: null, cacheRead: null },
            cost: null,
            contextUsage: null,
          },
        });
      } else if (command.type === "compact") {
        child.write({ ...response, data: {} });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const compactionEvent = nextEvent((listener) => session.onEvent(listener));

    expect(await session.getState()).toEqual(
      expect.objectContaining({
        contextUsage: { tokens: null, contextWindow: null, percent: null },
      }),
    );
    expect(await session.getSessionStats()).toEqual({
      tokens: { input: null, output: null, cacheRead: null },
      cost: null,
      contextUsage: null,
    });
    expect(await session.compact()).toEqual({});
    child.write({ type: "auto_compaction_end", aborted: false, willRetry: false });
    await expect(compactionEvent).resolves.toEqual(
      expect.objectContaining({ type: "auto_compaction_end" }),
    );
    await session.close();
  });

  test("omits invalid optional state usage and rejects invalid session metrics", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      const response = {
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
      };
      if (command.type === "negotiate_protocol") {
        child.write({ ...response, data: { protocolVersion: 2 } });
        return;
      }
      if (command.type === "get_state") {
        child.write({
          ...response,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "invalid-usage",
            contextUsage: { tokens: 1.5, contextWindow: 200_000, percent: 0.1 },
          },
        });
      } else if (command.type === "get_session_stats") {
        child.write({
          ...response,
          data: {
            tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 0, cacheRead: 0 },
            cost: 0,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getState()).resolves.toEqual({
      model: null,
      isStreaming: false,
      isCompacting: false,
      sessionId: "invalid-usage",
    });
    await expect(session.getSessionStats()).rejects.toThrow();
    await session.close();
  });

  test("counts escaped JSON bytes in command response limits", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_session_stats") {
        writeChunked(
          child,
          {
            type: "response",
            id: command.id,
            success: true,
            data: { escaped: "\u0001".repeat(360_000) },
          },
          "escaped-json-response",
        );
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.getSessionStats()).rejects.toThrow("response exceeded command limits");
    await session.close();
  });
});
