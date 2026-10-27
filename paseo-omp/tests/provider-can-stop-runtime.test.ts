import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  createHarness,
  type EventLog,
  FakeOmpRuntime,
  openSession,
  sessionAt,
  startPrompt,
} from "./helpers/provider-harness";

const CAPABILITIES = ["prompt.message", "session.can_stop_runtime", "session.subsession"];

async function openSettled() {
  const harness = await createHarness(new FakeOmpRuntime(), undefined, CAPABILITIES);
  await openSession(harness.connection, harness.events);
  const session = sessionAt(harness.runtime);
  session.isSettled = true;
  session.hasPendingAsyncWork = false;
  return { ...harness, session };
}

interface QueryTarget {
  connection: ProviderConnection;
  events: EventLog;
}

async function query(
  { connection, events }: QueryTarget,
  requestId: string,
  sessionId = "session-1",
): Promise<ProviderEvent> {
  await connection.send({ type: "session.can_stop_runtime", requestId, sessionId });
  return events.waitFor(
    (event) =>
      (event.type === "session.can_stop_runtime" || event.type === "request.failed") &&
      event.requestId === requestId,
  );
}

describe("OMP idle runtime release veto", () => {
  test("advertises the capability only when negotiated", async () => {
    const negotiated = await openSettled();
    expect(negotiated.connection.capabilities).toContain("session.can_stop_runtime");
    expect(
      negotiated.events.find((event) => event.type === "session.opened")?.capabilities,
    ).toContain("session.can_stop_runtime");
    await negotiated.connection.close();

    const plain = await createHarness();
    expect(plain.connection.capabilities).not.toContain("session.can_stop_runtime");
    await plain.connection.close();
  });

  test("allows release for an idle, settled session", async () => {
    const harness = await openSettled();
    expect(await query(harness, "can-stop-idle")).toEqual({
      type: "session.can_stop_runtime",
      requestId: "can-stop-idle",
      sessionId: "session-1",
      canStop: true,
    });
    await harness.connection.close();
  });

  test("vetoes release while OMP reports background async work", async () => {
    const harness = await openSettled();
    harness.session.hasPendingAsyncWork = true;
    expect(await query(harness, "can-stop-async")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: false }),
    );
    harness.session.hasPendingAsyncWork = false;
    harness.session.isSettled = false;
    expect(await query(harness, "can-stop-unsettled")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: false }),
    );
    await harness.connection.close();
  });

  test("vetoes release when OMP does not report the settled fields", async () => {
    const harness = await openSettled();
    harness.session.isSettled = undefined;
    harness.session.hasPendingAsyncWork = undefined;
    expect(await query(harness, "can-stop-unknown")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: false }),
    );
    await harness.connection.close();
  });

  test("vetoes release while a turn is running", async () => {
    const harness = await openSettled();
    await startPrompt(harness.connection, harness.events);
    expect(await query(harness, "can-stop-turn")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: false }),
    );
    await harness.connection.close();
  });

  test("vetoes release while a subagent is running and allows it once finished", async () => {
    const harness = await openSettled();
    const child = {
      id: "can-stop-child",
      agent: "scout",
      sessionFile: "/sessions/root/can-stop-child.jsonl",
      index: 0,
    };
    harness.session.emit({ type: "subagent_lifecycle", payload: { ...child, status: "started" } });
    expect(await query(harness, "can-stop-child-running")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: false }),
    );
    harness.session.emit({
      type: "subagent_lifecycle",
      payload: { ...child, status: "completed" },
    });
    expect(await query(harness, "can-stop-child-done")).toEqual(
      expect.objectContaining({ type: "session.can_stop_runtime", canStop: true }),
    );
    await harness.connection.close();
  });

  test("fails the request, never answers true, when the state lookup fails", async () => {
    const harness = await openSettled();
    harness.session.stateError = new Error("state unavailable");
    expect(await query(harness, "can-stop-error")).toEqual(
      expect.objectContaining({ type: "request.failed", requestId: "can-stop-error" }),
    );
    expect(
      harness.events.some(
        (event) => event.type === "request.completed" && event.requestId === "can-stop-error",
      ),
    ).toBe(false);
    await harness.connection.close();
  });

  test("fails the request for an unknown session", async () => {
    const harness = await openSettled();
    expect(await query(harness, "can-stop-unknown-session", "missing-session")).toEqual(
      expect.objectContaining({ type: "request.failed", requestId: "can-stop-unknown-session" }),
    );
    await harness.connection.close();
  });
});
