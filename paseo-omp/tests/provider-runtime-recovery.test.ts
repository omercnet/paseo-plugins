import { describe, expect, test } from "vitest";
import {
  ALTERNATE_MODEL,
  ALTERNATE_MODEL_PUBLIC_ID,
  createHarness,
  FakeOmpRuntime,
  finishTurn,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("recovers a dead idle runtime by resuming the same native session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);

    first.emit({ type: "process_exit", error: "OMP exited between turns" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    const result = await startPrompt(connection, events, "recovered-1", "continue");
    const turnId = turnIdFrom(result);
    const recovered = sessionAt(runtime, 1);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        model: "anthropic/claude-sonnet-4-5",
        mode: "full",
        thinkingOption: "medium",
        systemPrompt: "Be precise",
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(await finishTurn(events, recovered, turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    await connection.close();
  });
  test("recovers with the native model and thinking selected at open", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "open-default-config",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "open-default-config",
    );
    const baseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    const turnId = turnIdFrom(await startPrompt(connection, events, "observed-config", "continue"));
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: "openai/gpt-5.4",
        thinkingOption: "high",
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(events.slice(baseline)).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("reconciles configuration events during recovered host-tool binding", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const initial = sessionAt(runtime);
    const bindGate = Promise.withResolvers<void>();
    const bindObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (recovered) => {
      recovered.hostToolBindGate = bindGate.promise;
      recovered.hostToolBindObserved = bindObserved.resolve;
    };

    initial.emit({ type: "process_exit", error: "OMP exited between turns" });
    const prompt = startPrompt(connection, events, "recovery-bind-config-race", "continue");
    await bindObserved.promise;
    const recovered = sessionAt(runtime, 1);
    recovered.currentModel = ALTERNATE_MODEL;
    recovered.thinkingLevel = "high";
    recovered.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    recovered.hostToolBindGate = null;
    bindGate.resolve();

    const turnId = turnIdFrom(await prompt);
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, recovered, turnId);
    await connection.close();
  });
  test("reconciles configuration events during recovered state reads", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const initial = sessionAt(runtime);
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (recovered) => {
      recovered.stateGate = stateGate.promise;
      recovered.stateObserved = stateObserved.resolve;
    };

    initial.emit({ type: "process_exit", error: "OMP exited between turns" });
    const firstPrompt = startPrompt(connection, events, "recovery-config-race", "continue");
    await stateObserved.promise;
    const recovered = sessionAt(runtime, 1);
    recovered.currentModel = ALTERNATE_MODEL;
    recovered.thinkingLevel = "high";
    recovered.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    recovered.stateGate = null;
    stateGate.resolve();

    const firstTurnId = turnIdFrom(await firstPrompt);
    expect(recovered.stateLookups).toBe(3);
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, recovered, firstTurnId);

    runtime.sessionCreated = null;
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    recovered.emit({ type: "process_exit", error: "OMP exited after recovered fallback" });
    const secondTurnId = turnIdFrom(
      await startPrompt(connection, events, "recovery-config-race-again", "continue"),
    );
    expect(runtime.starts[2]).toEqual(
      expect.objectContaining({
        model: "openai/gpt-5.4",
        thinkingOption: "high",
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
        systemPrompt: "Be precise",
      }),
    );
    await finishTurn(events, sessionAt(runtime, 2), secondTurnId);
    await connection.close();
  });
  test("rejects recovery when runtime falls back to another advertised model", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const baseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "fallback-recovery", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "OMP session recovery failed" },
        }),
      }),
    );
    expect(sessionAt(runtime, 1).closes).toBe(1);
    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    await connection.close();
  });

  test("ignores stale terminal events from a dead runtime generation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const staleListener = [...first.listeners][0];
    if (!staleListener) throw new Error("expected native event listener");

    first.emit({ type: "process_exit", error: "OMP killed by SIGKILL" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    const result = await startPrompt(connection, events, "generation-2", "continue");
    const turnId = turnIdFrom(result);

    staleListener({ type: "agent_end", messages: [], isTerminal: true });
    staleListener({ type: "turn_end" });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);

    await finishTurn(events, sessionAt(runtime, 1), turnId);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });
});
