import { describe, expect, onTestFinished, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import type { OmpMessage } from "../server/provider/omp-rpc-protocol";
import { createOmpProvider } from "../server/provider/registration";
import { OmpCleanupFailure } from "../server/provider/security";
import {
  ALTERNATE_MODEL,
  createHarness,
  EventLog,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishLegacyTurn,
  finishTurn,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("completes three sequential prompts through ordered unkeyed terminal evidence", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const clientMessageId = `legacy-sequential-${sequence}`;
      const text = `ordinary prompt ${sequence}`;
      const turnId = turnIdFrom(await startPrompt(connection, events, clientMessageId, text));
      await expect(
        finishLegacyTurn(events, session, turnId, clientMessageId, text, sequence),
      ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    }

    expect(session.promptCount).toBe(3);
    expect(session.closes).toBe(0);
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("settles the newest repeated ambiguous terminal", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "ambiguous-repeat-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "ambiguous-repeat-second", "second"),
    );
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(2_000);

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "failed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("lets an exact terminal retire an in-flight ambiguity probe", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "ambiguity-probe-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "ambiguity-probe-second", "second"),
    );
    const state = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.stateObserved = observed.resolve;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    scheduler.runPending(2_000);
    await observed.promise;

    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: true,
    });
    state.resolve();
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toEqual([]);
    await connection.close();
  });

  test("does not backdate a later repeated user echo", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "sequence-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "sequence-second", "repeat"));
    session.branchMessages = [];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.emit({
      type: "message_end",
      message: { role: "assistant", entryId: "sequence-assistant", content: "current" },
    });
    session.branchMessages.push({ entryId: "sequence-user", text: "repeat" });
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "sequence-second",
    );
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "stale" }],
      isTerminal: true,
    });
    await scheduler.flush(2_000);

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "failed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("keeps an interrupted legacy terminal canceled", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "interrupt-legacy-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "interrupt-legacy-second", "second"),
    );
    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-legacy",
      sessionId: "session-1",
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "canceled" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });
  test("fails only the legacy turn when terminal history is unavailable", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "legacy-history-first", "first")),
    );

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "legacy-history-second", "second"),
    );
    session.branchMessages.push({ entryId: "legacy-history-user", text: "second" });
    session.emit({ type: "message_end", message: { role: "user", content: "second" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "legacy-history-second",
    );
    session.historyError = new Error("history unavailable");
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: "partial",
        entryId: "legacy-history-assistant",
        stopReason: "stop",
      },
    });
    session.emit({ type: "agent_end", messageCount: 3, messages: [], isTerminal: true });

    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("outcome is unknown") }),
      }),
    );
    expect(session.historyRequests).toBe(1);
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("rejects delayed prior-turn activity after true and false B acknowledgements", async () => {
    for (const acknowledgement of [true, false]) {
      const { connection, events, runtime } = await createHarness();
      await openSession(connection, events);
      const session = sessionAt(runtime);
      const firstTurn = turnIdFrom(
        await startPrompt(connection, events, "terminal-owner-a", "first"),
      );
      await finishTurn(events, session, firstTurn);

      session.promptAgentInvoked = acknowledgement;
      const secondTurn = turnIdFrom(
        await startPrompt(connection, events, "terminal-owner-b", "second"),
      );
      session.emit({ type: "turn_end" });
      session.emit({
        type: "message_end",
        message: { role: "assistant", responseId: "stale-a", content: "late first output" },
      });
      session.emit({ type: "agent_end", messages: [], isTerminal: true });
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === secondTurn &&
            event.state !== "started",
        ),
      ).toHaveLength(0);

      await expect(finishTurn(events, session, secondTurn)).resolves.toEqual(
        expect.objectContaining({ state: "completed" }),
      );
      await connection.close();
    }
  });

  test("does not finish from idle state sampled before branch ownership", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "branch-race-a", "first"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "first", entryId: "branch-race-first" },
    });
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    const secondTurn = turnIdFrom(await startPrompt(connection, events, "branch-race-b", "second"));
    const branch = Promise.withResolvers<void>();
    session.getBranchMessages = async () => {
      await branch.promise;
      return session.branchMessages;
    };
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.isStreaming = true;
    session.branchMessages = [{ entryId: "branch-race-second", text: "second" }];
    branch.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      events.filter((event) => event.type === "session.turn" && event.turnId === secondTurn),
    ).toEqual([expect.objectContaining({ state: "started" })]);
    session.isStreaming = false;
    await finishTurn(events, session, secondTurn);
    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "completed" }));
  });

  test("fails only the turn when an unkeyed terminal has no current evidence", async () => {
    const failures: OmpOperationalFailure[] = [];
    const { connection, events, runtime, scheduler } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      (failure) => failures.push(failure),
    );
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "branch-hang-a", "first"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "first", entryId: "branch-hang-first" },
    });
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    const secondTurn = turnIdFrom(await startPrompt(connection, events, "branch-hang-b", "second"));
    const branch = Promise.withResolvers<Array<{ entryId: string; text: string }>>();
    session.getBranchMessages = () => branch.promise;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.flush(2_000);
    await scheduler.flush(5_000);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
    );
    branch.resolve([{ entryId: "branch-hang-second", text: "second" }]);

    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP unkeyed agent_end could not be correlated to the current prompt" },
      }),
    );
    expect(session.closes).toBe(0);
    expect(failures).toEqual([{ category: "terminal-outcome", stage: "unresolved" }]);
  });

  test("rejects ambiguous branch ownership for repeated identical prompts", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(
      await startPrompt(connection, events, "branch-ambiguous-a", "repeat"),
    );
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "branch-ambiguous-first" },
    });
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    const secondTurn = turnIdFrom(
      await startPrompt(connection, events, "branch-ambiguous-b", "repeat"),
    );
    session.branchMessages = [
      { entryId: "branch-ambiguous-first", text: "repeat" },
      { entryId: "branch-ambiguous-unknown", text: "repeat" },
      { entryId: "branch-ambiguous-second", text: "repeat" },
    ];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.flush(2_000);

    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "failed" }));
    expect(session.closes).toBe(0);
  });
  test.each([false, true])(
    "does not let branch acceptance authorize a stale terminal (live echo: %s)",
    async (liveEcho) => {
      const { connection, events, runtime } = await createHarness();
      onTestFinished(() => connection.close());
      await openSession(connection, events);
      const session = sessionAt(runtime);
      session.promptAgentInvoked = undefined;
      const firstTurn = turnIdFrom(
        await startPrompt(connection, events, "omp-18-2-first", "repeat"),
      );
      session.branchMessages = [{ entryId: "entry-first", text: "repeat" }];
      session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
      await finishTurn(events, session, firstTurn);

      const secondTurn = turnIdFrom(
        await startPrompt(connection, events, "omp-18-2-second", "repeat"),
      );
      session.branchMessages.push({ entryId: "entry-second", text: "repeat" });
      session.emit({ type: "agent_start" });
      if (liveEcho)
        session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
      session.emit({ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      session.emit({
        type: "agent_end",
        messages: [{ role: "assistant", content: "old error", stopReason: "error" }],
        isTerminal: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        events.filter((event) => event.type === "session.turn" && event.turnId === secondTurn),
      ).toEqual([expect.objectContaining({ state: "started" })]);

      expect(await finishTurn(events, session, secondTurn)).toEqual(
        expect.objectContaining({ state: "completed" }),
      );
      expect(
        events.flatMap((event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "omp-18-2-second"
            ? [event.item]
            : [],
        ),
      ).toHaveLength(1);
    },
  );

  test("does not authorize an in-flight stale terminal with a later prompt result", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "inflight-a", "first")),
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "inflight-b", "second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const state = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    establishTerminalOwnership(session);
    state.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      events.filter((event) => event.type === "session.turn" && event.turnId === turnId),
    ).toEqual([expect.objectContaining({ state: "started" })]);
    expect(await finishTurn(events, session, turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
  });

  test("accepts only a request-matched agent_end on a later turn", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await finishTurn(
      events,
      session,
      turnIdFrom(await startPrompt(connection, events, "correlated-a", "first")),
    );
    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "correlated-b", "second"));

    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [{ role: "assistant", content: "stale", stopReason: "error" }],
      isTerminal: true,
    });
    expect(
      events.filter((event) => event.type === "session.turn" && event.turnId === turnId),
    ).toEqual([expect.objectContaining({ state: "started" })]);

    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: false,
    });
    expect(
      events.filter((event) => event.type === "session.turn" && event.turnId === turnId),
    ).toEqual([expect.objectContaining({ state: "started" })]);

    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [{ role: "assistant", content: "current", stopReason: "stop" }],
      isTerminal: true,
    });
    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.closes).toBe(0);

    const nextTurn = turnIdFrom(await startPrompt(connection, events, "correlated-c", "continue"));
    expect(runtime.starts).toHaveLength(1);
    await finishTurn(events, session, nextTurn);
  });

  test("does not reuse assistant evidence across request-matched native runs", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(
      await startPrompt(connection, events, "scoped-evidence-a", "first"),
    );
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "scoped-evidence-b", "second"));
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: "earlier success", stopReason: "stop" },
    });
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messages: [],
      isTerminal: false,
    });
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-2",
      messageCount: 1,
      messages: [],
      isTerminal: true,
    });

    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "failed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test.each([
    "unavailable",
    "too many entries",
    "too many bytes",
    "duplicate IDs",
    "different text",
  ])("fails closed on %s branch history", async (history) => {
    const { connection, events, runtime, scheduler } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "bounded-a", "first"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "first", entryId: "bounded-first" },
    });
    await finishTurn(events, session, firstTurn);
    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "bounded-b", "second"));
    session.branchMessages = [{ entryId: "bounded-second", text: "second" }];
    if (history === "unavailable") session.branchMessagesError = new Error("unavailable");
    if (history === "too many entries")
      session.branchMessages.push(
        ...Array.from({ length: 1_024 }, (_, index) => ({
          entryId: `bounded-${index}`,
          text: "other",
        })),
      );
    if (history === "too many bytes")
      session.branchMessages.push({ entryId: "oversized", text: "x".repeat(4 * 1024 * 1024) });
    if (history === "duplicate IDs")
      session.branchMessages.push({ entryId: "bounded-second", text: "other" });
    if (history === "different text")
      session.branchMessages[0] = { entryId: "bounded-second", text: "second " };
    session.emit({ type: "message_end", message: { role: "user", content: "second" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "bounded-b",
      ),
    ).toEqual([]);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.flush(2_000);
    expect(
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual(expect.objectContaining({ state: "failed" }));
  });

  test.each(["missing IDs", "evicted IDs", "compacted context"])(
    "rebuilds the resumed branch watermark with %s",
    async (history) => {
      const runtime = new FakeOmpRuntime();
      runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
      runtime.nextHistoryMessages = [
        { role: "user", content: "repeat" },
        { role: "assistant", responseId: "history-response", content: "old response" },
      ];
      if (history === "evicted IDs") {
        runtime.nextHistoryMessages = [
          { role: "user", content: "repeat", entryId: "entry-history" },
          ...Array.from(
            { length: 1_024 },
            (_, index): OmpMessage => ({
              role: "assistant",
              content: "old response",
              entryId: `old-assistant-${index}`,
            }),
          ),
        ];
      } else if (history === "compacted context") {
        runtime.nextHistoryMessages = [{ role: "assistant", content: "summary" }];
      }
      runtime.nextBranchMessages = [{ entryId: "entry-history", text: "repeat" }];
      const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
        "prompt.message",
        "session.persistence",
      ]);
      onTestFinished(() => connection.close());
      await connection.send({
        type: "session.open",
        requestId: "resume-ownership",
        sessionId: "resumed-ownership",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          model: MODEL_PUBLIC_ID,
          mode: "full",
          thinkingOption: "medium",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === "resume-ownership",
      );
      const session = sessionAt(runtime);
      session.promptAgentInvoked = undefined;

      const firstTurn = turnIdFrom(
        await startPrompt(connection, events, "resumed-first", "warm up", "resumed-ownership"),
      );
      session.branchMessages.push({ entryId: "entry-warm-up", text: "warm up" });
      session.emit({
        type: "message_end",
        message: { role: "user", content: "warm up", entryId: "entry-warm-up" },
      });
      session.emit({ type: "agent_end", messages: [], isTerminal: true });
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === firstTurn &&
          event.state === "completed",
      );

      const secondTurn = turnIdFrom(
        await startPrompt(connection, events, "resumed-second", "repeat", "resumed-ownership"),
      );
      session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        events.filter(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "user_message" &&
            event.item.clientMessageId === "resumed-second",
        ),
      ).toEqual([]);
      session.branchMessages.push({ entryId: "entry-current", text: "repeat" });
      session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
      await events.waitFor(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "resumed-second",
      );
      establishTerminalOwnership(session);
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: "new response",
          entryId: "entry-current-assistant",
        },
      });
      session.emit({
        type: "agent_end",
        messages: [{ role: "assistant", content: "new response" }],
        isTerminal: true,
      });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      );

      expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
      expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
      await connection.close();
    },
  );

  test("does not treat a buffered prompt result as unkeyed terminal proof", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-a", "first"),
    );
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = true;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: true }];
    const secondTurn = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-b", "/mcp list"),
    );
    session.promptEvents = [];
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await scheduler.flush(2_000);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP unkeyed agent_end could not be correlated to the current prompt" },
      }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    expect(session.closes).toBe(0);

    const thirdTurn = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-c", "continue"),
    );
    await finishTurn(events, session, thirdTurn);
    await connection.close();
  });

  test("does not grant terminal ownership to a mismatched buffered prompt result", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = true;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-stale", agentInvoked: true }];
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-mismatch", "work"),
    );
    session.promptEvents = [];
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);

    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("does not derive terminal ownership from a busy stale agent_end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "busy-owner-a", "first"));
    await finishTurn(events, session, firstTurn);

    const secondTurn = turnIdFrom(await startPrompt(connection, events, "busy-owner-b", "second"));
    session.isStreaming = true;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    session.isStreaming = false;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      ),
    ).toHaveLength(0);

    session.branchMessages.push({ entryId: "busy-current-user", text: "second" });
    session.emit({ type: "message_end", message: { role: "user", content: "second" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "busy-owner-b",
    );
    const assistant = {
      role: "assistant" as const,
      content: "current response",
      entryId: "busy-current-assistant",
      stopReason: "stop",
    };
    session.emit({ type: "message_end", message: assistant });
    session.emit({ type: "agent_end", messages: [assistant], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("fails an EPIPE turn once without terminalizing the host session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "epipe-1", "work"));

    sessionAt(runtime).emit({ type: "process_exit", error: "OMP RPC stdin write failed: EPIPE" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });

  test("fails a turn when terminal state confirmation times out", async () => {
    const failures: OmpOperationalFailure[] = [];
    const { connection, events, runtime, scheduler } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      (failure) => failures.push(failure),
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const staleListener = [...session.listeners][0];
    if (!staleListener) throw new Error("expected native event listener");
    const branch = Promise.withResolvers<void>();
    const state = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.stateGate = state.promise;
    const turnId = turnIdFrom(await startPrompt(connection, events, "stuck-state", "work"));

    session.emit({ type: "message_end", message: { role: "user", content: "work" } });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end state could not be confirmed" },
      }),
    );
    expect(session.closes).toBe(1);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    expect(failures).toEqual([{ category: "terminal-outcome", stage: "unresolved" }]);

    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-stuck", "continue"),
    );
    staleListener({ type: "agent_end", messages: [], isTerminal: true });
    staleListener({ type: "turn_end" });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoveredTurn &&
          event.state !== "started",
      ),
    ).toHaveLength(0);
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    state.resolve();
    await connection.close();
  });

  test("fails a turn when terminal state confirmation is unavailable", async () => {
    const failures: OmpOperationalFailure[] = [];
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      (failure) => failures.push(failure),
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branch = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.stateError = new Error("runtime state unavailable");
    const turnId = turnIdFrom(await startPrompt(connection, events, "unavailable-state", "work"));

    session.emit({ type: "message_end", message: { role: "user", content: "work" } });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end state could not be confirmed" },
      }),
    );
    expect(session.closes).toBe(1);
    expect(failures).toEqual([{ category: "terminal-outcome", stage: "unresolved" }]);
    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-unavailable", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ noSession: false, resumeSessionId: NATIVE_SESSION_ID }),
    );
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    await connection.close();
  });

  test("discards an agent_end while the native runtime remains active", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branch = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.isStreaming = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "active-state", "work"));

    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "active-user" },
    });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);

    session.isStreaming = false;
    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "user_message"),
    ).toBe(true);
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("rejects recovery for an ephemeral session without a native transcript handle", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push("");
    const { connection, events } = await createHarness(runtime);
    await openSession(
      connection,
      events,
      "open-ephemeral-missing-handle",
      "session-1",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "missing-handle", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: {
          type: "failed",
          error: {
            message: "OMP cannot recover a non-persisted session; create a new session instead",
          },
        },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("fails closed when disposing the old runtime fails", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("native close failed");
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "cleanup-failure", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close().catch(() => undefined);
  });
  test("retains failed fresh replacement cleanup until explicit close reports it", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextCloseError = new Error("candidate close failed");
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const replacement = await startPrompt(connection, events, "wrong-candidate", "continue");
    expect(replacement).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(2);
    const blocked = await startPrompt(connection, events, "blocked-candidate", "continue");
    expect(blocked).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(2);

    await connection.send({
      type: "session.close",
      requestId: "candidate-close",
      sessionId: "session-1",
    });
    const closeFailure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "candidate-close",
    );
    expect(closeFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    const closed = await events.waitFor((event) => event.type === "session.closed");
    expect(closed).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "candidate-reopen",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "candidate-reopen",
    );
    expect(runtime.starts).toHaveLength(2);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("releases recovery cleanup quarantine after verification", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const cleanup = Promise.withResolvers<void>();
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    await first.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-open",
      sessionId: "recovery-cleanup-owner",
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
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "recovery-cleanup-open",
    );

    runtime.nextStartError = new OmpCleanupFailure(
      "recovery startup cleanup failed",
      cleanup.promise,
    );
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    for (const clientMessageId of ["failed-recovery-start", "blocked-recovery-retry"]) {
      const result = await startPrompt(
        first.connection,
        first.events,
        clientMessageId,
        "continue",
        "recovery-cleanup-owner",
      );
      expect(result).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            type: "failed",
            error: expect.objectContaining({ message: "OMP session recovery failed" }),
          }),
        }),
      );
    }
    expect(runtime.starts).toHaveLength(2);
    await first.connection.send({
      type: "session.close",
      requestId: "recovery-cleanup-close",
      sessionId: "recovery-cleanup-owner",
    });
    await first.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-cleanup-close",
    );

    await second.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-blocked",
      sessionId: "recovery-cleanup-successor",
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
    const blocked = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-cleanup-blocked",
    );
    expect(blocked).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );

    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    await expect(first.connection.close()).resolves.toBeUndefined();
    await second.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-released",
      sessionId: "recovery-cleanup-successor",
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
      (event) => event.type === "session.ready" && event.requestId === "recovery-cleanup-released",
    );
    expect(runtime.starts).toHaveLength(3);
    await second.connection.close();
  });

  test("close drains replacement cleanup created by a concurrent recovery", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const bindStarted = Promise.withResolvers<void>();
    const releaseBind = Promise.withResolvers<void>();
    runtime.nextCloseError = new Error("replacement close failed");
    runtime.sessionCreated = (session) => {
      if (runtime.sessions.length !== 2) return;
      session.hostToolBindObserved = bindStarted.resolve;
      session.hostToolBindGate = releaseBind.promise;
    };
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "recovery-close-race",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    await bindStarted.promise;

    const closeOutcome = events.waitFor(
      (event) =>
        (event.type === "request.completed" || event.type === "request.failed") &&
        event.requestId === "recovery-close",
    );
    await connection.send({
      type: "session.close",
      requestId: "recovery-close",
      sessionId: "session-1",
    });
    releaseBind.resolve();

    await expect(closeOutcome).resolves.toEqual(
      expect.objectContaining({
        type: "request.failed",
        error: { message: "OMP session close failed" },
      }),
    );
    expect(sessionAt(runtime, 1).closes).toBe(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });
});
