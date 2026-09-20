import { describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  ALTERNATE_MODEL,
  createHarness,
  EventLog,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  openSession,
  ProviderRpcChild,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("fills nullable state context fields from session stats", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.stateContextNull = true;
    session.contextTokens = 4_321;
    session.contextWindow = 180_000;
    session.totalCostUsd = 1.25;
    const turnId = turnIdFrom(await startPrompt(connection, events, "nullable-context", "work"));

    const usage = await events.waitFor(
      (event) => event.type === "session.usage" && event.turnId === turnId,
    );
    expect(usage).toEqual({
      type: "session.usage",
      sessionId: "session-1",
      turnId,
      usage: {
        inputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 100,
        totalCostUsd: 1.25,
        contextWindowUsedTokens: 4_321,
        contextWindowMaxTokens: 180_000,
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("publishes periodic, compacted, fallback, and terminal usage", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "usage-1", "work"));

    await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === turnId &&
        event.usage.contextWindowUsedTokens === 1_000,
    );
    expect(events).toContainEqual({
      type: "session.usage",
      sessionId: "session-1",
      turnId,
      usage: {
        inputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 100,
        totalCostUsd: 0.25,
        contextWindowUsedTokens: 1_000,
        contextWindowMaxTokens: 200_000,
      },
    });

    session.contextTokens = 700;
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.flush(1_000);
    await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === turnId &&
        event.usage.contextWindowUsedTokens === 700,
    );

    session.contextTokens = 320;
    session.contextWindow = 128_000;
    session.currentModel = ALTERNATE_MODEL;
    session.inputTokens = 900;
    session.cachedInputTokens = 250;
    session.outputTokens = 120;
    session.totalCostUsd = 0.3;
    await Promise.resolve();
    await Promise.resolve();
    const lookupsBeforeRefresh = session.stateLookups;
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { tokensBefore: 1_000 },
      aborted: false,
      willRetry: false,
    });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { tokensBefore: 1_000 },
      aborted: false,
      willRetry: false,
    });
    await scheduler.flush(1_000);
    await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === turnId &&
        event.usage.contextWindowUsedTokens === 320,
    );
    expect(session.stateLookups).toBe(lookupsBeforeRefresh + 1);

    const compaction = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    expect(compaction).toHaveLength(2);
    if (
      compaction[0]?.type !== "timeline.item" ||
      compaction[0].item.type !== "compaction" ||
      compaction[1]?.type !== "timeline.item" ||
      compaction[1].item.type !== "compaction"
    ) {
      throw new Error("Expected compaction operation updates");
    }
    expect(compaction[0].item.status).toBe("loading");
    expect(compaction[1].item.status).toBe("completed");
    expect(compaction[1].item.id).toBe(compaction[0].item.id);
    expect(compaction[1].item.preTokens).toBe(1_000);

    session.contextTokens = 280;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminalUsage = await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === turnId &&
        event.usage.contextWindowUsedTokens === 280,
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(events.indexOf(terminalUsage)).toBeLessThan(events.indexOf(terminal));
    if (terminalUsage.type !== "session.usage") throw new Error("Expected terminal usage");
    expect(terminalUsage.usage.contextWindowMaxTokens).toBe(128_000);
    await connection.close();
  });

  test("flushes streams and terminalizes unsuccessful compactions honestly", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events, "compaction-outcomes", "session-1", {
      SECRET: "credential-secret",
    });
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "auto-outcomes", "work"));
    session.emit({
      type: "message_start",
      message: { role: "assistant", responseId: "before-compaction", content: [] },
    });
    session.emit({
      type: "message_update",
      message: { role: "assistant", responseId: "before-compaction", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before" },
    });

    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({ type: "auto_compaction_end", aborted: true, willRetry: false });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      aborted: false,
      willRetry: false,
      skipped: true,
    });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      result: { tokensBefore: 1_000 },
      aborted: false,
      willRetry: false,
    });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      aborted: false,
      willRetry: false,
      errorMessage: "credential-secret failed",
    });

    const items = events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
    const assistantIndex = items.findIndex((item) => item.type === "assistant_message");
    const loading = items.filter((item) => item.type === "compaction" && item.status === "loading");
    expect(loading).toHaveLength(4);
    const firstLoading = loading[0];
    if (!firstLoading) throw new Error("Expected compaction loading update");
    expect(assistantIndex).toBeLessThan(items.indexOf(firstLoading));
    for (const operation of loading) {
      expect(items.filter((item) => item.id === operation.id)).toHaveLength(2);
    }
    expect(
      items.filter((item) => item.type === "compaction" && item.status === "completed"),
    ).toHaveLength(1);
    expect(
      items.some(
        (item) =>
          item.type === "notification" &&
          item.level === "error" &&
          item.message === "credential-secret failed",
      ),
    ).toBe(true);

    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.close();
  });
  test("takes a fresh usage sample after split compaction responses", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.captureUsageOnRequest = true;
    session.compactGate = compact.promise;
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    session.contextTokens = 9_000;
    session.inputTokens = 8_000;
    const turnId = turnIdFrom(await startPrompt(connection, events, "split-usage", "/compact"));
    await observed.promise;

    session.contextTokens = 900;
    session.inputTokens = 850;
    session.outputTokens = 75;
    session.totalCostUsd = 0.75;
    compact.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.resolve();
    stats.resolve();

    const freshUsage = await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === turnId &&
        event.usage.contextWindowUsedTokens === 900,
    );
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(events.indexOf(freshUsage)).toBeLessThan(events.indexOf(terminal));
    expect(
      events.some(
        (event) =>
          event.type === "session.usage" &&
          event.turnId === turnId &&
          event.usage.contextWindowUsedTokens === 9_000,
      ),
    ).toBe(false);
    if (freshUsage.type !== "session.usage") throw new Error("Expected fresh usage event");
    expect(freshUsage.usage).toEqual(
      expect.objectContaining({
        inputTokens: 850,
        outputTokens: 75,
        totalCostUsd: 0.75,
        contextWindowUsedTokens: 900,
      }),
    );
    expect(session.stateLookups).toBeGreaterThanOrEqual(3);
    await connection.close();
  });

  test("starts fresh terminal usage while the pre-compaction sample remains hung", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const staleState = Promise.withResolvers<void>();
    const staleStats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.captureUsageOnRequest = true;
    session.compactGate = compact.promise;
    session.stateGate = staleState.promise;
    session.statsGate = staleStats.promise;
    session.stateObserved = observed.resolve;
    session.contextTokens = 9_000;
    session.inputTokens = 8_000;
    const turnId = turnIdFrom(await startPrompt(connection, events, "hung-usage", "/compact"));
    await observed.promise;

    try {
      session.stateGate = null;
      session.statsGate = null;
      session.contextTokens = 700;
      session.inputTokens = 650;
      compact.resolve();

      const freshUsage = await events.waitFor(
        (event) =>
          event.type === "session.usage" &&
          event.turnId === turnId &&
          event.usage.contextWindowUsedTokens === 700,
      );
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
      );
      expect(events.indexOf(freshUsage)).toBeLessThan(events.indexOf(terminal));
      expect(session.activeStateLookups).toBe(1);
      expect(session.activeStatsLookups).toBe(1);
      expect(session.stateLookups).toBe(4);
      expect(session.statsLookups).toBe(2);
    } finally {
      staleState.resolve();
      staleStats.resolve();
      await connection.close();
    }
  });

  test("drops obsolete deferred samples before a later turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.usageAvailable = true;
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "deferred-a", "first"));

    await observed.promise;
    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [],
      isTerminal: true,
    });
    await scheduler.flush(5_000);
    await scheduler.flush(250);
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === firstTurnId &&
        event.state === "completed",
    );

    const afterFirstStateLookups = session.stateLookups;
    const afterFirstStatsLookups = session.statsLookups;
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "deferred-b", "second"));
    expect(session.stateLookups).toBe(afterFirstStateLookups + 1);
    expect(session.statsLookups).toBe(afterFirstStatsLookups + 1);
    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: true,
    });
    await scheduler.flush(5_000);
    await scheduler.flush(250);
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === secondTurnId &&
        event.state === "completed",
    );

    const afterSecondStateLookups = session.stateLookups;
    const afterSecondStatsLookups = session.statsLookups;
    const thirdTurnId = turnIdFrom(await startPrompt(connection, events, "deferred-c", "third"));
    expect(session.stateLookups).toBe(afterSecondStateLookups + 1);
    expect(session.statsLookups).toBe(afterSecondStatsLookups + 1);
    session.contextTokens = 333;
    state.resolve();
    stats.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.usage" &&
        event.turnId === thirdTurnId &&
        event.usage.contextWindowUsedTokens === 333,
    );
    expect(session.stateLookups).toBe(afterSecondStateLookups + 1);
    expect(session.statsLookups).toBe(afterSecondStatsLookups + 1);

    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-3",
      messages: [],
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === thirdTurnId &&
        event.state === "completed",
    );
    await connection.close();
  });
  test("uses a post-agent-end state sample across split state and stats responses", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.usageAvailable = true;
    session.captureUsageOnRequest = true;
    session.isStreaming = true;
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    const turnId = turnIdFrom(await startPrompt(connection, events, "post-agent-end", "work"));
    await observed.promise;
    session.isStreaming = false;
    session.contextTokens = 444;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.stateLookups).toBe(4);
    expect(session.statsLookups).toBe(1);

    state.resolve();
    await Promise.resolve();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(session.stateLookups).toBe(5);
    expect(session.statsLookups).toBe(2);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    stats.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("keeps a long manual compaction loading and reuses its operation id", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "manual-compact", "/compact focus on decisions"),
    );
    await events.waitFor((event) => event.type === "session.usage" && event.turnId === turnId);
    await scheduler.flush(1_000);

    const loading = events.filter(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    );
    expect(loading).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    session.isCompacting = false;
    compact.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    const operations = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    expect(operations).toHaveLength(2);
    if (
      operations[0]?.type !== "timeline.item" ||
      operations[0].item.type !== "compaction" ||
      operations[1]?.type !== "timeline.item" ||
      operations[1].item.type !== "compaction"
    ) {
      throw new Error("Expected compaction operation updates");
    }
    expect([operations[0].item.status, operations[1].item.status]).toEqual([
      "loading",
      "completed",
    ]);
    expect(operations[1].item.id).toBe(operations[0].item.id);
    expect(session.compactions).toEqual(["focus on decisions"]);
    expect(session.prompts).toEqual([]);
    await connection.close();
  });

  test("keeps a real RPC compaction pending past ordinary request timeout", async () => {
    const scheduler = new ManualScheduler();
    const compactObserved = Promise.withResolvers<void>();
    const usageRequestsObserved = Promise.withResolvers<void>();
    const ordinaryRequestsTimedOut = Promise.withResolvers<void>();
    scheduler.onSchedule = (delayMs) => {
      if (delayMs === 1_000) ordinaryRequestsTimedOut.resolve();
    };
    let child: ProviderRpcChild | undefined;
    let compactRequestId: string | undefined;
    let compactRequests = 0;
    let holdUsageRequests = false;
    let heldStateRequests = 0;
    let heldStatsRequests = 0;
    const respond = (command: Record<string, unknown>, data: unknown) => {
      if (!child) throw new Error("OMP RPC child is unavailable");
      child.write({ type: "response", id: command.id, success: true, data });
    };
    const runtime = new OmpRpcRuntime({
      requestTimeoutMs: 10,
      spawnProcess() {
        const spawned = new ProviderRpcChild((command) => {
          const type = command.type;
          if (type === "negotiate_protocol") {
            respond(command, { protocolVersion: 2 });
            return;
          }
          if (type === "get_available_models") {
            respond(command, { models: [MODEL] });
          } else if (type === "get_available_commands") {
            respond(command, { commands: [{ name: "compact" }] });
          } else if (type === "get_state") {
            if (holdUsageRequests) {
              heldStateRequests += 1;
              if (heldStatsRequests > 0) usageRequestsObserved.resolve();
              return;
            }
            respond(command, {
              model: MODEL,
              thinkingLevel: "medium",
              isStreaming: false,
              isCompacting: false,
              sessionId: "native-session",
              contextUsage: { tokens: 400, contextWindow: 200_000, percent: 0.2 },
            });
          } else if (type === "get_session_stats") {
            if (holdUsageRequests) {
              heldStatsRequests += 1;
              if (heldStateRequests > 0) usageRequestsObserved.resolve();
              return;
            }
            respond(command, {
              tokens: { input: 350, output: 50, cacheRead: 25 },
              cost: 0.4,
              contextUsage: { tokens: 400, contextWindow: 200_000, percent: 0.2 },
            });
          } else if (type === "compact") {
            compactRequests += 1;
            compactRequestId = String(command.id);
            holdUsageRequests = true;
            compactObserved.resolve();
          }
        });
        child = spawned;
        queueMicrotask(() =>
          spawned.write({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
        );
        return spawned.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({
      runtime,
      timelineScheduler: scheduler,
      environment: TEST_RUNTIME_ENV,
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.configure"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(
      connection,
      events,
      "open-1",
      "session-1",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "real-timeout-compact", "/compact focus"),
    );
    await compactObserved.promise;
    await usageRequestsObserved.promise;
    await ordinaryRequestsTimedOut.promise;

    expect(compactRequests).toBe(1);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    holdUsageRequests = false;
    if (!compactRequestId || !child) throw new Error("Expected compact request");
    child.write({
      type: "response",
      id: compactRequestId,
      success: true,
      data: { tokensBefore: 1_000 },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );

    const operations = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    expect(operations).toHaveLength(2);
    if (
      operations[0]?.type !== "timeline.item" ||
      operations[0].item.type !== "compaction" ||
      operations[1]?.type !== "timeline.item" ||
      operations[1].item.type !== "compaction"
    ) {
      throw new Error("Expected compaction operation updates");
    }
    expect([operations[0].item.status, operations[1].item.status]).toEqual([
      "loading",
      "completed",
    ]);
    expect(operations[1].item.id).toBe(operations[0].item.id);
    expect(compactRequests).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "completed" })]);
    await connection.close();
  });

  test("rejects steering while manual compaction is unresolved", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "compact-steer", "/compact"));

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-during-compact",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "too late" }] },
      },
    });
    const rejected = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "steer-during-compact",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        result: {
          type: "failed",
          error: { message: "There is no active OMP turn to steer" },
        },
      }),
    );
    expect(session.steers).toEqual([]);

    session.isCompacting = false;
    compact.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.close();
  });

  test("terminalizes a fast manual compaction even when polling misses the running state", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.isCompacting = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "fast-compact", "/compact"));

    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    const operations = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    expect(operations).toHaveLength(2);
    if (
      operations[0]?.type !== "timeline.item" ||
      operations[0].item.type !== "compaction" ||
      operations[1]?.type !== "timeline.item" ||
      operations[1].item.type !== "compaction"
    ) {
      throw new Error("Expected compaction operation updates");
    }
    expect(operations[1].item.id).toBe(operations[0].item.id);
    expect(session.compactions).toEqual([undefined]);
    await connection.close();
  });

  test("keeps a lost compaction waiter running until OMP confirms failure", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.compactError = new Error("credential-secret native failure");
    session.stateError = new Error("OMP RPC request timed out");
    const turnId = turnIdFrom(await startPrompt(connection, events, "lost-compact", "/compact"));

    await scheduler.flush(1_000);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    expect(
      events.filter((event) => event.type === "timeline.item" && event.item.type === "compaction"),
    ).toHaveLength(1);

    compact.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(
      expect.objectContaining({ error: { message: "OMP compaction failed" } }),
    );
    expect(JSON.stringify(events)).not.toContain("credential-secret");
    const loading = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    );
    if (loading?.type !== "timeline.item") throw new Error("Expected compaction loading update");
    expect(
      events.find(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "notification" &&
          event.item.id === loading.item.id,
      ),
    ).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ level: "error", message: "OMP compaction failed" }),
      }),
    );
    await connection.close();
  });

  test("ignores a spoofed auto end while a manual compact waiter is unresolved", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "wedged-compact", "/compact"));
    const loading = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    );
    if (loading?.type !== "timeline.item") throw new Error("Expected compaction loading update");

    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { tokensBefore: 1_000 },
      aborted: false,
      willRetry: false,
    });
    expect(
      events.filter((event) => event.type === "timeline.item" && event.item.id === loading.item.id),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    await scheduler.flush(300_000);
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "canceled",
    );
    expect(
      events.find(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "notification" &&
          event.item.id === loading.item.id,
      ),
    ).toEqual(expect.objectContaining({ item: expect.objectContaining({ level: "info" }) }));
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);
    compact.resolve();
    await connection.close();
  });

  test("ignores stale agent-end until manual compaction settles", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "stale-agent-end", "/compact"));

    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "stale failure" }],
      isTerminal: true,
    });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    const rejected = await startPrompt(connection, events, "blocked-during-compact", "next");
    expect(rejected).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );

    session.isCompacting = false;
    compact.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);
    expect(session.compactions).toEqual([undefined]);
    await connection.close();
  });

  test("interrupts a wedged manual compaction without waiting for its RPC", async () => {
    const runtime = new FakeOmpRuntime();
    const compact = Promise.withResolvers<void>();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.compactGate = compact.promise;
    session.isCompacting = true;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "interrupt-compact", "/compact"),
    );
    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-compact",
      sessionId: "session-1",
    });

    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "canceled",
    );
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "interrupt-compact",
    );
    expect(session.aborts).toBe(0);
    compact.resolve();
    await connection.close();
  });

  test("ignores agent_end while native state remains active", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("OMP RPC request timed out");
    const turnId = turnIdFrom(await startPrompt(connection, events, "active-state", "work"));
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(250);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    session.stateError = null;
    session.isStreaming = true;
    await scheduler.flush(1_000);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    expect(session.closes).toBe(0);

    session.isStreaming = false;
    await expect(finishTurn(events, session, turnId)).resolves.toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    await connection.close();
  });

  test("clears stale compaction state before a later operation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "stale-compact", "work"));
    first.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    first.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === firstTurnId &&
        event.state === "completed",
    );

    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "next-compact", "more"));
    first.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    const loading = events.filter(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    );
    expect(loading).toHaveLength(2);
    if (
      loading[0]?.type !== "timeline.item" ||
      loading[0].item.type !== "compaction" ||
      loading[1]?.type !== "timeline.item" ||
      loading[1].item.type !== "compaction"
    ) {
      throw new Error("Expected compaction loading updates");
    }
    expect(loading[1].item.id).not.toBe(loading[0].item.id);
    first.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { tokensBefore: 900 },
      aborted: false,
      willRetry: false,
    });
    establishTerminalOwnership(first);
    first.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === secondTurnId &&
        event.state === "completed",
    );
    await connection.close();
  });

  test("publishes a terminal turn after the final usage snapshot deadline", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    const turnId = turnIdFrom(await startPrompt(connection, events, "bounded-final", "work"));
    await observed.promise;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    await scheduler.flush(5_000);
    await scheduler.flush(250);
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    state.resolve();
    stats.resolve();
    await connection.close();
  });

  test("interrupt overrides a turn deferred on final usage", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "interrupt-final", "work"));
    await events.waitFor((event) => event.type === "session.usage" && event.turnId === turnId);
    await Promise.resolve();
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    const [completion] = scheduler.runPending(5_000);
    if (!completion) throw new Error("Expected local completion timer");
    await observed.promise;

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-final",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "canceled",
    );
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "interrupt-final",
    );
    state.resolve();
    stats.resolve();
    await completion;
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "canceled" })]);
    await connection.close();
  });

  test("lets close override a deferred final usage snapshot", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "close-race", "work"));
    await events.waitFor((event) => event.type === "session.usage" && event.turnId === turnId);
    await Promise.resolve();
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await observed.promise;

    const closing = connection.close();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "canceled",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    state.resolve();
    stats.resolve();
    await closing;
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    const closeLoading = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    if (closeLoading?.type !== "timeline.item")
      throw new Error("Expected compaction loading update");
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "notification" &&
          event.item.id === closeLoading.item.id,
      ),
    ).toBe(true);
  });

  test("lets runtime death override a deferred final usage snapshot", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "death-race", "work"));
    await events.waitFor((event) => event.type === "session.usage" && event.turnId === turnId);
    await Promise.resolve();
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await observed.promise;
    session.emit({ type: "process_exit", error: "OMP exited" });

    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    state.resolve();
    stats.resolve();
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    const deathLoading = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "compaction",
    );
    if (deathLoading?.type !== "timeline.item")
      throw new Error("Expected compaction loading update");
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "notification" &&
          event.item.id === deathLoading.item.id,
      ),
    ).toBe(true);
    await connection.close();
  });

  test("coalesces refreshes and starts one post-agent sample", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.usageAvailable = true;
    const state = Promise.withResolvers<void>();
    const stats = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.statsGate = stats.promise;
    session.stateObserved = observed.resolve;
    const turnId = turnIdFrom(await startPrompt(connection, events, "single-flight", "work"));
    await observed.promise;
    const stateLookups = session.stateLookups;
    const statsLookups = session.statsLookups;

    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    for (let index = 0; index < 5; index += 1) {
      session.emit({
        type: "auto_compaction_end",
        action: "context-full",
        result: { tokensBefore: 1_000 },
        aborted: false,
        willRetry: false,
      });
    }
    expect(session.stateLookups).toBe(stateLookups);
    expect(session.statsLookups).toBe(statsLookups);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(100);
    await scheduler.flush(250);
    expect(session.stateLookups).toBe(stateLookups + 1);
    expect(session.statsLookups).toBe(statsLookups);
    expect(session.maxActiveStateLookups).toBe(2);
    expect(session.maxActiveStatsLookups).toBe(1);

    session.emit({ type: "process_exit", error: "OMP exited" });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    state.resolve();
    stats.resolve();
    await connection.close();
  });

  test("drops cached usage when recovering a runtime", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    first.usageAvailable = true;
    const firstTurnId = turnIdFrom(
      await startPrompt(connection, events, "usage-before-death", "work"),
    );
    await events.waitFor((event) => event.type === "session.usage" && event.turnId === firstTurnId);
    first.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === firstTurnId &&
        event.state === "completed",
    );
    first.emit({ type: "process_exit", error: "OMP exited" });

    const secondTurnId = turnIdFrom(
      await startPrompt(connection, events, "usage-after-death", "more"),
    );
    const recovered = sessionAt(runtime, 1);
    recovered.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    const loading = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    );
    if (loading?.type !== "timeline.item" || loading.item.type !== "compaction") {
      throw new Error("Expected recovered compaction operation");
    }
    expect(loading.item.preTokens).toBeUndefined();
    recovered.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { tokensBefore: 500 },
      aborted: false,
      willRetry: false,
    });
    recovered.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === secondTurnId &&
        event.state === "completed",
    );
    await connection.close();
  });
});
