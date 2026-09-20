import { describe, expect, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  createHarness,
  EventLog,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  ProviderRpcChild,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("publishes one task child once and keeps its parent active", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(
      connection,
      events,
      "child-redaction-open",
      "session-1",
      { CHILD_SECRET: "child-secret" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-single",
      toolName: "task",
      args: { tasks: [{ task: "inspect" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-single",
      toolName: "task",
      result: { details: { results: [{ id: "native-child-single", agent: "Bearer scout" }] } },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-child-single",
        agent: "child-secret scout",
        description: "Inspect child-secret",
        status: "started",
        sessionFile: "/sessions/root/native-child-single.jsonl",
        parentToolCallId: "task-single",
        index: 0,
      },
    });
    const opened = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (opened?.type !== "session.opened") throw new Error("Missing child session");
    expect(opened).toEqual(
      expect.objectContaining({
        capabilities: ["session.subsession"],
        toolCallId: "task-single",
        restoration: "parent",
        title: "<redacted> scout",
        description: "Inspect <redacted>",
      }),
    );
    session.emit({
      type: "subagent_event",
      payload: {
        id: "native-child-single",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            responseId: "child-answer",
            content: "child-secret output",
          },
        },
      },
    });
    session.emit({
      type: "subagent_event",
      payload: {
        id: "native-child-single",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            responseId: "child-answer",
            content: "child-secret output",
          },
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === opened.sessionId &&
          event.item.type === "assistant_message" &&
          event.item.text === "<redacted> output",
      ),
    ).toHaveLength(1);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === "session-1" &&
          event.state !== "started",
      ),
    ).toBe(false);
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-child-single",
        agent: "Bearer scout",
        status: "completed",
        sessionFile: "/sessions/root/native-child-single.jsonl",
        parentToolCallId: "task-single",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.opened" && event.sessionId === opened.sessionId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === opened.sessionId &&
          event.state === "completed",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test.each([undefined, "rpc-prompt-1"] as const)(
    "rechecks children after %s terminal state lookup",
    async (requestId) => {
      const { connection, events, runtime } = await createHarness(
        new FakeOmpRuntime(),
        new ManualScheduler(),
        ["prompt.message", "session.subsession"],
      );
      await openSession(connection, events);
      const session = sessionAt(runtime);
      const turnId = turnIdFrom(await startPrompt(connection, events, "child-state-race", "work"));
      const state = Promise.withResolvers<void>();
      const observed = Promise.withResolvers<void>();
      session.stateGate = state.promise;
      session.stateObserved = observed.resolve;
      session.emit({ type: "agent_end", requestId, messages: [], isTerminal: true });
      await observed.promise;

      const child = {
        id: "state-race-child",
        agent: "scout",
        status: "running" as const,
        sessionFile: "/sessions/root/state-race-child.jsonl",
        parentToolCallId: "state-race-task",
        lastUpdate: 1,
        index: 0,
      };
      session.subagents = [child];
      session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "started" } });
      state.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
        ),
      ).toEqual([]);

      session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "completed" } });
      await expect(
        events.waitFor(
          (event) =>
            event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
        ),
      ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
      await connection.close();
    },
  );

  test("terminalizes children and resumes the parent when reconciliation is unavailable", async () => {
    const failures: OmpOperationalFailure[] = [];
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
      undefined,
      (failure) => failures.push(failure),
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "unavailable-child-reconciliation", "work"),
    );
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "unavailable-live-child", agent: "scout", status: "started", index: 0 },
    });
    const child = events.findLast(
      (event) => event.type === "session.opened" && event.title === "scout",
    );
    if (child?.type !== "session.opened") throw new Error("Missing live child session");
    session.subagentsError = new Error("snapshot unavailable");
    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: `rpc-prompt-${session.promptCount}`,
      messages: [],
      isTerminal: true,
    });

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: child.sessionId,
        state: "failed",
      }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    expect(failures).toEqual([{ category: "tool-projector", stage: "subsession-projector" }]);
    await connection.close();
  });

  test("reconciles a missing child from repeated unkeyed terminal snapshots", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "snapshot-child-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "snapshot-child-second", "second"),
    );
    session.branchMessages.push({ entryId: "snapshot-child-user", text: "second" });
    session.emit({ type: "message_end", message: { role: "user", content: "second" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "snapshot-child-second",
    );
    const assistant = {
      role: "assistant" as const,
      entryId: "snapshot-child-assistant",
      content: "done",
    };
    session.emit({ type: "message_end", message: assistant });
    const child = {
      id: "snapshot-child",
      agent: "scout",
      status: "running" as const,
      sessionFile: "/sessions/root/snapshot-child.jsonl",
      parentToolCallId: "snapshot-task",
      lastUpdate: 1,
      index: 0,
    };
    session.subagents = [child];
    session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "started" } });
    session.emit({ type: "agent_end", messages: [assistant], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.subagents = [];
    session.emit({ type: "agent_end", messages: [assistant], isTerminal: true });

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("settles a task dispatch announced after its child completed", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "early-child",
          agent: "scout",
          status,
          parentToolCallId: "late-task",
          index: 0,
        },
      });
    }
    session.emit({
      type: "tool_execution_start",
      toolCallId: "late-task",
      toolName: "task",
      args: { tasks: [{ task: "inspect" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "late-task",
      toolName: "task",
      result: { details: { results: [{ id: "early-child", agent: "scout" }] } },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("does not backfill a reused task call from another session", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await startPrompt(connection, events);
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "old-child",
          agent: "old-child",
          status,
          parentToolCallId: "reused-task-call",
          index: 0,
        },
      });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "new-parent", agent: "new-parent", status: "started", index: 1 },
    });
    const parent = events.findLast(
      (event) => event.type === "session.opened" && event.title === "new-parent",
    );
    if (parent?.type !== "session.opened") throw new Error("Missing parent session");
    for (const event of [
      {
        type: "tool_execution_start" as const,
        toolCallId: "reused-task-call",
        toolName: "task",
        args: { tasks: [{ task: "inspect" }] },
      },
      {
        type: "tool_execution_end" as const,
        toolCallId: "reused-task-call",
        toolName: "task",
        result: { details: { results: [{ id: "new-child", agent: "new-child" }] } },
      },
    ]) {
      session.emit({ type: "subagent_event", payload: { id: "new-parent", event } });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "new-child",
        agent: "new-child",
        status: "started",
        parentToolCallId: "reused-task-call",
        index: 0,
      },
    });
    expect(
      events.findLast((event) => event.type === "session.opened" && event.title === "new-child"),
    ).toEqual(expect.objectContaining({ parentSessionId: parent.sessionId }));
    await connection.close();
  });

  test("settles a successful task acknowledgement with no child evidence", async () => {
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
      toolCallId: "task-no-child",
      toolName: "task",
      args: { tasks: [{ task: "cannot schedule" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-no-child",
      toolName: "task",
      result: { details: { results: [], progress: [] }, message: "No agent was scheduled" },
    });
    await finishTurn(events, session, turnId);
    expect(
      events.filter((event) => event.type === "session.opened" && event.parentSessionId),
    ).toHaveLength(0);
    await connection.close();
  });

  test("completes a transported zero-child task after degrading ancillary metadata", async () => {
    let child: ProviderRpcChild;
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        child = new ProviderRpcChild((command) => {
          const respond = (data: unknown) =>
            child.write({ type: "response", id: command.id, success: true, data });
          if (command.type === "negotiate_protocol") {
            respond({ protocolVersion: 2 });
          } else if (command.type === "get_available_models") {
            respond({ models: [MODEL] });
          } else if (command.type === "get_available_commands") {
            respond({ commands: [] });
          } else if (command.type === "get_state") {
            respond({
              model: MODEL,
              thinkingLevel: "medium",
              isStreaming: false,
              isCompacting: false,
              sessionId: NATIVE_SESSION_ID,
            });
          } else if (command.type === "get_subagents") {
            respond({ subagents: [] });
          } else if (command.type === "set_subagent_subscription") {
            respond({ level: "events" });
          } else if (command.type === "prompt") {
            const requestId = String(command.id);
            respond({ agentInvoked: true });
            queueMicrotask(() => {
              child.write({
                type: "tool_execution_start",
                toolCallId: "transport-task-no-child",
                toolName: "task",
                args: { tasks: [{ task: "cannot schedule" }] },
              });
              child.write({
                type: "tool_execution_end",
                toolCallId: "transport-task-no-child",
                toolName: "task",
                result: {
                  message: "No agent was scheduled",
                  details: {
                    results: [],
                    progress: [],
                    displayContent: {
                      lineNumbers: Array.from({ length: 2_049 }, (_, index) => index),
                    },
                  },
                },
              });
              const assistant = {
                role: "assistant",
                id: "transport-task-answer",
                content: "done",
                stopReason: "stop",
              };
              child.write({ type: "message_end", message: assistant });
              child.write({
                type: "agent_end",
                requestId,
                messages: [assistant],
                messageCount: 1,
                isTerminal: true,
              });
            });
          }
        });
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
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.subsession"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(
      connection,
      events,
      "transport-task-open",
      "transport-task-session",
      {},
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );

    const turnId = turnIdFrom(
      await startPrompt(
        connection,
        events,
        "transport-task-prompt",
        "delegate",
        "transport-task-session",
      ),
    );
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter((event) => event.type === "session.opened" && event.parentSessionId),
    ).toHaveLength(0);
    await connection.close();
  });

  test("restarts a terminal child id for follow-up work without losing history", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const runChildTurn = async (
      parentClientMessageId: string,
      taskCallId: string,
      responseId: string,
      text: string,
    ) => {
      const parentTurnId = turnIdFrom(
        await startPrompt(connection, events, parentClientMessageId, text),
      );
      session.emit({
        type: "tool_execution_start",
        toolCallId: taskCallId,
        toolName: "task",
        args: { tasks: [{ task: text }] },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: taskCallId,
        toolName: "task",
        result: { message: "spawned" },
      });
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "reused-child",
          agent: "scout",
          status: "started",
          parentToolCallId: taskCallId,
          index: 0,
        },
      });
      session.emit({
        type: "subagent_event",
        payload: {
          id: "reused-child",
          event: {
            type: "message_end",
            message: { role: "assistant", responseId, content: text },
          },
        },
      });
      establishTerminalOwnership(session);
      const requestId = `rpc-prompt-${session.promptCount}`;
      session.emit({ type: "agent_end", requestId, messages: [], isTerminal: true });
      await Promise.resolve();
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === parentTurnId &&
            event.state === "completed",
        ),
      ).toBe(false);
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "reused-child",
          agent: "scout",
          status: "completed",
          parentToolCallId: taskCallId,
          index: 0,
        },
      });
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === parentTurnId &&
          event.state === "completed",
      );
    };

    await runChildTurn("follow-up-parent-one", "follow-up-task-one", "child-response-one", "first");
    const childOpened = events.find(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (childOpened?.type !== "session.opened") throw new Error("Missing reused child");
    await runChildTurn(
      "follow-up-parent-two",
      "follow-up-task-two",
      "child-response-two",
      "second",
    );
    expect(
      events.filter(
        (event) => event.type === "session.opened" && event.sessionId === childOpened.sessionId,
      ),
    ).toHaveLength(1);
    const childTurns = events.flatMap((event) =>
      event.type === "session.turn" && event.sessionId === childOpened.sessionId ? [event] : [],
    );
    expect(childTurns.filter((event) => event.state === "started")).toHaveLength(2);
    expect(childTurns.filter((event) => event.state === "completed")).toHaveLength(2);
    expect(new Set(childTurns.map((event) => event.turnId)).size).toBe(2);
    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.sessionId === childOpened.sessionId &&
        event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      ),
    ).toEqual(["first", "second"]);
    await connection.close();
  });

  test("keeps a batch dispatch active across gaps between child starts", async () => {
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
      toolCallId: "task-batch",
      toolName: "task",
      args: { task: "batch" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-batch",
      toolName: "task",
      result: {
        message: "Spawned 2 background agents",
        details: {
          results: [],
          progress: [
            { index: 0, id: "native-batch-one", agent: "first", status: "pending" },
            { index: 1, id: "native-batch-two", agent: "second", status: "pending" },
          ],
        },
      },
    });
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-batch-one",
          agent: "first",
          status,
          sessionFile: "/sessions/root/native-batch-one.jsonl",
          parentToolCallId: "task-batch",
          index: 0,
        },
      });
    }
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
      ),
    ).toBe(false);
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-batch-two",
          agent: "second",
          status,
          sessionFile: "/sessions/root/native-batch-two.jsonl",
          parentToolCallId: "task-batch",
          index: 1,
        },
      });
    }
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
      ),
    ).toHaveLength(2);
    await connection.close();
  });

  test("publishes nested task children beneath their native parent", async () => {
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
      toolCallId: "root-task",
      toolName: "task",
      args: { tasks: [{ task: "parent" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "root-task",
      toolName: "task",
      result: { message: "spawned" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-parent-child",
        agent: "parent-child",
        status: "started",
        sessionFile: "/sessions/root/native-parent-child.jsonl",
        parentToolCallId: "root-task",
        index: 0,
      },
    });
    const parentChild = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (parentChild?.type !== "session.opened") throw new Error("Missing parent child session");
    expect(parentChild.capabilities).toEqual(["session.subsession"]);
    expect(parentChild.toolCallId).toBe("root-task");
    for (const event of [
      {
        type: "tool_execution_start" as const,
        toolCallId: "nested-task",
        toolName: "task",
        args: { tasks: [{ task: "grandchild" }] },
      },
      {
        type: "tool_execution_end" as const,
        toolCallId: "nested-task",
        toolName: "task",
        result: { message: "spawned" },
      },
    ]) {
      session.emit({ type: "subagent_event", payload: { id: "native-parent-child", event } });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-grandchild",
        agent: "grandchild",
        status: "started",
        sessionFile: "/sessions/root/native-parent-child/native-grandchild.jsonl",
        parentToolCallId: "nested-task",
        index: 0,
      },
    });
    const grandchild = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === parentChild.sessionId,
    );
    expect(grandchild).toEqual(
      expect.objectContaining({
        type: "session.opened",
        parentSessionId: parentChild.sessionId,
        toolCallId: "nested-task",
        capabilities: ["session.subsession"],
      }),
    );
    expect(grandchild).not.toEqual(expect.objectContaining({ parentSessionId: "session-1" }));
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-parent-child",
        agent: "parent-child",
        status: "completed",
        sessionFile: "/sessions/root/native-parent-child.jsonl",
        parentToolCallId: "root-task",
        index: 0,
      },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === parentChild.sessionId &&
          event.state === "completed",
      ),
    ).toBe(false);
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-grandchild",
        agent: "grandchild",
        status: "completed",
        sessionFile: "/sessions/root/native-parent-child/native-grandchild.jsonl",
        parentToolCallId: "nested-task",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === parentChild.sessionId &&
          event.state === "completed",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("rejects live task owner collisions and permits reuse after dispatch settlement", async () => {
    const collisionHarness = await createHarness(new FakeOmpRuntime(), new ManualScheduler(), [
      "prompt.message",
      "session.subsession",
    ]);
    await openSession(collisionHarness.connection, collisionHarness.events);
    const collisionSession = sessionAt(collisionHarness.runtime);
    const collisionTurnId = turnIdFrom(
      await startPrompt(collisionHarness.connection, collisionHarness.events),
    );
    collisionSession.emit({
      type: "tool_execution_start",
      toolCallId: "colliding-task",
      toolName: "task",
      args: { tasks: [{ task: "parent" }] },
    });
    collisionSession.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "collision-parent",
        agent: "parent",
        status: "started",
        parentToolCallId: "colliding-task",
        index: 0,
      },
    });
    collisionSession.emit({
      type: "subagent_event",
      payload: {
        id: "collision-parent",
        event: {
          type: "tool_execution_start",
          toolCallId: "colliding-task",
          toolName: "task",
          args: { tasks: [{ task: "nested" }] },
        },
      },
    });
    await collisionHarness.events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === collisionTurnId &&
        event.state === "failed",
    );
    await collisionHarness.connection.close();

    const reuseHarness = await createHarness(new FakeOmpRuntime(), new ManualScheduler(), [
      "prompt.message",
      "session.subsession",
    ]);
    await openSession(reuseHarness.connection, reuseHarness.events);
    const reuseSession = sessionAt(reuseHarness.runtime);
    const firstTurnId = turnIdFrom(
      await startPrompt(reuseHarness.connection, reuseHarness.events, "first-owner"),
    );
    reuseSession.emit({
      type: "tool_execution_start",
      toolCallId: "reusable-task",
      toolName: "task",
      args: { tasks: [{ task: "first" }] },
    });
    reuseSession.emit({
      type: "tool_execution_end",
      toolCallId: "reusable-task",
      toolName: "task",
      result: { message: "spawned" },
    });
    for (const status of ["started", "completed"] as const) {
      reuseSession.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "first-owner-child",
          agent: "first",
          status,
          parentToolCallId: "reusable-task",
          index: 0,
        },
      });
    }
    await finishTurn(reuseHarness.events, reuseSession, firstTurnId);

    const secondTurnId = turnIdFrom(
      await startPrompt(reuseHarness.connection, reuseHarness.events, "second-owner"),
    );
    reuseSession.emit({
      type: "tool_execution_start",
      toolCallId: "second-root-task",
      toolName: "task",
      args: { tasks: [{ task: "second" }] },
    });
    reuseSession.emit({
      type: "tool_execution_end",
      toolCallId: "second-root-task",
      toolName: "task",
      result: { message: "spawned" },
    });
    reuseSession.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "second-owner-child",
        agent: "second",
        status: "started",
        parentToolCallId: "second-root-task",
        index: 0,
      },
    });
    const secondChild = reuseHarness.events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (secondChild?.type !== "session.opened") throw new Error("Missing second child");
    reuseSession.emit({
      type: "subagent_event",
      payload: {
        id: "second-owner-child",
        event: {
          type: "tool_execution_start",
          toolCallId: "reusable-task",
          toolName: "task",
          args: { tasks: [{ task: "nested reuse" }] },
        },
      },
    });
    reuseSession.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "reused-grandchild",
        agent: "nested",
        status: "started",
        parentToolCallId: "reusable-task",
        index: 0,
      },
    });
    expect(reuseHarness.events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        parentSessionId: secondChild.sessionId,
      }),
    );
    reuseSession.emit({ type: "process_exit", error: "test cleanup" });
    await reuseHarness.events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurnId && event.state === "failed",
    );
    await reuseHarness.connection.close();
  });

  test("isolates identical native child ids across ephemeral provider roots", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push(NATIVE_SESSION_ID, NATIVE_SESSION_ID);
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.subsession",
    ]);
    await openSession(
      connection,
      events,
      "open-ephemeral-one",
      "ephemeral-one",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    await openSession(
      connection,
      events,
      "open-ephemeral-two",
      "ephemeral-two",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    await startPrompt(connection, events, "prompt-ephemeral-one", "work", "ephemeral-one");
    await startPrompt(connection, events, "prompt-ephemeral-two", "work", "ephemeral-two");
    for (const index of [0, 1]) {
      sessionAt(runtime, index).emit({
        type: "subagent_lifecycle",
        payload: {
          id: "same-native-child",
          agent: "scout",
          status: "started",
          index: 0,
        },
      });
    }
    const firstChild = events.find(
      (event) => event.type === "session.opened" && event.parentSessionId === "ephemeral-one",
    );
    const secondChild = events.find(
      (event) => event.type === "session.opened" && event.parentSessionId === "ephemeral-two",
    );
    if (firstChild?.type !== "session.opened" || secondChild?.type !== "session.opened") {
      throw new Error("Missing ephemeral children");
    }
    expect(secondChild.sessionId).not.toBe(firstChild.sessionId);
    await connection.close();
  });
});
