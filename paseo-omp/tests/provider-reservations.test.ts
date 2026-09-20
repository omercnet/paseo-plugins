import type { ProviderConnection } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { OmpNativeSessionReservations } from "../server/provider/connection";
import { createOmpProvider } from "../server/provider/registration";
import { OmpCleanupFailure } from "../server/provider/security";
import {
  createHarness,
  EventLog,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  NATIVE_SESSION_ID,
  sendPersistentOpen,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("reserves one native transcript across concurrent public opens", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const sendResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
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
    await sendResume("first-native-open", "public-one");
    await started.promise;
    await sendResume("second-native-open", "public-two");
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "second-native-open",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ error: { message: "OMP native session is already open" } }),
    );
    expect(runtime.starts).toHaveLength(1);
    runtime.startGate = null;
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "first-native-open",
    );
    await connection.send({
      type: "session.close",
      requestId: "close-first",
      sessionId: "public-one",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-first",
    );
    await sendResume("third-native-open", "public-three");
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "third-native-open",
    );
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });
  test("reserves native transcripts across provider connections until disposal", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
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
    const openResume = (connection: ProviderConnection, requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
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
    await openResume(first.connection, "cross-connection-first", "cross-connection-owner");
    await started.promise;
    runtime.startGate = null;
    await openResume(second.connection, "cross-connection-second", "cross-connection-contender");
    const rejected = await second.events.waitFor(
      (event) =>
        (event.type === "request.failed" || event.type === "session.ready") &&
        event.requestId === "cross-connection-second",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        type: "request.failed",
        error: { message: "OMP native session is already open" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    gate.resolve();
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "cross-connection-first",
    );
    await first.connection.close();
    await openResume(second.connection, "cross-connection-third", "cross-connection-successor");
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "cross-connection-third",
    );
    expect(runtime.starts).toHaveLength(2);
    await second.connection.close();
  });
  test("serializes concurrent unknown-ID persistent opens in FIFO order", async () => {
    const runtime = new FakeOmpRuntime();
    const startGate = Promise.withResolvers<void>();
    const startObserved = Promise.withResolvers<void>();
    runtime.startGate = startGate.promise;
    runtime.startObserved = startObserved.resolve;
    runtime.sessionIds.push("fifo-native-one", "fifo-native-two", "fifo-native-three");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await sendPersistentOpen(connection, "fifo-open-one", "fifo-session-one");
    await startObserved.promise;
    await sendPersistentOpen(connection, "fifo-open-two", "fifo-session-two");
    await sendPersistentOpen(connection, "fifo-open-three", "fifo-session-three");

    expect(runtime.starts).toHaveLength(1);
    expect(events.filter((event) => event.type === "request.failed")).toEqual([]);

    runtime.startGate = null;
    startGate.resolve();
    for (const requestId of ["fifo-open-one", "fifo-open-two", "fifo-open-three"]) {
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === requestId,
      );
    }
    expect(runtime.sessions.map((session) => session.nativeSessionId)).toEqual([
      "fifo-native-one",
      "fifo-native-two",
      "fifo-native-three",
    ]);
    await connection.close();
  });

  test("releases the next persistent waiter after a real open failure", async () => {
    const runtime = new FakeOmpRuntime();
    const startGate = Promise.withResolvers<void>();
    const startObserved = Promise.withResolvers<void>();
    runtime.startGate = startGate.promise;
    runtime.startObserved = startObserved.resolve;
    runtime.nextStartError = new Error("first persistent open failed");
    runtime.sessionIds.push("failure-native-two");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await sendPersistentOpen(connection, "failure-open-one", "failure-session-one");
    await startObserved.promise;
    await sendPersistentOpen(connection, "failure-open-two", "failure-session-two");
    expect(runtime.starts).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "request.failed" && event.requestId === "failure-open-two",
      ),
    ).toBe(false);

    runtime.startGate = null;
    startGate.resolve();
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failure-open-one",
    );
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "failure-open-two",
    );
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });

  test("removes a queued open when its connection shuts down", async () => {
    const runtime = new FakeOmpRuntime();
    const failures: OmpOperationalFailure[] = [];
    const startGate = Promise.withResolvers<void>();
    const startObserved = Promise.withResolvers<void>();
    runtime.startGate = startGate.promise;
    runtime.startObserved = startObserved.resolve;
    runtime.sessionIds.push("shutdown-native-one", "shutdown-native-two");
    const provider = createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      reportOperationalFailure: (failure) => failures.push(failure),
    });
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
    const cancelled = await connect();
    const successor = await connect();

    await sendPersistentOpen(first.connection, "shutdown-open-one", "shutdown-session-one");
    await startObserved.promise;
    await sendPersistentOpen(
      cancelled.connection,
      "shutdown-open-cancelled",
      "shutdown-session-cancelled",
    );
    expect(runtime.starts).toHaveLength(1);
    await cancelled.connection.close();
    expect(failures).toEqual([]);

    await sendPersistentOpen(
      successor.connection,
      "shutdown-open-successor",
      "shutdown-session-successor",
    );
    expect(runtime.starts).toHaveLength(1);
    runtime.startGate = null;
    startGate.resolve();
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "shutdown-open-one",
    );
    await successor.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "shutdown-open-successor",
    );
    expect(runtime.starts).toHaveLength(2);
    await first.connection.close();
    await successor.connection.close();
    expect(failures).toEqual([]);
  });

  test("rejects a duplicate native ID after queued registration completes", async () => {
    const runtime = new FakeOmpRuntime();
    const startGate = Promise.withResolvers<void>();
    const startObserved = Promise.withResolvers<void>();
    runtime.startGate = startGate.promise;
    runtime.startObserved = startObserved.resolve;
    runtime.sessionIds.push("duplicate-native", "duplicate-native");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await sendPersistentOpen(connection, "duplicate-open-one", "duplicate-session-one");
    await startObserved.promise;
    await sendPersistentOpen(connection, "duplicate-open-two", "duplicate-session-two");
    expect(runtime.starts).toHaveLength(1);
    runtime.startGate = null;
    startGate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "duplicate-open-one",
    );
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "duplicate-open-two",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ error: { message: "OMP native session is already open" } }),
    );
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });

  test("blocks a queued persistent open when cleanup enters quarantine", async () => {
    const runtime = new FakeOmpRuntime();
    const startGate = Promise.withResolvers<void>();
    const startObserved = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    runtime.startGate = startGate.promise;
    runtime.startObserved = startObserved.resolve;
    runtime.nextStartError = new OmpCleanupFailure("startup cleanup pending", cleanup.promise);
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await sendPersistentOpen(connection, "quarantine-open-one", "quarantine-session-one");
    await startObserved.promise;
    await sendPersistentOpen(connection, "quarantine-open-two", "quarantine-session-two");
    expect(runtime.starts).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "request.failed" && event.requestId === "quarantine-open-two",
      ),
    ).toBe(false);

    runtime.startGate = null;
    startGate.resolve();
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "quarantine-open-one",
    );
    const blocked = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "quarantine-open-two",
    );
    expect(blocked).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    cleanup.resolve();
    await cleanup.promise;
    await connection.close();
  });

  test("keeps the native transcript reserved while its session recovers", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const openResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
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
    await openResume("recovery-owner-open", "recovery-owner");
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "recovery-owner-open",
    );
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    sessionAt(runtime).emit({ type: "process_exit", error: "recover" });
    const recovering = startPrompt(
      connection,
      events,
      "recovery-owner-prompt",
      "continue",
      "recovery-owner",
    );
    await started.promise;
    await openResume("recovery-contender-open", "recovery-contender");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-contender-open",
    );
    expect(runtime.starts).toHaveLength(2);
    runtime.startGate = null;
    gate.resolve();
    const turnId = turnIdFrom(await recovering);
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("keeps a native transcript reserved after unverified open cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryError = new Error("history failed");
    runtime.nextCloseError = new Error("cleanup failed");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const openResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
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
    await openResume("tombstone-owner-open", "tombstone-owner");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "tombstone-owner-open",
    );
    await openResume("tombstone-contender-open", "tombstone-contender");
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "tombstone-contender-open",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });
  test("blocks persistent and nonpersistent opens until cleanup is verified", async () => {
    const otherNativeSessionId = "01a08f6b-8da9-72cb-9080-fc50139bdfcb";
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push(
      { id: NATIVE_SESSION_ID, cwd: "/repo" },
      { id: otherNativeSessionId, cwd: "/repo" },
    );
    const cleanup = Promise.withResolvers<void>();
    runtime.nextHistoryError = new Error("history failed");
    runtime.nextCloseError = new OmpCleanupFailure("cleanup unresolved", cleanup.promise);
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.list", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    const openResume = (
      connection: ProviderConnection,
      requestId: string,
      sessionId: string,
      nativeSessionId: string,
    ) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: nativeSessionId } },
        history: "replay",
      });
    await openResume(
      first.connection,
      "failed-cleanup-first",
      "failed-cleanup-owner",
      NATIVE_SESSION_ID,
    );
    await first.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failed-cleanup-first",
    );

    await second.connection.send({
      type: "sessions",
      requestId: "quarantined-list",
      cwd: "/repo",
    });
    const listFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "quarantined-list",
    );
    expect(listFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    await openResume(
      second.connection,
      "different-resume-blocked",
      "different-resume-contender",
      otherNativeSessionId,
    );
    const resumeFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "different-resume-blocked",
    );
    expect(resumeFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await second.connection.send({
      type: "session.open",
      requestId: "nonpersistent-blocked",
      sessionId: "nonpersistent-during-quarantine",
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
    const nonpersistentFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "nonpersistent-blocked",
    );
    expect(nonpersistentFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );

    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    await expect(first.connection.close()).resolves.toBeUndefined();
    await second.connection.send({
      type: "sessions",
      requestId: "released-list",
      cwd: "/repo",
    });
    await second.events.waitFor(
      (event) => event.type === "sessions" && event.requestId === "released-list",
    );
    await second.connection.send({
      type: "session.open",
      requestId: "nonpersistent-released",
      sessionId: "nonpersistent-during-quarantine",
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
      (event) => event.type === "session.ready" && event.requestId === "nonpersistent-released",
    );
    await openResume(
      second.connection,
      "different-resume-released",
      "different-resume-session",
      otherNativeSessionId,
    );
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "different-resume-released",
    );
    expect(runtime.starts).toHaveLength(3);
    await second.connection.close();
  });

  test("wakes session discovery when persistent registration is cancelled", async () => {
    const reservations = new OmpNativeSessionReservations();
    const owner = Symbol("cancelled-open");
    reservations.beginPersistentOpen(owner);

    const listing = reservations.waitUntilListable();
    reservations.cancelPersistentOpen(owner);

    await expect(listing).resolves.toBeUndefined();
  });

  test("wakes session discovery when persistent registration enters quarantine", async () => {
    const reservations = new OmpNativeSessionReservations();
    const owner = Symbol("quarantined-open");
    reservations.beginPersistentOpen(owner);

    const listing = reservations.waitUntilListable();
    reservations.quarantine(undefined, owner);

    await expect(listing).rejects.toThrow("OMP native session cleanup quarantine is active");
  });

  test("caps provider-global cleanup quarantine growth", async () => {
    const reservations = new OmpNativeSessionReservations();
    const entries = Array.from({ length: 256 }, (_, index) => ({
      owner: Symbol(`quarantine-${index}`),
      nativeSessionId: `quarantined-native-${index}`,
    }));
    for (const { nativeSessionId, owner } of entries) {
      await reservations.reserve(nativeSessionId, owner);
    }
    await expect(reservations.reserve("quarantine-overflow", Symbol("overflow"))).rejects.toThrow(
      "OMP persistent session registry limit reached",
    );
    for (const { nativeSessionId, owner } of entries) {
      reservations.quarantine(nativeSessionId, owner);
    }
    await expect(reservations.waitUntilListable()).rejects.toThrow(
      "OMP native session cleanup quarantine is active",
    );
  });
});
