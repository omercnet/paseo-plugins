import { describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import { OmpCleanupFailure } from "../server/provider/security";
import {
  createHarness,
  EventLog,
  FakeOmpRuntime,
  finishTurn,
  MODEL_PUBLIC_ID,
  openSession,
  ProviderRpcChild,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("interrupts and emits one terminal turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const promptResult = await startPrompt(connection, events);
    const turnId = turnIdFrom(promptResult);
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-1",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "interrupt-1",
    );
    const terminal = await finishTurn(events, session, turnId);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    expect(session.aborts).toBe(1);
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("does not start a later turn while an earlier abort is unsettled", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = observed.resolve;
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "abort-first", "first"));

    await connection.send({
      type: "session.interrupt",
      requestId: "abort-first",
      sessionId: "session-1",
    });
    await observed.promise;
    await finishTurn(events, session, firstTurn);
    const blocked = await startPrompt(connection, events, "abort-blocked", "second");
    expect(blocked).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "OMP interrupt is still settling" },
        }),
      }),
    );
    expect(session.prompts).toEqual(["first"]);

    abort.resolve();
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "abort-first",
    );
    const secondTurn = turnIdFrom(await startPrompt(connection, events, "abort-second", "second"));
    await connection.send({
      type: "session.interrupt",
      requestId: "abort-second",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "abort-second",
    );
    await finishTurn(events, session, secondTurn);
    expect(session.aborts).toBe(2);
    await connection.close();
  });
  test("reports the same abort failure to concurrent interrupts", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = observed.resolve;
    session.abortError = new Error("abort rejected");
    await startPrompt(connection, events, "abort-error-turn", "work");

    await connection.send({
      type: "session.interrupt",
      requestId: "abort-error-one",
      sessionId: "session-1",
    });
    await observed.promise;
    await connection.send({
      type: "session.interrupt",
      requestId: "abort-error-two",
      sessionId: "session-1",
    });
    const firstFailure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "abort-error-one",
    );
    const secondFailure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "abort-error-two",
    );
    abort.resolve();
    const [first, second] = await Promise.all([firstFailure, secondFailure]);
    expect(first).toEqual(expect.objectContaining({ error: { message: "OMP interrupt failed" } }));
    expect(second).toEqual(expect.objectContaining({ error: { message: "OMP interrupt failed" } }));
    await connection.close();
  });
  test("serializes interrupt and close while awaiting runtime disposal", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = abortObserved.resolve;
    session.closeGate = close.promise;
    const turnId = turnIdFrom(await startPrompt(connection, events, "interrupt-close", "work"));

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-race",
      sessionId: "session-1",
    });
    await abortObserved.promise;
    const closing = connection.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    abort.resolve();
    close.resolve();
    await closing;
    expect(session.aborts).toBe(1);
    expect(session.closes).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "canceled" })]);
  });
  test("reports native close rejection to an explicit close request", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("native close failed");

    await connection.send({
      type: "session.close",
      requestId: "close-failure",
      sessionId: "session-1",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "close-failure",
    );
    const closed = await events.waitFor((event) => event.type === "session.closed");
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    expect(closed).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "reopen-after-close-failure",
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
      (event) =>
        event.type === "request.failed" && event.requestId === "reopen-after-close-failure",
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });
  test("tombstones failed MCP host cleanup independently of runtime disposal", async () => {
    const runtime = new FakeOmpRuntime();
    let hostCloses = 0;
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          hostCloses += 1;
          throw new Error("host cleanup failed");
        },
      }),
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "host-cleanup-open",
      sessionId: "host-cleanup-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: { repo: { type: "stdio", command: "repo-mcp" } },
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "host-cleanup-open",
    );
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited" });
    await connection.send({
      type: "session.close",
      requestId: "host-cleanup-close",
      sessionId: "host-cleanup-session",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "host-cleanup-close",
    );
    await connection.send({
      type: "session.open",
      requestId: "host-cleanup-reopen",
      sessionId: "host-cleanup-session",
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
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "host-cleanup-reopen",
    );
    expect(runtime.starts).toHaveLength(1);
    expect(hostCloses).toBe(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("aggregates host and incoming startup cleanup before releasing ownership", async () => {
    const runtime = new FakeOmpRuntime();
    const runtimeCleanup = Promise.withResolvers<void>();
    const hostCloseStarted = Promise.withResolvers<void>();
    const releaseHostClose = Promise.withResolvers<void>();
    let hostCloses = 0;
    runtime.nextStartError = new OmpCleanupFailure(
      "runtime startup cleanup pending",
      runtimeCleanup.promise,
    );
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          hostCloses += 1;
          hostCloseStarted.resolve();
          await releaseHostClose.promise;
          throw new Error("host close failed");
        },
      }),
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    const open = (requestId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId: "aggregate-cleanup-session",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: { repo: { type: "stdio", command: "repo" } },
          model: MODEL_PUBLIC_ID,
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });

    await open("aggregate-cleanup-open");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "aggregate-cleanup-open",
    );
    await hostCloseStarted.promise;
    expect(hostCloses).toBe(1);
    await open("aggregate-cleanup-reopen-pending");
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "aggregate-cleanup-reopen-pending",
    );
    expect(runtime.starts).toHaveLength(1);

    runtimeCleanup.reject(new Error("runtime cleanup failed"));
    releaseHostClose.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await open("aggregate-cleanup-reopen-failed");
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "aggregate-cleanup-reopen-failed",
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("retains failed initialization cleanup ownership and blocks same-ID reopen", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [];
    runtime.nextCloseError = new Error("initial cleanup failed");
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "failed-initial-open",
      sessionId: "failed-initial-session",
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
      (event) => event.type === "request.failed" && event.requestId === "failed-initial-open",
    );
    await connection.send({
      type: "session.open",
      requestId: "blocked-reopen",
      sessionId: "failed-initial-session",
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
      (event) => event.type === "request.failed" && event.requestId === "blocked-reopen",
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });
  test("tombstones OmpRpcRuntime startup cleanup failures", async () => {
    let starts = 0;
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        starts += 1;
        const child = new ProviderRpcChild(() => {});
        queueMicrotask(() => child.write({ type: "ready", protocolVersion: 1 }));
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(false),
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    for (const requestId of ["startup-failure", "blocked-startup-reopen"]) {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: "startup-failure-session",
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
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(starts).toBe(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("does not tombstone confirmed spawn failures before process ownership", async () => {
    let starts = 0;
    let terminations = 0;
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        starts += 1;
        const child = new ProviderRpcChild(() => {});
        Object.defineProperty(child, "pid", { value: undefined });
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("spawn failed"), {
              code: starts === 1 ? "ENOENT" : "EACCES",
            }),
          );
        });
        return child.asChildProcess();
      },
      terminateProcessTree() {
        terminations += 1;
        return Promise.resolve(false);
      },
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));

    for (const requestId of ["missing-executable", "non-runnable-executable"]) {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: "spawn-failure-session",
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
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }

    expect(starts).toBe(2);
    expect(terminations).toBe(0);
    await connection.close();
  });

  test("close during open waits for the created runtime session cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    const start = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.startGate = start.promise;
    runtime.startObserved = observed.resolve;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "open-race",
      sessionId: "session-race",
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
    await observed.promise;
    const closing = connection.close();
    start.resolve();
    await closing;

    expect(sessionAt(runtime).closes).toBe(1);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
  });

  test("close during open propagates the late session cleanup failure", async () => {
    const runtime = new FakeOmpRuntime();
    const start = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.startGate = start.promise;
    runtime.startObserved = observed.resolve;
    runtime.nextCloseError = new Error("late session close failed");
    const { connection } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "late-close-open",
      sessionId: "late-close-session",
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
    await observed.promise;
    const closing = connection.close();
    start.resolve();

    await expect(closing).rejects.toThrow("provider connection cleanup failed");
    expect(sessionAt(runtime).closes).toBe(1);
  });

  test("close during an active prompt waits and cancels exactly one turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptResult = await startPrompt(connection, events, "closing-prompt", "wait");
    const turnId = turnIdFrom(promptResult);

    await connection.close();

    const turns = events.filter(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(turns).toEqual([expect.objectContaining({ state: "canceled" })]);
    expect(session.closes).toBe(1);
  });

  test("close waits for a deferred prompt acceptance", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = observed.resolve;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "pending-close",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "wait" }] },
      },
    });
    await observed.promise;
    const closing = connection.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    promptGate.resolve();
    await closing;

    expect(
      events.filter(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "pending-close",
      ),
    ).toEqual([expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) })]);
  });

  test("concurrent connection closes await one deferred disposal", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const closeGate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.closeGate = closeGate.promise;
    session.closeObserved = observed.resolve;

    const first = connection.close();
    const second = connection.close();
    await observed.promise;
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    closeGate.resolve();
    await Promise.all([first, second]);

    expect(session.closes).toBe(1);
  });

  test("reports native steer failures while a turn remains active", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    await startPrompt(connection, events);
    const session = sessionAt(runtime);
    session.steerError = new Error("steer transport failed");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-failed",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    const result = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-failed",
    );

    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    await connection.close();
  });
});
