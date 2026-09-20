import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { ompModelId } from "../server/provider/catalog";
import { OmpNativeSessionReservations } from "../server/provider/connection";
import type { OmpMessage, OmpModel } from "../server/provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import { createOmpProvider } from "../server/provider/registration";
import { OmpTimelineProjector } from "../server/provider/timeline-projector";
import {
  ALTERNATE_MODEL,
  BRANCHED_NATIVE_SESSION_ID,
  createHarness,
  EventLog,
  FakeOmpRuntime,
  type FakeOmpSession,
  finishTurn,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("verifies session, model, and thinking state after a successful rewind", async () => {
    const firstUser = { role: "user" as const, entryId: "entry-user-1", content: "first" };
    const firstAssistant = {
      role: "assistant" as const,
      entryId: "entry-assistant-1",
      content: "first reply",
    };
    const secondUser = { role: "user" as const, entryId: "entry-user-2", content: "second" };
    const secondAssistant = {
      role: "assistant" as const,
      entryId: "entry-assistant-2",
      content: "second reply",
    };
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = [firstUser, firstAssistant, secondUser, secondAssistant];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
      "session.revert.files",
      "session.revert.both",
    ]);
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "rewind-open",
      sessionId: "rewind-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "rewind-open",
    );
    const target = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.text === "second",
    );
    if (target?.type !== "timeline.item" || target.item.type !== "user_message") {
      throw new Error("Missing rewind target");
    }
    const token = target.item.revertToken;
    if (typeof token !== "string") throw new Error("Missing opaque rewind token");
    expect(token).not.toContain("entry-user-2");

    const session = sessionAt(runtime);
    session.branchHistoryAfter = [firstUser, firstAssistant];
    session.branchModelAfter = ALTERNATE_MODEL;
    session.branchThinkingAfter = "high";
    session.branchSessionIdAfter = BRANCHED_NATIVE_SESSION_ID;
    const baseline = events.length;
    await connection.send({
      type: "session.revert",
      requestId: "rewind-earlier",
      sessionId: "rewind-session",
      token,
      scope: "conversation",
    });
    const rewindOutcome = await events.waitFor(
      (event) =>
        (event.type === "request.completed" || event.type === "request.failed") &&
        event.requestId === "rewind-earlier",
    );
    expect(rewindOutcome).toEqual({ type: "request.completed", requestId: "rewind-earlier" });

    expect(session.branches).toEqual(["entry-user-2"]);
    expect(session.historyRequests).toBe(2);
    expect(session.branchMessageLookups).toBe(0);
    expect(session.modelChanges).toEqual([{ provider: MODEL.provider, modelId: MODEL.id }]);
    expect(session.thinkingChanges).toEqual(["medium"]);
    expect(session.currentModel).toEqual(MODEL);
    expect(session.thinkingLevel).toBe("medium");
    expect(events.slice(baseline)).toContainEqual({
      type: "session.persistence",
      sessionId: "rewind-session",
      persistence: { version: 1, data: { sessionId: BRANCHED_NATIVE_SESSION_ID } },
    });
    expect(
      events
        .slice(baseline)
        .flatMap((event) =>
          event.type === "timeline.item" &&
          (event.item.type === "user_message" || event.item.type === "assistant_message")
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["first", "first reply"]);

    const replacementUser = events
      .slice(baseline)
      .find((event) => event.type === "timeline.item" && event.item.type === "user_message");
    if (replacementUser?.type !== "timeline.item" || replacementUser.item.type !== "user_message") {
      throw new Error("Missing replacement rewind target");
    }
    expect(replacementUser.item.revertToken).not.toBe(token);

    session.branchMessages = [
      { entryId: "entry-user-1", text: "first" },
      { entryId: "entry-user-live", text: "continue" },
    ];
    session.promptEvents = [
      { type: "message_end", message: { role: "user", content: "continue" } },
      { type: "message_end", message: firstAssistant },
      {
        type: "message_end",
        message: { role: "assistant", entryId: "entry-assistant-live", content: "live reply" },
      },
    ];
    const liveBaseline = events.length;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "after-rewind", "continue", "rewind-session"),
    );
    expect(
      events
        .slice(liveBaseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["live reply"]);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );

    await connection.send({
      type: "session.revert",
      requestId: "stale-rewind",
      sessionId: "rewind-session",
      token,
      scope: "conversation",
    });
    const stale = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "stale-rewind",
    );
    expect(stale).toEqual(
      expect.objectContaining({ error: { message: "OMP conversation rewind token is stale" } }),
    );
    expect(session.branches).toEqual(["entry-user-2"]);
    await connection.close();
  });

  test("does not restore unadvertised thinking after rewind", async () => {
    const history = [
      { role: "user" as const, entryId: "rewind-user", content: "before" },
      { role: "assistant" as const, entryId: "rewind-assistant", content: "reply" },
    ];
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = history;
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "unsupported-thinking-rewind-open",
      sessionId: "unsupported-thinking-rewind-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.ready" && event.requestId === "unsupported-thinking-rewind-open",
    );
    const target = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (target?.type !== "timeline.item" || target.item.type !== "user_message") {
      throw new Error("Missing rewind target");
    }
    const session = sessionAt(runtime);
    session.thinkingLevel = "max";
    session.branchMessages = [{ entryId: "rewind-user", text: "before" }];
    session.branchHistoryAfter = history;
    session.branchThinkingAfter = "high";

    await connection.send({
      type: "session.revert",
      requestId: "unsupported-thinking-rewind",
      sessionId: "unsupported-thinking-rewind-session",
      token: target.item.revertToken ?? null,
      scope: "conversation",
    });
    await expect(
      events.waitFor(
        (event) =>
          event.type === "request.completed" && event.requestId === "unsupported-thinking-rewind",
      ),
    ).resolves.toEqual({ type: "request.completed", requestId: "unsupported-thinking-rewind" });
    expect(session.thinkingChanges).not.toContain("max");
    expect(session.thinkingLevel).toBe("high");
    await connection.close();
  });

  test("rewinds a retained target beyond the branch snapshot limit", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = Array.from({ length: 1_025 }, (_, index) => ({
      role: "user" as const,
      entryId: `retained-entry-${index}`,
      content: `retained-message-${index}`,
    }));
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "retained-rewind-open",
      sessionId: "retained-rewind-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "retained-rewind-open",
    );
    const target = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.text === "retained-message-1024",
    );
    if (target?.type !== "timeline.item" || target.item.type !== "user_message") {
      throw new Error("Missing retained rewind target");
    }

    const session = sessionAt(runtime);
    session.branchHistoryAfter = [];
    await connection.send({
      type: "session.revert",
      requestId: "retained-rewind",
      sessionId: "retained-rewind-session",
      token: target.item.revertToken ?? null,
      scope: "conversation",
    });
    await expect(
      events.waitFor(
        (event) =>
          (event.type === "request.completed" || event.type === "request.failed") &&
          event.requestId === "retained-rewind",
      ),
    ).resolves.toEqual({ type: "request.completed", requestId: "retained-rewind" });
    expect(session.branches).toEqual(["retained-entry-1024"]);
    expect(session.branchMessageLookups).toBe(0);
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("rejects active-turn and unsupported rewind requests before branching", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = [{ role: "user", entryId: "active-entry", content: "earlier" }];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
      "session.revert.files",
      "session.revert.both",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "active-rewind-open",
      sessionId: "active-rewind-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "active-rewind-open",
    );
    const user = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (user?.type !== "timeline.item" || user.item.type !== "user_message") {
      throw new Error("Missing active rewind target");
    }
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "active-prompt", "work", "active-rewind-session"),
    );
    for (const scope of ["conversation", "files", "both"] as const) {
      await connection.send({
        type: "session.revert",
        requestId: `active-rewind-${scope}`,
        sessionId: "active-rewind-session",
        token: user.item.revertToken ?? null,
        scope,
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === `active-rewind-${scope}`,
      );
    }
    expect(sessionAt(runtime).branches).toEqual([]);
    await finishTurn(events, sessionAt(runtime), turnId);
    await connection.close();
  });

  test("fails closed for malformed and foreign rewind tokens", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.revert.conversation",
    ]);
    await openSession(
      connection,
      events,
      "token-open",
      "token-session",
      {},
      MODEL_PUBLIC_ID,
      "medium",
    );
    const foreignEvents: ProviderEvent[] = [];
    const foreignProjector = new OmpTimelineProjector(
      "foreign",
      (event) => foreignEvents.push(event),
      new ManualScheduler(),
      [],
      true,
    );
    foreignProjector.publishUser("foreign", "foreign-client", "foreign-entry");
    const foreign = foreignEvents.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (foreign?.type !== "timeline.item" || foreign.item.type !== "user_message") {
      throw new Error("Missing foreign rewind token");
    }

    for (const [requestId, token] of [
      ["malformed-rewind", { entryId: "forged" }],
      ["foreign-rewind", foreign.item.revertToken ?? null],
    ] as const) {
      await connection.send({
        type: "session.revert",
        requestId,
        sessionId: "token-session",
        token,
        scope: "conversation",
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    const session = sessionAt(runtime);
    expect(session.branches).toEqual([]);
    session.canReplayHistory = false;
    await connection.send({
      type: "session.revert",
      requestId: "replay-capability-lost",
      sessionId: "token-session",
      token: foreign.item.revertToken ?? null,
      scope: "conversation",
    });
    await expect(
      events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "replay-capability-lost",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        error: { message: "OMP conversation rewind requires negotiated RPC protocol v2" },
      }),
    );
    expect(session.branches).toEqual([]);
    await connection.close();
  });

  test("does not close the session when OMP rejects a stale branch target", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = [{ role: "user", entryId: "failure-entry", content: "earlier" }];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "failure-open",
      sessionId: "failure-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "failure-open",
    );
    const user = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (user?.type !== "timeline.item" || user.item.type !== "user_message") {
      throw new Error("Missing failed rewind target");
    }
    const session = sessionAt(runtime);
    session.branchError = new OmpRpcRequestRejectedError();
    await connection.send({
      type: "session.revert",
      requestId: "failed-native-rewind",
      sessionId: "failure-session",
      token: user.item.revertToken ?? null,
      scope: "conversation",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failed-native-rewind",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP conversation rewind token is stale" },
      }),
    );
    expect(JSON.stringify(failure)).not.toContain("native branch secret");
    expect(session.historyRequests).toBe(1);
    expect(session.branchMessageLookups).toBe(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "session.closed", sessionId: "failure-session" }),
    );
    expect(session.closes).toBe(0);
    await connection.close();
    expect(session.closes).toBe(1);
  });
  test("closes the mutated runtime after post-branch state, restore, or replay failure", async () => {
    const cases: Array<{
      stage: string;
      nativeSessionId: string;
      cleanupFails?: boolean;
      fail(session: FakeOmpSession): void;
    }> = [
      {
        stage: "response",
        nativeSessionId: "01a08f6b-8da9-72cb-9080-fc50139bdfd0",
        fail(session) {
          session.branchResultError = new Error("OMP RPC response is invalid");
        },
      },
      {
        stage: "state",
        nativeSessionId: "01a08f6b-8da9-72cb-9080-fc50139bdfd1",
        fail(session) {
          session.branchStateErrorAfter = new Error("state failed");
        },
      },
      {
        stage: "config",
        nativeSessionId: "01a08f6b-8da9-72cb-9080-fc50139bdfd2",
        fail(session) {
          session.branchModelAfter = ALTERNATE_MODEL;
          session.modelChangeError = new Error("restore failed");
        },
      },
      {
        stage: "replay",
        nativeSessionId: "01a08f6b-8da9-72cb-9080-fc50139bdfd3",
        cleanupFails: true,
        fail(session) {
          session.branchHistoryErrorAfter = new Error("replay failed");
        },
      },
    ];

    for (const testCase of cases) {
      const failures: OmpOperationalFailure[] = [];
      const runtime = new FakeOmpRuntime();
      runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
      runtime.nextHistoryMessages = [
        { role: "user", entryId: `${testCase.stage}-entry`, content: "earlier" },
      ];
      const { connection, events } = await createHarness(
        runtime,
        new ManualScheduler(),
        ["prompt.message", "session.list", "session.persistence", "session.revert.conversation"],
        undefined,
        (failure) => failures.push(failure),
      );
      const sessionId = `${testCase.stage}-failure-session`;
      await connection.send({
        type: "session.open",
        requestId: `${testCase.stage}-failure-open`,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
      await events.waitFor(
        (event) =>
          event.type === "session.ready" && event.requestId === `${testCase.stage}-failure-open`,
      );
      const user = events.find(
        (event) => event.type === "timeline.item" && event.item.type === "user_message",
      );
      if (user?.type !== "timeline.item" || user.item.type !== "user_message") {
        throw new Error(`Missing ${testCase.stage} failure rewind token`);
      }
      const session = sessionAt(runtime);
      if (testCase.cleanupFails) session.closeError = new Error("cleanup failed");
      session.branchSessionIdAfter = testCase.nativeSessionId;
      testCase.fail(session);
      const cleanup = Promise.withResolvers<void>();
      const cleanupStarted = Promise.withResolvers<void>();
      session.closeGate = cleanup.promise;
      session.closeObserved = cleanupStarted.resolve;
      const requestId = `${testCase.stage}-post-branch-failure`;
      await connection.send({
        type: "session.revert",
        requestId,
        sessionId,
        token: user.item.revertToken ?? null,
        scope: "conversation",
      });
      await cleanupStarted.promise;
      expect(session.nativeSessionId).toBe(testCase.nativeSessionId);
      expect(
        events.some((event) => event.type === "request.failed" && event.requestId === requestId),
      ).toBe(false);
      cleanup.resolve();
      const failure = await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
      expect(failure).toEqual(
        expect.objectContaining({
          error: { message: "OMP conversation rewind left native state indeterminate" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.closed",
          sessionId,
          error: { message: "OMP conversation rewind left native state indeterminate" },
        }),
      );
      expect(session.closes).toBe(1);
      expect(failures).toEqual([{ category: "replay-recovery", stage: "rewind" }]);

      await connection.send({
        type: "session.prompt",
        sessionId,
        prompt: {
          clientMessageId: `${testCase.stage}-after-failure`,
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "must not run" }] },
        },
      });
      await expect(
        events.waitFor(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === `${testCase.stage}-after-failure`,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          result: { type: "failed", error: { message: "Unknown OMP session" } },
        }),
      );
      expect(session.prompts).toEqual([]);
      if (testCase.cleanupFails) {
        await connection.send({
          type: "sessions",
          requestId: "list-after-failed-rewind-cleanup",
          cwd: "/repo",
        });
        await expect(
          events.waitFor(
            (event) =>
              event.type === "request.failed" &&
              event.requestId === "list-after-failed-rewind-cleanup",
          ),
        ).resolves.toEqual(
          expect.objectContaining({
            error: { message: "OMP native session cleanup quarantine is active" },
          }),
        );
      }
      if (testCase.cleanupFails) {
        await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
      } else {
        await connection.close();
      }
    }
  });

  test("quarantines committed rewind failure until runtime and host teardown complete", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = [
      { role: "user", entryId: "security-rewind-entry", content: "earlier" },
    ];
    const runtimeCleanup = Promise.withResolvers<void>();
    const runtimeCloseStarted = Promise.withResolvers<void>();
    const hostCleanup = Promise.withResolvers<void>();
    const hostCloseStarted = Promise.withResolvers<void>();
    let hostCloses = 0;
    const provider = createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          hostCloses += 1;
          hostCloseStarted.resolve();
          await hostCleanup.promise;
        },
      }),
    });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: [
          "prompt.message",
          "permission",
          "session.persistence",
          "session.revert.conversation",
          "session.subsession",
        ],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    await first.connection.send({
      type: "session.open",
      requestId: "security-rewind-open",
      sessionId: "security-rewind-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: { repo: { type: "stdio", command: "repo" } },
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "security-rewind-open",
    );
    const user = first.events.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (user?.type !== "timeline.item" || user.item.type !== "user_message") {
      throw new Error("Missing security rewind token");
    }
    const session = sessionAt(runtime);
    const permissionCancellation = Promise.withResolvers<void>();
    session.extensionUiResponseObserved = permissionCancellation.resolve;
    session.emit({
      type: "extension_ui_request",
      id: "security-rewind-permission",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = first.events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected rewind permission");
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "security-child", agent: "scout", status: "started", index: 0 },
    });
    const child = first.events.findLast(
      (event) =>
        event.type === "session.opened" && event.parentSessionId === "security-rewind-session",
    );
    if (child?.type !== "session.opened") throw new Error("Expected rewind child session");
    session.branchSessionIdAfter = BRANCHED_NATIVE_SESSION_ID;
    session.branchHistoryErrorAfter = new Error("replay failed");
    session.closeGate = runtimeCleanup.promise;
    session.closeObserved = runtimeCloseStarted.resolve;

    await first.connection.send({
      type: "session.revert",
      requestId: "security-rewind",
      sessionId: "security-rewind-session",
      token: user.item.revertToken ?? null,
      scope: "conversation",
    });
    await Promise.all([
      runtimeCloseStarted.promise,
      hostCloseStarted.promise,
      permissionCancellation.promise,
    ]);
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "security-rewind-permission",
      cancelled: true,
    });
    expect(first.events).toContainEqual({
      type: "session.permission_resolved",
      sessionId: "security-rewind-session",
      permissionId: permission.request.id,
    });
    expect(first.events).toContainEqual({ type: "session.closed", sessionId: child.sessionId });
    expect(session.closes).toBe(1);
    expect(hostCloses).toBe(1);
    expect(
      first.events.some(
        (event) => event.type === "request.failed" && event.requestId === "security-rewind",
      ),
    ).toBe(false);

    const expectQuarantined = async (requestId: string) => {
      await second.connection.send({
        type: "session.open",
        requestId,
        sessionId: requestId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });
      await expect(
        second.events.waitFor(
          (event) => event.type === "request.failed" && event.requestId === requestId,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          error: { message: "OMP native session cleanup quarantine is active" },
        }),
      );
    };
    await expectQuarantined("security-rewind-blocked-both");
    runtimeCleanup.resolve();
    await runtimeCleanup.promise;
    await expectQuarantined("security-rewind-blocked-host");

    hostCleanup.resolve();
    await hostCleanup.promise;
    await first.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "security-rewind",
    );
    await Promise.resolve();
    await second.connection.send({
      type: "session.open",
      requestId: "security-rewind-released",
      sessionId: "security-rewind-released",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "security-rewind-released",
    );
    await first.connection.close();
    await second.connection.close();
  });

  test("moves persistent reservation ownership to the branched native session", async () => {
    const reservations = new OmpNativeSessionReservations();
    const owner = Symbol("owner");
    const contender = Symbol("contender");
    await reservations.reserve(NATIVE_SESSION_ID, owner);
    reservations.transition(NATIVE_SESSION_ID, BRANCHED_NATIVE_SESSION_ID, owner);

    await expect(reservations.reserve(NATIVE_SESSION_ID, contender)).resolves.toBeUndefined();
    await expect(reservations.reserve(BRANCHED_NATIVE_SESSION_ID, contender)).rejects.toThrow(
      "OMP native session is already open",
    );
  });
  test("keeps replay-boundary counts beyond 1,024 occurrences", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = Array.from({ length: 1_025 }, (_, index): OmpMessage[] => [
      { role: "user", id: `large-user-${index}`, content: `prompt ${index}` },
      { role: "assistant", id: "shared-replay-id", content: "same answer" },
    ]).flat();
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "large-dedup-open",
      sessionId: "large-dedup-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "large-dedup-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );

    expect(replayedAssistants).toHaveLength(1_025);
    expect(new Set(replayedAssistants.map((item) => item.id)).size).toBe(1_025);
    const session = sessionAt(runtime);
    session.promptEvents = [
      {
        type: "message_start",
        message: { role: "assistant", id: "shared-replay-id", content: [] },
      },
      {
        type: "message_update",
        message: { role: "assistant", id: "shared-replay-id", content: "same" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "same" },
      },
      {
        type: "message_end",
        message: { role: "assistant", id: "shared-replay-id", content: "same answer" },
      },
    ];
    const boundaryBaseline = events.length;
    const liveTurn = turnIdFrom(
      await startPrompt(connection, events, "large-dedup-live", "continue", "large-dedup-session"),
    );
    expect(events.slice(boundaryBaseline).some((event) => event.type === "timeline.item")).toBe(
      false,
    );

    const liveBaseline = events.length;
    session.emit({
      type: "message_end",
      message: { role: "assistant", id: "shared-replay-id", content: "same answer" },
    });
    expect(events.slice(liveBaseline)).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "same answer" }),
      }),
    );
    await finishTurn(events, session, liveTurn);
    await connection.close();
  });
  test("scopes identical replay occurrences to the replay boundary", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const duplicate = {
      role: "assistant" as const,
      entryId: "shared-assistant-entry",
      responseId: "shared-response",
      content: "same answer",
    };
    runtime.nextHistoryMessages = [
      { role: "user", entryId: "replay-user-1", content: "first" },
      duplicate,
      { role: "user", entryId: "replay-user-2", content: "second" },
      duplicate,
    ];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "occurrence-open",
      sessionId: "occurrence-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "occurrence-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(replayedAssistants.map((item) => item.text)).toEqual(["same answer", "same answer"]);
    expect(new Set(replayedAssistants.map((item) => item.id)).size).toBe(2);

    const session = sessionAt(runtime);
    session.promptEvents = [{ type: "message_end", message: duplicate }];
    const boundaryBaseline = events.length;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "occurrence-live", "continue", "occurrence-session"),
    );
    expect(
      events
        .slice(boundaryBaseline)
        .filter(
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        ),
    ).toHaveLength(0);

    const liveBaseline = events.length;
    session.emit({ type: "message_end", message: duplicate });
    expect(
      events
        .slice(liveBaseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["same answer"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("suppresses a replay duplicate after buffering 512 stream events", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector("event-limit-session", (event) =>
      events.push(event),
    );
    const duplicate = {
      role: "assistant" as const,
      entryId: "event-limit-entry",
      content: "same answer",
    };
    projector.projectReplayMessage(duplicate);
    projector.finishReplay();
    const baseline = events.length;
    projector.project({ type: "message_start", message: duplicate }, "replay-boundary");
    for (let index = 0; index < 511; index += 1) {
      projector.project(
        {
          type: "message_update",
          message: duplicate,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
        },
        "replay-boundary",
      );
    }
    projector.project({ type: "message_end", message: duplicate }, "replay-boundary");
    expect(events.slice(baseline)).toHaveLength(0);
    projector.close();
  });

  test("suppresses a replay duplicate after buffering four MiB", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector("byte-limit-session", (event) => events.push(event));
    const content = "x".repeat(1024 * 1024);
    const duplicate = { role: "assistant" as const, entryId: "byte-limit-entry", content };
    projector.projectReplayMessage(duplicate);
    projector.finishReplay();
    const baseline = events.length;
    projector.project(
      { type: "message_start", message: { ...duplicate, content: [] } },
      "replay-boundary",
    );
    for (let index = 0; index < 4; index += 1) {
      projector.project(
        {
          type: "message_update",
          message: duplicate,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
        },
        "replay-boundary",
      );
    }
    projector.project({ type: "message_end", message: duplicate }, "replay-boundary");
    expect(events.slice(baseline)).toHaveLength(0);
    projector.close();
  });

  test("replays maximum bounded bash output with shell terminal metadata", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector("bash-replay-session", (event) =>
      events.push(event),
    );
    const output = "x".repeat(4 * 1024 * 1024);
    projector.projectReplayMessage({
      role: "bashExecution",
      entryId: "bash-replay-entry",
      command: "generate-output",
      output,
      exitCode: 137,
      cancelled: true,
      truncated: true,
    });
    projector.finishReplay();

    const replayed = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(replayed).toEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: expect.stringMatching(/^omp:custom:/u),
          callId: expect.stringMatching(/^omp:custom:/u),
          name: "bashExecution",
          status: "canceled",
          detail: {
            type: "shell",
            command: "generate-output",
            output,
            exitCode: 137,
          },
          metadata: { cancelled: true, truncated: true },
        }),
      }),
    );
    if (replayed?.type === "timeline.item" && replayed.item.type === "tool_call") {
      expect(replayed.item.callId).toBe(replayed.item.id);
    }
    projector.close();
  });

  test("ignores an inactive runtime thinking level for a nonreasoning model", async () => {
    const runtime = new FakeOmpRuntime();
    const nonReasoningModel: OmpModel = {
      provider: "paseo-ci",
      id: "conformance-model",
      name: "Conformance Model",
      reasoning: false,
      input: ["text"],
    };
    runtime.availableModels = [nonReasoningModel];
    runtime.nextModel = nonReasoningModel;
    runtime.nextThinkingLevel = "medium";
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.configure",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "nonreasoning-open",
      sessionId: "nonreasoning-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: ompModelId(nonReasoningModel),
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });

    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "nonreasoning-open",
    );
    const config = events.findLast(
      (event) => event.type === "session.config" && event.sessionId === "nonreasoning-session",
    );
    expect(config).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ompModelId(nonReasoningModel),
          thinkingOptions: [],
        }),
      }),
    );
    if (config?.type !== "session.config") throw new Error("Expected session config");
    expect(Object.hasOwn(config.config, "thinkingOption")).toBe(false);
    await connection.close();
  });

  test("opens restored sessions while omitting unsupported current thinking", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextThinkingLevel = "max";
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "unsupported-restored-thinking",
      sessionId: "unsupported-restored-thinking-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        thinkingOption: "low",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.ready" && event.requestId === "unsupported-restored-thinking",
    );
    const config = events.findLast((event) => event.type === "session.config");
    if (config?.type !== "session.config") throw new Error("Expected session config");
    expect(config.config.thinkingOption).toBeUndefined();
    expect(runtime.starts[0]?.thinkingOption).toBeUndefined();
    expect(events).toContainEqual({
      type: "session.notice",
      sessionId: "unsupported-restored-thinking-session",
      notice: expect.objectContaining({ id: "omp:unsupported-thinking-level" }),
    });
    await connection.close();
  });

  test("rejects path-shaped or unresolved persistence without starting OMP", async () => {
    const runtime = new FakeOmpRuntime();

    runtime.resolveSessions = false;
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    for (const [requestId, sessionId] of [
      ["path-resume", "../../secret/session.jsonl"],
      ["missing-resume", NATIVE_SESSION_ID],
    ] as const) {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: `provider-${requestId}`,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId } },
        history: "replay",
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.sessionListRequests).toEqual([
      { sessionId: NATIVE_SESSION_ID, cwd: "/repo", limit: 2 },
    ]);
    await connection.close();
  });
  test("rejects a persistence descriptor when persist is false", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "nonpersistent-resume",
      sessionId: "nonpersistent-resume-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "nonpersistent-resume",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP persisted sessions require persist: true" },
      }),
    );
    expect(runtime.sessionListRequests).toEqual([]);
    expect(runtime.starts).toEqual([]);
    await connection.close();
  });
});
