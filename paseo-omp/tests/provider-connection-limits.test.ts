import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  createHarness,
  EventLog,
  FakeOmpRuntime,
  finishTurn,
  MODEL,
  openSession,
  ProviderRpcChild,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("bounds concurrent session opens before starting excess runtimes", async () => {
    const runtime = new FakeOmpRuntime();
    const gate = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    const { connection, events } = await createHarness(runtime);
    for (let index = 0; index < 33; index += 1) {
      await connection.send({
        type: "session.open",
        requestId: `bounded-open-${index}`,
        sessionId: `bounded-session-${index}`,
        config: {
          cwd: "/repo",
          env: { TEST_ENV: "test-value" },
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });
    }
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "bounded-open-32",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ error: { message: "OMP session limit reached" } }),
    );
    expect(runtime.starts).toHaveLength(32);
    gate.resolve();
    await connection.close();
  });
  test("bounds connection-wide active operations before dispatch", async () => {
    const runtime = new FakeOmpRuntime();
    const gate = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    const { connection } = await createHarness(runtime);
    for (let index = 0; index < 128; index += 1) {
      await connection.send({ type: "catalog", requestId: `catalog-${index}`, cwd: "/repo" });
    }
    await expect(
      connection.send({ type: "catalog", requestId: "catalog-overflow", cwd: "/repo" }),
    ).rejects.toThrow("busy");
    gate.resolve();
    await connection.close();
  });

  test("retains a closing session ID and fences its late events", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const oldSession = sessionAt(runtime);
    const staleListener = [...oldSession.listeners][0];
    if (!staleListener) throw new Error("Expected native event listener");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    oldSession.closeGate = gate.promise;
    oldSession.closeObserved = observed.resolve;
    await connection.send({
      type: "session.close",
      requestId: "close-old",
      sessionId: "session-1",
    });
    await observed.promise;
    await connection.send({
      type: "session.open",
      requestId: "open-too-early",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "open-too-early",
    );
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-old",
    );
    await openSession(connection, events, "open-replacement", "session-1");
    const baseline = events.length;
    staleListener({ type: "notice", level: "error", message: "stale-secret" });
    expect(events).toHaveLength(baseline);
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });

  test("preserves late terminal data and isolates secret native IDs", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = Array.from({ length: 129 }, (_, index) => ({
      name: `command-${index}`,
    }));
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events, "secret-open", "session-1", {
      FIRST_SECRET: "secret-native-a",
      SECOND_SECRET: "secret-native-b",
    });
    const turnId = turnIdFrom(await startPrompt(connection, events, "late-terminal", "work"));
    const session = sessionAt(runtime);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "late-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "late command" }] },
      },
    });
    const commandResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "late-command",
    );
    expect(commandResult).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    for (const [index, nativeId] of ["secret-native-a", "secret-native-b"].entries()) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer-${index}` },
        message: {
          role: "assistant",
          responseId: nativeId,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
    }
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "agent_end",
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant" as const, content: "ok" })),
        { role: "assistant", content: "failed", stopReason: "error", errorMessage: "private" },
      ],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    const assistantIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? [event.item.messageId]
        : [],
    );
    expect(new Set(assistantIds).size).toBe(2);
    expect(JSON.stringify(assistantIds)).not.toContain("secret-native");
    expect(terminal).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP assistant turn failed" } }),
    );
    await connection.close();
  });

  test("preserves configured environment and MCP values in native output", async () => {
    const nativeSessionId = "native-session-secret";
    const proxyUrl = "https://proxy%2Duser:proxy%2Dpass@example.test?access_token=proxy%2Dtoken";
    const sessionProxyUrl =
      "https://session%2Duser:p%40ss@example.test/session%2Dpath?code=token%2Dvalue#secret%2Dfragment";
    const root = mkdtempSync(join(tmpdir(), "paseo-omp-content-neutral-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    const mcpValue = "configured-mcp-value";
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ servers: { local: { env: { MCP_SECRET: mcpValue } } } }),
    );
    const children: ProviderRpcChild[] = [];
    const launchArgs: string[][] = [];
    const promptRequestIds: string[] = [];
    const runtime = new OmpRpcRuntime({
      spawnProcess(request) {
        launchArgs.push([...request.args]);
        let child: ProviderRpcChild;
        child = new ProviderRpcChild((command) => {
          const type = command.type;
          if (type === "set_host_tools") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { toolNames: [] },
            });
          } else if (type === "negotiate_protocol") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { protocolVersion: 2 },
            });
          } else if (type === "get_state") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: {
                model: MODEL,
                thinkingLevel: "medium",
                isStreaming: false,
                isCompacting: false,
                sessionId: nativeSessionId,
              },
            });
          } else if (type === "get_messages_page") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { messages: [], totalMessages: 0 },
            });
          } else if (type === "get_session_stats") {
            child.write({
              type: "response",
              id: command.id,
              success: false,
              error: "stats unavailable in transport fixture",
            });
          } else if (type === "get_available_models") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { models: [MODEL] },
            });
          } else if (type === "get_available_commands") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: {
                commands: [
                  ...Array.from({ length: 129 }, (_, index) => ({ name: `command-${index}` })),
                ],
              },
            });
          } else if (type === "prompt" || type === "steer") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { agentInvoked: true },
            });
            if (type === "prompt") {
              if (typeof command.id === "string") promptRequestIds.push(command.id);
              child.write({ type: "prompt_result", id: command.id, agentInvoked: true });
              child.write({
                type: "tool_execution_start",
                toolCallId: "buffered-large-tool",
                toolName: "read",
                args: Array.from({ length: 513 }, (_, index) => ({
                  a: `buffered-a-${index}`,
                  b: `buffered-b-${index}`,
                  c: `buffered-c-${index}`,
                })),
              });
            }
          } else if (type === "get_branch_messages") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { messages: [] },
            });
          }
        });
        children.push(child);
        queueMicrotask(() =>
          child.write({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
        );
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(true),
      environment: { ...TEST_RUNTIME_ENV, HOME: root, PI_CODING_AGENT_DIR: agentDir },
    });
    const connection = await createOmpProvider({
      runtime,
      environment: {
        ...TEST_RUNTIME_ENV,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        HTTPS_PROXY: proxyUrl,
      },
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.configure"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(connection, events, "transport-open", "session-1", {
      NATIVE_SECRET: nativeSessionId,
      ALL_PROXY: sessionProxyUrl,
    });
    children[0]?.write({
      type: "notice",
      level: "warning",
      message: `${mcpValue} ${proxyUrl} proxy-user proxy-pass proxy-token session%2Duser session-user p%40ss p@ss session%2Dpath session-path token%2Dvalue token-value secret%2Dfragment secret-fragment`,
    });
    const proxyNotice = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "notification",
    );
    expect(proxyNotice).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          message: `${mcpValue} ${proxyUrl} proxy-user proxy-pass proxy-token session%2Duser session-user p%40ss p@ss session%2Dpath session-path token%2Dvalue token-value secret%2Dfragment secret-fragment`,
        }),
      }),
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "transport-prompt", "work"));
    const bufferedLargeTool = await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read" &&
        event.item.status === "running",
    );
    expect(bufferedLargeTool).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ status: "running" }) }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "missing-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/command-128" }] },
      },
    });
    const rejected = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "missing-command",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "transport-late-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/late-command" }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "transport-late-command",
    );
    children[0]?.write({
      type: "tool_execution_start",
      toolCallId: "large-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, (_, index) => `input-${index}`),
    });
    children[0]?.write({
      type: "tool_execution_end",
      toolCallId: "large-tool",
      toolName: "read",
      result: Array.from({ length: 513 }, (_, index) => `output-${index}`),
    });
    const completedTool = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    if (
      completedTool?.type !== "timeline.item" ||
      completedTool.item.type !== "tool_call" ||
      completedTool.item.detail.type !== "unknown" ||
      !Array.isArray(completedTool.item.detail.output)
    ) {
      throw new Error("Expected completed bounded tool output");
    }
    expect(completedTool.item.detail.output).toHaveLength(128);
    children[0]?.write({
      type: "prompt_result",
      id: promptRequestIds[0],
      agentInvoked: true,
    });
    children[0]?.write({
      type: "agent_end",
      requestId: promptRequestIds[0],
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant" as const, content: "ok" })),
        { role: "assistant", content: "failed", stopReason: "error", errorMessage: "private" },
      ],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(
      expect.objectContaining({ error: { message: "OMP assistant turn failed" } }),
    );
    children[0]?.write({
      type: "rpc_chunk",
      chunkId: "oversized-runtime-frame",
      index: 0,
      count: 1,
      byteLength: 12 * 1024 * 1024 + 1,
      data: "e30=",
    });
    const recovered = await startPrompt(connection, events, "transport-recovery", "continue");
    expect(recovered).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
    );
    const recoveredTurnId = turnIdFrom(recovered);
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    const largeTerminalText = "é".repeat((1024 * 1024) / 2 + 1);
    children[1]?.writeChunked(
      {
        type: "agent_end",
        requestId: promptRequestIds.at(-1),
        messages: [{ role: "assistant", content: largeTerminalText }],
        isTerminal: true,
      },
      "oversized-terminal-text",
    );
    const largeTextTerminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === recoveredTurnId &&
        event.state !== "started",
    );
    expect(largeTextTerminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoveredTurnId &&
          event.state !== "started",
      ),
    ).toHaveLength(1);
    const nestedTurn = turnIdFrom(
      await startPrompt(connection, events, "nested-terminal", "continue"),
    );
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    children[1]?.write({
      type: "agent_end",
      requestId: promptRequestIds.at(-1),
      messages: Array.from({ length: 400 }, () => ({
        role: "assistant",
        content: Array.from({ length: 10 }, () => ({ type: "text", text: "x" })),
      })),
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === nestedTurn && event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === nestedTurn && event.state !== "started",
      ),
    ).toHaveLength(1);
    const oversizedEnvelopeTurn = turnIdFrom(
      await startPrompt(connection, events, "oversized-terminal-envelope", "continue"),
    );
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    children[1]?.write({
      type: "agent_end",
      metadata: Array.from({ length: 1_025 }, () => "x"),
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === oversizedEnvelopeTurn &&
        event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === oversizedEnvelopeTurn &&
          event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    for (const [index, messages] of ["bad", null].entries()) {
      const malformedTurn = turnIdFrom(
        await startPrompt(connection, events, `malformed-terminal-${index}`, "continue"),
      );
      children[1]?.write({
        type: "prompt_result",
        id: promptRequestIds.at(-1),
        agentInvoked: true,
      });
      children[1]?.write({ type: "agent_start" });
      children[1]?.write({
        type: "agent_end",
        requestId: promptRequestIds.at(-1),
        messages,
        isTerminal: true,
      });
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === malformedTurn &&
          event.state === "failed",
      );
      const terminalEvents = events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === malformedTurn &&
          event.state !== "started",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toEqual(expect.objectContaining({ state: "failed" }));
    }
    let recoverableTurn = turnIdFrom(
      await startPrompt(connection, events, "invalid-terminal-scalars-0", "continue"),
    );
    const invalidTerminalFrames = [
      { type: "agent_end", messages: [], isTerminal: 5 },
      { type: "agent_end", messages: [], messageCount: -1, isTerminal: true },
      { type: "agent_end", messages: [], messageCount: "1", isTerminal: true },
    ];
    for (const [index, frame] of invalidTerminalFrames.entries()) {
      children.at(-1)?.write(frame);
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoverableTurn &&
          event.state === "failed",
      );
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === recoverableTurn &&
            event.state !== "started",
        ),
      ).toEqual([expect.objectContaining({ state: "failed" })]);

      const recovered = await startPrompt(
        connection,
        events,
        `after-invalid-terminal-scalars-${index}`,
        "continue",
      );
      recoverableTurn = turnIdFrom(recovered);
      expect(recovered).toEqual(
        expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
      );
      expect(launchArgs[index + 2]).toContain("--resume");
      expect(launchArgs[index + 2]).toContain(nativeSessionId);
    }

    children.at(-1)?.write({
      type: "agent_end",
      messages: "invalid-nonterminal-payload",
      isTerminal: false,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === recoverableTurn &&
        event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoverableTurn &&
          event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);

    const finalTurn = turnIdFrom(
      await startPrompt(connection, events, "after-invalid-nonterminal", "continue"),
    );
    expect(launchArgs[5]).toContain("--resume");
    expect(launchArgs[5]).toContain(nativeSessionId);
    children.at(-1)?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children.at(-1)?.write({ type: "agent_start" });
    children.at(-1)?.write({
      type: "agent_end",
      requestId: promptRequestIds.at(-1),
      messages: [],
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === finalTurn && event.state === "completed",
    );
    const publicEventsWithoutPersistence = events.map((event) => {
      if (event.type !== "session.opened") return event;
      const { persistence: _persistence, ...publicEvent } = event;
      return publicEvent;
    });
    expect(JSON.stringify(publicEventsWithoutPersistence)).not.toContain(nativeSessionId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        persistence: { version: 1, data: { sessionId: nativeSessionId } },
      }),
    );
    expect(children).toHaveLength(6);
    await connection.close();
  });

  test("fails closed after one-turn native identity saturation and recovers next turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "saturated-turn", "work"));
    for (let index = 0; index < 1_025; index += 1) {
      session.emit({
        type: "message_update",
        message: {
          role: "assistant",
          responseId: `native-${index}`,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: `native-${index}`,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
    }
    expect(
      events.filter(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toHaveLength(1_024);
    await finishTurn(events, session, firstTurn);

    const nextTurn = turnIdFrom(
      await startPrompt(connection, events, "after-saturation", "continue"),
    );
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "native-after-saturation",
        content: [{ type: "text", text: "recovered" }],
      },
    });
    await scheduler.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "recovered" }),
      }),
    );
    await finishTurn(events, session, nextTurn);
    await connection.close();
  });
});
