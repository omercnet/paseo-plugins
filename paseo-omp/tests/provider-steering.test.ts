import { AgentPermissionRequestPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { createOmpProvider } from "../server/provider/registration";
import {
  createHarness,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishTurn,
  type HostLaunchContext,
  type HostRegistryConstructor,
  type HostSession,
  type HostSessionConfig,
  type HostTerminalEvent,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  pino,
  pluginProviderModulePath,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("routes auto delivery through native steering while a turn is active", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "auto-steer",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "change direction" }] },
      },
    });
    const result = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "auto-steer",
    );

    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "auto-steer",
      result: { type: "steer", turnId },
    });
    expect(session.steers).toEqual(["change direction"]);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("waits for prompt acknowledgement before auto-steering the same turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const promptObserved = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = promptObserved.resolve;

    const firstPrompt = startPrompt(connection, events, "pending-prompt", "start");
    await promptObserved.promise;
    const autoSteer = connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "pending-auto-steer",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "change direction" }] },
      },
    });

    expect(session.steers).toEqual([]);
    promptGate.resolve();
    const turnId = turnIdFrom(await firstPrompt);
    await autoSteer;
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "pending-auto-steer",
    );

    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "pending-auto-steer",
      result: { type: "steer", turnId },
    });
    expect(session.steers).toEqual(["change direction"]);
    expect(session.promptCount).toBe(1);
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("rejects a keyed stale terminal before a later prompt is issued", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessagesError = new Error("branch unavailable");
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "startup-first", "first"));
    session.emit({ type: "message_end", message: { role: "user", content: "first" } });
    await finishTurn(events, session, firstTurn);

    session.branchMessagesError = null;
    session.promptAgentInvoked = undefined;
    session.branchMessages = [{ entryId: "startup-second", text: "second" }];
    const branchGate = Promise.withResolvers<void>();
    const branchObserved = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessagesObserved = branchObserved.resolve;

    const pendingPrompt = startPrompt(connection, events, "startup-second", "second");
    await branchObserved.promise;
    expect(session.promptCount).toBe(1);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: Array.from({ length: 5 }, () => ({
        role: "assistant" as const,
        content: "x".repeat(900_000),
      })),
      isTerminal: true,
    });
    expect(session.closes).toBe(0);

    branchGate.resolve();
    const turnId = turnIdFrom(await pendingPrompt);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: true,
    });
    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("settles queued auto steering before connection shutdown joins active operations", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const promptObserved = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = promptObserved.resolve;

    const firstPrompt = startPrompt(connection, events, "closing-prompt", "start");
    await promptObserved.promise;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "closing-auto-steer",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "change direction" }] },
      },
    });
    await Promise.resolve();

    const closing = connection.close();
    await Promise.resolve();
    await Promise.resolve();
    const promptResults = events.filter(
      (event) =>
        event.type === "session.prompt_result" &&
        ["closing-prompt", "closing-auto-steer"].includes(event.clientMessageId),
    );
    promptGate.resolve();

    expect(promptResults).toEqual([
      expect.objectContaining({
        clientMessageId: "closing-prompt",
        result: {
          type: "failed",
          error: { message: "OMP session closed before the prompt was accepted" },
        },
      }),
      expect.objectContaining({
        clientMessageId: "closing-auto-steer",
        result: {
          type: "failed",
          error: { message: "There is no active OMP turn to steer" },
        },
      }),
    ]);
    await firstPrompt;
    await closing;
    expect(session.steers).toEqual([]);
    expect(session.closes).toBe(1);
  });

  test("does not convert auto-delivered structured commands into steering text", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "auto-command",
        delivery: "auto",
        input: { type: "command", name: "removed-command", arguments: "now" },
      },
    });
    const result = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "auto-command",
    );

    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "auto-command",
      result: {
        type: "failed",
        error: { message: "OMP already has an active turn; send this message as a steer" },
      },
    });
    expect(session.steers).toEqual([]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps one user bubble through hidden notices and mid-turn steering", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const promptResult = await startPrompt(connection, events);
    const turnId = turnIdFrom(promptResult);
    const session = sessionAt(runtime);
    session.branchMessages = [{ entryId: "entry-user-1", text: "hello" }];
    const hiddenNotice = {
      type: "message_end" as const,
      message: {
        role: "custom" as const,
        content: "Mounted development tools",
        customType: "xdev-mount-notice",
        display: false,
      },
    };
    session.emit(hiddenNotice);
    session.emit({
      type: "notice",
      id: "notice-before-echo",
      level: "info",
      message: "Background setup finished",
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "normalized echo", id: "generic-message-id" },
    });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "client-1",
    );
    session.emit({
      type: "tool_execution_start",
      toolCallId: "active-tool",
      toolName: "read",
      args: { path: "active.ts" },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-1",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    const steerResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-1",
    );
    session.emit({
      type: "tool_execution_update",
      toolCallId: "active-tool",
      toolName: "read",
      partialResult: { output: "still active." },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "active-tool",
      toolName: "read",
      result: { output: "done" },
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "duplicate", entryId: "entry-user-1" },
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "focus", entryId: "entry-steer-1" },
    });
    const terminal = await finishTurn(events, session, turnId);
    const correlatedUsers = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(correlatedUsers).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "client-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "steer-1",
      }),
    ]);
    expect(correlatedUsers.some((item) => item.id === "generic-message-id")).toBe(false);

    expect(steerResult).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    expect(
      events.filter(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-1",
      ),
    ).toHaveLength(1);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toHaveLength(1);
    const activeToolSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.id === "omp:tool:1"
        ? [event.item]
        : [],
    );
    expect(activeToolSnapshots).toEqual([
      expect.objectContaining({
        status: "running",
        detail: { type: "read", filePath: "active.ts" },
      }),
      expect.objectContaining({
        status: "running",
        detail: { type: "read", filePath: "active.ts", content: "still active." },
      }),
      expect.objectContaining({
        status: "completed",
        detail: { type: "read", filePath: "active.ts", content: "done" },
      }),
    ]);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    for (const clientMessageId of ["client-1", "steer-1"]) {
      expect(
        events.filter(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "user_message" &&
            event.item.clientMessageId === clientMessageId,
        ),
      ).toHaveLength(1);
    }

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "too late" }] },
      },
    });
    const rejected = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-2",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    expect(session.steers).toEqual(["focus"]);
    await connection.close();
  });

  test("delivers child-finish-style steering without aborting or replacing the turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const childNotice = "Child agent finished: review complete";
    const baseline = events.length;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "child-finish-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: childNotice }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "child-finish-steer",
    );

    expect(events.slice(baseline)).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "child-finish-steer",
        result: { type: "steer", turnId },
      },
    ]);
    expect(session.steers).toEqual([childNotice]);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toEqual([{ type: "session.turn", sessionId: "session-1", turnId, state: "started" }]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps accepted steer work after an earlier agent_end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", entryId: "entry-before-steer" },
    });
    const baseline = events.length;
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "accepted-after-end",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    await steerObserved.promise;
    session.emit({
      type: "message_end",
      message: { role: "user", content: "continue", entryId: "entry-accepted-steer" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(events.slice(baseline)).toEqual([]);

    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "accepted-after-end",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "accepted-after-end",
      result: { type: "steer", turnId },
    });
    session.emit({ type: "agent_start" });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "post-steer-tool",
      toolName: "read",
      args: { path: "after.ts" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "post-steer-tool",
      toolName: "read",
      partialResult: { output: "partial" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "post-steer-tool",
      toolName: "read",
      result: { output: "done" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "continued" },
      message: {
        role: "assistant",
        responseId: "response-after-steer",
        content: [{ type: "text", text: "continued" }],
      },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(events.slice(baseline).filter((event) => event.type === "timeline.item")).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: expect.stringMatching(/^omp:user:\d+:/u),
          messageId: expect.stringMatching(/^omp:user:\d+:/u),
          clientMessageId: "accepted-after-end",
          text: "continue",
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts" },
          status: "running",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts", content: "partial" },
          status: "running",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts", content: "done" },
          status: "completed",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "assistant_message",
          id: "omp:assistant:1:fu4akAEZQMwl:content:0:text",
          messageId: "omp:assistant:1:fu4akAEZQMwl",
          text: "continued",
        },
      },
    ]);
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    await connection.close();
  });

  test("ignores the local-only timer while native steering is pending", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "local-race", "work"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "entry-local-race" },
    });
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;
    const baseline = events.length;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "early-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    await steerObserved.promise;
    await scheduler.flush();
    expect(events.slice(baseline)).toEqual([]);

    session.emit({
      type: "message_end",
      message: { role: "user", content: "focus", entryId: "entry-early-steer" },
    });
    expect(events.slice(baseline)).toEqual([]);
    steerGate.resolve();
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "early-steer",
    );

    expect(events.slice(baseline)).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: expect.stringMatching(/^omp:user:\d+:/u),
          messageId: expect.stringMatching(/^omp:user:\d+:/u),
          clientMessageId: "early-steer",
          text: "focus",
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "early-steer",
        result: { type: "steer", turnId },
      },
    ]);
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false });
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    session.emit({ type: "agent_start" });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("cancels local-only completion when the current-turn user echo arrives", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    session.branchMessages = [{ entryId: "entry-local-evidence", text: "work" }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "local-evidence", "work"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "entry-local-evidence" },
    });
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("discards an early steer echo when native steering rejects", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", entryId: "entry-before-reject" },
    });
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;
    session.steerError = new Error("rejected");
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "rejected-early",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "do not show" }] },
      },
    });
    await steerObserved.promise;
    session.emit({
      type: "message_end",
      message: { role: "user", content: "do not show", entryId: "entry-rejected" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "rejected-early",
    );

    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "rejected-early",
      result: { type: "failed", error: { message: "OMP steer failed" } },
    });
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "rejected-early",
      ),
    ).toBe(false);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    await connection.close();
  });

  test("rejects steering while a terminal agent event waits for user correlation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-delayed", text: "hello" }];
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "terminalizing-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "too late" }] },
      },
    });
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "terminalizing-steer",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "terminalizing-steer",
      result: {
        type: "failed",
        error: { message: "There is no active OMP turn to steer" },
      },
    });
    expect(session.steers).toEqual([]);

    branchGate.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    await connection.close();
  });

  test("preserves both queued branch IDs when terminal arrives before lookup", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "repeat-1", "repeat"));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [
      { entryId: "entry-repeat-1", text: "repeat" },
      { entryId: "entry-repeat-2", text: "repeat" },
    ];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "repeat-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "repeat-2",
    );
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);

    branchGate.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "repeat-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "repeat-2",
        text: "repeat",
      },
    ]);
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    expect(session.branchMessageLookups).toBe(1);
    await connection.close();
  });

  test("drains duplicate entry-less echoes before terminal fallback", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "queued-1", "repeat"));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-queued-1", text: "repeat" }];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "queued-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "queued-2",
    );
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-queued-2" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    branchGate.resolve();
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "queued-2",
    );
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    const users = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(users).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "queued-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "queued-2",
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("does not let a surplus branch entry cross turn ownership", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessages = [
      { entryId: "entry-owned-1", text: "repeat" },
      { entryId: "entry-surplus", text: "repeat" },
    ];
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "owner-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "owner-1",
      ),
    ).toEqual([]);
    await finishTurn(events, session, firstTurnId);

    session.branchMessages = [
      { entryId: "entry-owned-1", text: "repeat" },
      { entryId: "entry-surplus", text: "repeat" },
    ];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "owner-2", "repeat"));
    session.branchMessages.push({ entryId: "entry-owned-2", text: "repeat" });
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "owner-2",
    );
    await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "owner-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "owner-2",
        text: "repeat",
      },
    ]);
    await connection.close();
  });

  test("fails closed until a fresh catalog permits nonexistent path prose", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.commandDiscoveryError = new Error("commands unavailable");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const pathProse = "/definitely/not/a/real/path is missing";

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "slash-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/help" }] },
      },
    });
    const unavailableCommand = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "slash-steer",
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unavailable-path",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: pathProse }] },
      },
    });
    const unavailablePath = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "unavailable-path",
    );
    expect([unavailableCommand, unavailablePath]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "slash-steer",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "unavailable-path",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
    ]);
    expect(session.steers).toEqual([]);

    session.availableCommandsError = null;
    session.availableCommands = [{ name: "fresh-command", aliases: ["fresh"] }];
    session.emit({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "path-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: pathProse }] },
      },
    });
    const pathResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "path-steer",
    );
    expect(pathResult).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "path-steer",
      result: { type: "steer", turnId },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "refreshed-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/fresh:now" }] },
      },
    });
    const refreshedResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "refreshed-command",
    );
    expect(refreshedResult).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "refreshed-command",
      result: { type: "steer", turnId },
    });
    expect(session.availableCommandLookups).toBe(5);
    expect(session.steers).toEqual([pathProse, "/fresh:now"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("refreshes stale catalogs before allowing unknown slash prose", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [{ name: "old-command" }];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.availableCommands = [{ name: "new-command" }];

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "stale-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/new-command now" }] },
      },
    });
    const refreshed = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "stale-command",
    );

    session.availableCommands = [];
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unknown-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/unknown now" }] },
      },
    });
    const unknown = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "unknown-command",
    );

    expect([refreshed, unknown]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "stale-command",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "unknown-command",
        result: { type: "steer", turnId },
      },
    ]);
    expect(session.availableCommandLookups).toBe(3);
    expect(session.steers).toEqual(["/unknown now"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("does not retarget a steer after deferred command discovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "turn-a", "first"));
    const discoveryGate = Promise.withResolvers<void>();
    const discoveryObserved = Promise.withResolvers<void>();
    session.availableCommands = [];
    session.availableCommandsGate = discoveryGate.promise;
    session.availableCommandsObserved = discoveryObserved.resolve;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "delayed-path-steer",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "/not-a-command continue" }],
        },
      },
    });
    await discoveryObserved.promise;
    await finishTurn(events, session, firstTurnId);
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "turn-b", "second"));

    discoveryGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "delayed-path-steer",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "delayed-path-steer",
      result: {
        type: "failed",
        error: { message: "There is no active OMP turn to steer" },
      },
    });
    expect(session.steers).toEqual([]);
    await finishTurn(events, session, secondTurnId);
    await connection.close();
  });

  test("replaces the discovered slash catalog authoritatively", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [{ name: "retired-command" }];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.availableCommands = [{ name: "fresh-command" }];
    session.emit({
      type: "available_commands_update",
      commands: [{ name: "fresh-command" }],
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "former-command-prose",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "/retired-command continue" }],
        },
      },
    });
    const former = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "former-command-prose",
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "replacement-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/fresh-command now" }] },
      },
    });
    const replacement = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "replacement-command",
    );

    expect([former, replacement]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "former-command-prose",
        result: { type: "steer", turnId },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "replacement-command",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
    ]);
    expect(session.availableCommandLookups).toBe(2);
    expect(session.steers).toEqual(["/retired-command continue"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("quarantines branch entries after lookup failure before the same text", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessagesError = new Error("lookup unavailable");
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    const firstTerminal = await finishTurn(events, session, firstTurnId);

    session.branchMessagesError = null;
    session.branchMessages = [
      { entryId: "entry-old", text: "repeat" },
      { entryId: "entry-new", text: "repeat" },
    ];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    const secondTerminal = await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: "omp:user:1:local",
        messageId: "omp:user:1:local",
        clientMessageId: "lookup-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: "omp:user:2:local",
        messageId: "omp:user:2:local",
        clientMessageId: "lookup-2",
        text: "repeat",
      },
    ]);
    expect([firstTerminal, secondTerminal]).toEqual([
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId: firstTurnId,
        state: "completed",
      },
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId: secondTurnId,
        state: "completed",
      },
    ]);
    await connection.close();
  });

  test("quarantines late branch entries after fallback publication", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "fallback-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, firstTurnId);

    session.branchMessages = [{ entryId: "entry-late", text: "repeat" }];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "fallback-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: "omp:user:1:local",
        messageId: "omp:user:1:local",
        clientMessageId: "fallback-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: "omp:user:2:local",
        messageId: "omp:user:2:local",
        clientMessageId: "fallback-2",
        text: "repeat",
      },
    ]);
    await connection.close();
  });

  test("emits nothing from a delayed entry lookup after session-only close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-after-close", text: "hello" }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "closing-lookup", "hello"));
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    const closeBaseline = events.length;
    await connection.send({
      type: "session.close",
      requestId: "close-delayed-lookup",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-delayed-lookup",
    );
    expect(events.slice(closeBaseline)).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: "omp:user:1:local",
          messageId: "omp:user:1:local",
          clientMessageId: "closing-lookup",
          text: "hello",
        },
      },
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId,
        state: "canceled",
      },
      { type: "session.closed", sessionId: "session-1" },
      { type: "request.completed", requestId: "close-delayed-lookup" },
    ]);

    const closedBaseline = events.length;
    branchGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.slice(closedBaseline)).toEqual([]);
    await connection.close();
  });

  test("keeps prompt_result false local-only despite an unkeyed agent_end", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;
    session.promptEvents = [
      { type: "command_output", text: "first" },
      { type: "command_output", text: " second" },
      { type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false },
    ];

    const result = await startPrompt(connection, events, "local-1", "/help");
    const turnId = turnIdFrom(result);
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "stale prior turn" }],
      isTerminal: true,
    });
    expect(scheduler.delays).toContain(5_000);
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ id: `omp:command:${turnId}`, text: "first second" }),
      }),
    );
    await connection.close();
  });

  test("ignores a mismatched terminal during local-only settlement", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "local-stale-a", "work"));
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: false }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "local-stale-b", "/help"));
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [{ role: "assistant", content: "stale" }],
      isTerminal: true,
    });

    await scheduler.flush(5_000);
    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("keeps a missing prompt acknowledgement unknown and preserves buffered true result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true }];
    const result = await startPrompt(connection, events, "dataless-1", "local command");
    const turnId = turnIdFrom(result);

    expect(scheduler.delays).not.toContain(5_000);
    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await finishTurn(events, session, turnId);

    await connection.close();
  });
  test("keeps buffered positive acknowledgement authoritative over a false prompt result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = true;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "buffered-positive", "work"));

    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("cancels local-only completion when a turn-scoped permission appears", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-evidence", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "permission-evidence",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    expect(permission.request.input).toEqual({
      questions: [
        {
          header: "Continue",
          question: "Proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...permission.request, provider: "omp" }),
    ).not.toThrow();

    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { answers: { Continue: "Yes" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === permission.request.id,
    );
    session.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "permission-evidence", content: "Continuing" },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("reconciles complete buffered turns before true false and missing acknowledgements", async () => {
    for (const acknowledgement of [true, false, undefined]) {
      const { connection, events, runtime } = await createHarness();
      await openSession(connection, events);
      const session = sessionAt(runtime);
      session.promptAgentInvoked = acknowledgement;
      session.promptEvents = [
        {
          type: "message_end",
          message: {
            role: "user",
            content: "work",
            entryId: `buffered-user-${String(acknowledgement)}`,
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            responseId: `buffered-${String(acknowledgement)}`,
            content: "Buffered response",
          },
        },
        {
          type: "agent_end",
          messages: [{ role: "assistant", content: "Buffered response" }],
          isTerminal: true,
        },
      ];
      const result = await startPrompt(
        connection,
        events,
        `buffered-${String(acknowledgement)}`,
        "work",
      );
      const turnId = turnIdFrom(result);
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
        ),
      ).toHaveLength(1);
      await connection.close();
    }
  });

  test("cleans pending and in-flight permissions when prompt acknowledgement rejects", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const promptObserved = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = promptObserved.resolve;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "reject-with-permission",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "work" }] },
      },
    });
    await promptObserved.promise;
    session.emit({
      type: "extension_ui_request",
      id: "prompt-reject-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    const responseGate = Promise.withResolvers<void>();
    const responseObserved = Promise.withResolvers<void>();
    session.extensionUiResponseGate = responseGate.promise;
    session.extensionUiResponseObserved = responseObserved.resolve;
    const permissionResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await responseObserved.promise;
    promptGate.reject(new Error("prompt rejected"));
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "reject-with-permission" &&
        event.result.type === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    responseGate.resolve();
    await permissionResponse;
    await Promise.resolve();
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    await connection.close();
  });

  test("fails an acknowledged turn with the late native scheduling error", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(
      connection,
      events,
      "late-error-open",
      "session-1",
      { PROMPT_ERROR_SECRET: "scheduling-secret" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const session = sessionAt(runtime);
    session.promptEvents = [
      {
        type: "prompt_error",
        id: "rpc-prompt-1",
        error: "Session is already processing scheduling-secret",
        code: "session_busy:scheduling-secret",
      },
    ];
    const result = await startPrompt(connection, events, "late-error", "work");
    const turnId = turnIdFrom(result);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        error: {
          message: "Session is already processing <redacted>",
          code: "session_busy:<redacted>",
        },
      }),
    );
    await connection.close();
  });
  test("quarantines timed-out prompt ownership before accepting another turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const stale = sessionAt(runtime);
    stale.promptError = new Error("OMP RPC request timed out");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "timed-out-prompt",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "first" }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "timed-out-prompt" &&
        event.result.type === "failed",
    );
    expect(stale.closes).toBe(1);

    const nextTurn = turnIdFrom(await startPrompt(connection, events, "after-timeout", "second"));
    const staleBaseline = events.length;
    stale.emit({
      type: "extension_ui_request",
      id: "stale-question",
      method: "confirm",
      title: "Stale",
      message: "Wrong turn",
    });
    stale.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "stale", content: "late first response" },
    });
    stale.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "late first response" }],
      isTerminal: true,
    });
    await Promise.resolve();
    expect(events.slice(staleBaseline)).toEqual([]);

    const current = sessionAt(runtime, 1);
    current.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "current", content: "second response" },
    });
    await finishTurn(events, current, nextTurn);
    await connection.close();
  });
  test("cancels local-only completion when native activity starts", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;

    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false }];
    const result = await startPrompt(connection, events, "activity-1", "work");
    const turnId = turnIdFrom(result);

    session.emit({ type: "agent_start" });
    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    const terminal = await finishTurn(events, session, turnId);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("fails an active turn without terminalizing the host session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "failed-1", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);

    session.emit({ type: "process_exit", error: "OMP exited with code 7" });
    expect(events.filter((event) => event.type === "session.runtime_failed")).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });
  test("real Paseo provider host keeps a recovered session reachable", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({
      runtime,
      timelineScheduler: new ManualScheduler(),
      environment: TEST_RUNTIME_ENV,
    });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    const config: HostSessionConfig = {
      provider: registration.id,
      cwd: "/repo",
      model: MODEL_PUBLIC_ID,
      mcpServers: {},
      modeId: "full",
      thinkingOptionId: "medium",
      featureValues: {},
    };
    const launchContext: HostLaunchContext = { env: { TEST_ENV: "test-value" } };
    let session: HostSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await client.createSession(config, launchContext, { persistSession: true });
      expect(runtime.starts[0]?.noSession).toBe(false);
      const sessionId = session.id;
      const terminals: HostTerminalEvent[] = [];
      const firstTerminal = Promise.withResolvers<HostTerminalEvent>();
      const secondTerminal = Promise.withResolvers<HostTerminalEvent>();
      let firstTurnId: string | undefined;
      let secondTurnId: string | undefined;
      unsubscribe = session.subscribe((event) => {
        if (
          event.type !== "turn_failed" &&
          event.type !== "turn_completed" &&
          event.type !== "turn_canceled"
        ) {
          return;
        }
        const terminal = event as HostTerminalEvent;
        terminals.push(terminal);
        if (terminal.turnId === firstTurnId) firstTerminal.resolve(terminal);
        if (terminal.turnId === secondTurnId) secondTerminal.resolve(terminal);
      });

      const first = await session.startTurn("work", { clientMessageId: "host-first" });
      firstTurnId = first.turnId;
      sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited" });
      await expect(firstTerminal.promise).resolves.toEqual(
        expect.objectContaining({ type: "turn_failed", turnId: first.turnId }),
      );

      const second = await session.startTurn("continue", { clientMessageId: "host-recovered" });
      secondTurnId = second.turnId;
      expect(session.id).toBe(sessionId);
      expect(runtime.starts[1]).toEqual(
        expect.objectContaining({ noSession: false, resumeSessionId: NATIVE_SESSION_ID }),
      );
      establishTerminalOwnership(sessionAt(runtime, 1));
      sessionAt(runtime, 1).emit({ type: "agent_end", messages: [], isTerminal: true });
      await expect(secondTerminal.promise).resolves.toEqual(
        expect.objectContaining({ type: "turn_completed", turnId: second.turnId }),
      );
      for (const turnId of [first.turnId, second.turnId]) {
        expect(terminals.filter((event) => event.turnId === turnId)).toHaveLength(1);
      }
      expect(terminals.some((event) => event.turnId === undefined)).toBe(false);
    } finally {
      unsubscribe?.();
      await session?.close();

      await registry.shutdown();
    }
  });
});
