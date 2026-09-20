import { describe, expect, test } from "vitest";
import {
  createHarness,
  FakeOmpRuntime,
  ManualScheduler,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("replays aborted task results as canceled despite error metadata", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "aborted-task", name: "task", arguments: { task: "stop" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "aborted-task",
        toolName: "task",
        content: [],
        details: {
          results: [
            { id: "aborted-child", aborted: true, exitCode: 1, error: "request was aborted" },
          ],
        },
      },
    ];
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0aborted-child", {
      sessionFile: "/sessions/root/aborted-child.jsonl",
      nativeSessionId: "01a0915d-e337-7009-af23-7382348f59b7",
      byteLength: 1,
      messages: [],
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "aborted-replay",
      sessionId: "aborted-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "aborted-replay",
    );
    const child = events.find(
      (event) => event.type === "session.opened" && event.parentSessionId === "aborted-root",
    );
    if (child?.type !== "session.opened") throw new Error("Missing aborted child");
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === child.sessionId &&
          event.state === "canceled",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === child.sessionId &&
          event.state === "failed",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("publishes failed and canceled child terminal states exactly once", async () => {
    for (const terminal of ["failed", "aborted"] as const) {
      const { connection, events, runtime } = await createHarness(
        new FakeOmpRuntime(),
        new ManualScheduler(),
        ["prompt.message", "session.subsession"],
      );
      await openSession(connection, events);
      const session = sessionAt(runtime);
      const turnId = turnIdFrom(await startPrompt(connection, events));
      session.emit({
        type: "tool_execution_start",
        toolCallId: `task-${terminal}`,
        toolName: "task",
        args: { tasks: [{ task: terminal }] },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: `task-${terminal}`,
        toolName: "task",
        result: { message: "spawned" },
      });
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: `native-${terminal}`,
          agent: terminal,
          status: "started",
          parentToolCallId: `task-${terminal}`,
          index: 0,
        },
      });
      session.emit({ type: "agent_end", messages: [], isTerminal: true });
      if (terminal === "aborted") {
        await connection.send({
          type: "session.interrupt",
          requestId: "cancel-parent",
          sessionId: "session-1",
        });
      }
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: `native-${terminal}`,
          agent: terminal,
          status: terminal,
          parentToolCallId: `task-${terminal}`,
          index: 0,
        },
      });
      const expected = terminal === "failed" ? "failed" : "canceled";
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      const childOpened = events.find(
        (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
      );
      if (childOpened?.type !== "session.opened") throw new Error("Missing terminal child");
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.sessionId === childOpened.sessionId &&
            event.state === expected,
        ),
      ).toHaveLength(1);
      await connection.close();
    }
  });

  test("omits subsession capabilities when OMP cannot subscribe", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextSubagentSubscriptionError = new Error("unsupported command");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "prompt.steer",
      "session.subsession",
    ]);
    await openSession(connection, events);
    expect(
      events.find((event) => event.type === "session.opened" && event.sessionId === "session-1"),
    ).toEqual(expect.objectContaining({ capabilities: ["prompt.message", "prompt.steer"] }));
    expect(connection.capabilities).toContain("session.subsession");
    await connection.close();
  });

  test("reports an explicit session close failure without completing it", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("close failed");

    await connection.send({
      type: "session.close",
      requestId: "close-1",
      sessionId: "session-1",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "close-1",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP session close failed" } }),
    );
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "close-1"),
    ).toBe(false);
    await connection.close().catch(() => undefined);
  });

  test("reserves recovered command admission without orphaning queued auto steering", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const recoveryGate = Promise.withResolvers<void>();
    const recoveryObserved = Promise.withResolvers<void>();
    const handoffGate = Promise.withResolvers<void>();
    const handoffObserved = Promise.withResolvers<void>();
    runtime.startGate = recoveryGate.promise;
    runtime.startObserved = recoveryObserved.resolve;
    runtime.sessionCreated = (session) => {
      session.handoffGate = handoffGate.promise;
      session.handoffObserved = handoffObserved.resolve;
    };
    sessionAt(runtime).emit({ type: "process_exit", error: "restart before commands" });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "recovering-handoff",
        delivery: "auto",
        input: { type: "command", name: "handoff", arguments: "first" },
      },
    });
    await recoveryObserved.promise;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "recovering-auto-steer",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "change direction" }] },
      },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "recovering-follow-up",
        delivery: "auto",
        input: { type: "command", name: "follow-up", arguments: "second" },
      },
    });

    runtime.startGate = null;
    recoveryGate.resolve();
    await handoffObserved.promise;
    const rejected = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "recovering-follow-up",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        result: {
          type: "failed",
          error: { message: "OMP already has an active turn; send this message as a steer" },
        },
      }),
    );

    handoffGate.resolve();
    const commandTurnId = turnIdFrom(
      await events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "recovering-handoff",
      ),
    );
    const steerResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "recovering-auto-steer",
    );
    expect(steerResult).toEqual(
      expect.objectContaining({ result: { type: "steer", turnId: commandTurnId } }),
    );
    const recovered = sessionAt(runtime, 1);
    expect(recovered.handoffs).toEqual(["first"]);
    expect(recovered.followUps).toEqual([]);
    expect(recovered.steers).toEqual(["change direction"]);
    const assistant = {
      role: "assistant" as const,
      responseId: "recovered-command-response",
      content: "done",
    };
    recovered.emit({ type: "message_end", message: assistant });
    recovered.emit({ type: "agent_end", messages: [assistant], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === commandTurnId &&
        event.state === "completed",
    );
    await connection.close();
  });
});
