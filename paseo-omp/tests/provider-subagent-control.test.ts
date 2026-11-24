import { describe, expect, test } from "vitest";
import type { OmpSubagentSnapshot } from "../server/provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import { createOmpProvider } from "../server/provider/registration";
import { ompSubagentHandle } from "../server/provider/subsessions";
import {
  OmpSubagentControlRegistry,
  type OmpSubagentControls,
  resolveCancelOmpSubagent,
  resolveGetOmpSessionModelProvider,
  resolveSteerOmpSubagent,
} from "../server/subagents";
import { OMP_SUBAGENT_STRIP_KIND, ompSubagentStripSchema } from "../shared/subagents";
import {
  ALTERNATE_MODEL_PUBLIC_ID,
  EventLog,
  FakeOmpRuntime,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

function snapshot(id: string, status: OmpSubagentSnapshot["status"] = "running") {
  return { id, index: 0, agent: "worker", description: `${id} task`, status, lastUpdate: 1 };
}

async function createControlledHarness(
  capabilities = ["prompt.message", "prompt.steer", "session.subsession"],
) {
  const runtime = new FakeOmpRuntime();
  const registry = new OmpSubagentControlRegistry();
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: new ManualScheduler(),
    environment: TEST_RUNTIME_ENV,
    subagentControlRegistry: registry,
  }).connect({ versions: [1], capabilities });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, registry };
}

describe("OMP subagent controls", () => {
  test("route each agent only to its own session's running subagents", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(
      connection,
      events,
      "open-a",
      "session-a",
      {
        PASEO_AGENT_ID: "agent-a",
        ACME_API_KEY: "credential-secret",
      },
      MODEL_PUBLIC_ID,
      "medium",
      false,
      {
        providerOptions: { outputRedaction: "configured-values" },
      },
    );
    await openSession(connection, events, "open-b", "session-b", { PASEO_AGENT_ID: "agent-b" });
    const first = sessionAt(runtime, 0);
    const second = sessionAt(runtime, 1);
    first.subagents = [
      { ...snapshot("a-credential-secret"), description: "uses credential-secret" },
      snapshot("a-finished", "completed"),
    ];
    second.subagents = [snapshot("b-child")];

    const running = ompSubagentHandle("session-a", "a-credential-secret");
    const finished = ompSubagentHandle("session-a", "a-finished");
    const foreign = { id: ompSubagentHandle("session-b", "b-child") };

    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: foreign.id }, registry),
    ).resolves.toEqual({ cancelled: false });
    await expect(
      resolveSteerOmpSubagent(
        { agentId: "agent-a", subagentId: foreign.id, message: "x" },
        registry,
      ),
    ).rejects.toThrow("This subagent is no longer running");
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: "a-credential-secret" }, registry),
    ).resolves.toEqual({ cancelled: false });
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: finished }, registry),
    ).resolves.toEqual({ cancelled: false });
    expect(first.subagentCancels).toEqual([]);
    expect(second.subagentCancels).toEqual([]);
    expect(first.subagentSteers).toEqual([]);

    await expect(
      resolveSteerOmpSubagent(
        { agentId: "agent-a", subagentId: running, message: "Focus on the parser" },
        registry,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).resolves.toEqual({ cancelled: true });
    first.subagentCancelResult = false;
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).resolves.toEqual({ cancelled: false });
    expect(first.subagentSteers).toEqual([
      { subagentId: "a-credential-secret", message: "Focus on the parser" },
    ]);
    expect(first.subagentCancels).toEqual(["a-credential-secret", "a-credential-secret"]);
    expect(second.subagentCancels).toEqual([]);

    await connection.send({ type: "session.close", requestId: "close-a", sessionId: "session-a" });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-a",
    );
    expect(registry.get("agent-a")).toBeUndefined();
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).rejects.toThrow("This agent has no running OMP Plugin session");
    expect(registry.get("agent-b")).toBeDefined();
    await connection.close();
    expect(registry.get("agent-b")).toBeUndefined();
  });

  test("publishes a redacted strip below its task card and empties it when the children finish", async () => {
    const { connection, events, runtime } = await createControlledHarness([
      "prompt.message",
      "session.subsession",
      "timeline.plugin",
    ]);
    await openSession(
      connection,
      events,
      "open-1",
      "session-1",
      { PASEO_AGENT_ID: "agent-1", ACME_API_KEY: "credential-secret" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const session = sessionAt(runtime);
    turnIdFrom(await startPrompt(connection, events));
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    const strips = () =>
      events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "plugin" &&
        event.item.kind === OMP_SUBAGENT_STRIP_KIND
          ? [event]
          : [],
      );
    const lifecycle = (id: string, status: "started" | "aborted" | "completed") =>
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id,
          agent: "worker",
          status,
          description: `${id} uses credential-secret`,
          parentToolCallId: "task-1",
          index: 0,
        },
      });

    lifecycle("child-credential-secret", "started");
    expect(strips()).toEqual([]);
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { agent: "worker", task: "inspect" },
    });
    const card = events.findIndex(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    const first = events.findIndex(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "plugin" &&
        event.item.kind === OMP_SUBAGENT_STRIP_KIND,
    );
    expect(card).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(card);
    expect(strips()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        item: {
          type: "plugin",
          id: "omp:subagents:task-1",
          pluginId: "paseo-omp",
          kind: OMP_SUBAGENT_STRIP_KIND,
          version: 1,
          data: {
            subagents: [
              {
                id: ompSubagentHandle("session-1", "child-credential-secret"),
                agent: "worker",
                description: "child-<redacted> uses <redacted>",
                runningSince: expect.any(Number),
              },
            ],
          },
        },
      }),
    ]);

    lifecycle("child-2", "started");
    lifecycle("child-credential-secret", "aborted");
    lifecycle("child-2", "completed");
    expect(
      strips().map((event) =>
        event.item.type === "plugin"
          ? (event.item.data as { subagents: Array<{ id: string }> }).subagents.map(
              (subagent) => subagent.id,
            )
          : [],
      ),
    ).toEqual([
      [ompSubagentHandle("session-1", "child-credential-secret")],
      [
        ompSubagentHandle("session-1", "child-credential-secret"),
        ompSubagentHandle("session-1", "child-2"),
      ],
      [ompSubagentHandle("session-1", "child-2")],
      [],
    ]);
    expect(JSON.stringify(strips())).not.toContain("credential-secret");
    lifecycle("child-2", "completed");
    expect(strips()).toHaveLength(4);
    await connection.close();
  });

  test("bounds strip descriptions to the renderer contract", async () => {
    const { connection, events, runtime } = await createControlledHarness([
      "prompt.message",
      "session.subsession",
      "timeline.plugin",
    ]);
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    turnIdFrom(await startPrompt(connection, events));
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { agent: "worker", task: "inspect" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        description: "x".repeat(4_000),
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    const strip = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "plugin" &&
        event.item.kind === OMP_SUBAGENT_STRIP_KIND,
    );
    if (strip?.type !== "timeline.item" || strip.item.type !== "plugin") {
      throw new Error("Expected the subagent strip");
    }
    expect(ompSubagentStripSchema.safeParse(strip.item.data).success).toBe(true);
    await connection.close();
  });

  test("publishes no strip without the plugin timeline capability", async () => {
    const { connection, events, runtime } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    turnIdFrom(await startPrompt(connection, events));
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { agent: "worker", task: "inspect" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    await events.waitFor(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "plugin"),
    ).toBe(false);
    await connection.close();
  });

  test("cancels a child while the parent turn keeps running and completes later", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { agent: "worker", task: "inspect" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    const childOpened = await events.waitFor(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (childOpened.type !== "session.opened") throw new Error("Missing child session");
    session.subagents = [snapshot("child-1")];
    const handle = ompSubagentHandle("session-1", "child-1");

    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-1", subagentId: handle }, registry),
    ).resolves.toEqual({ cancelled: true });
    session.subagents = [];
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "aborted",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.sessionId === childOpened.sessionId &&
        event.state === "canceled",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    expect(session.aborts).toBe(0);

    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      result: { details: { results: [{ id: "child-1", aborted: true }] } },
      isError: true,
    });
    session.emit({ type: "agent_end", requestId: "rpc-prompt-1", messages: [], isTerminal: true });
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("never controls a dead runtime and maps OMP failures to fixed messages", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    session.subagents = [snapshot("child-1")];
    const handle = ompSubagentHandle("session-1", "child-1");
    const cancel = () =>
      resolveCancelOmpSubagent({ agentId: "agent-1", subagentId: handle }, registry);
    const steer = () =>
      resolveSteerOmpSubagent(
        { agentId: "agent-1", subagentId: handle, message: "focus" },
        registry,
      );

    session.subagentControlError = new OmpRpcRequestRejectedError(undefined, "unsupported_command");
    await expect(cancel()).rejects.toThrow(
      "Update OMP to 18.4.9 or newer to control subagents from Paseo",
    );
    session.subagentControlError = new Error("OMP RPC request timed out");
    await expect(steer()).rejects.toThrow(
      "OMP did not confirm delivery in time. The subagent may still receive the message",
    );
    await expect(cancel()).rejects.toThrow(
      "OMP did not confirm the cancellation in time. Check the subagent before retrying",
    );
    session.subagentControlError = new Error("Subagent refused the message: private output");
    await expect(steer()).rejects.toThrow(
      "OMP did not accept the message. The subagent may have finished or refused it",
    );
    await expect(cancel()).rejects.toThrow("OMP could not cancel the subagent");

    const cancelsBeforeExit = session.subagentCancels.length;
    session.emit({ type: "process_exit", error: "OMP exited between turns" });
    await expect(cancel()).resolves.toEqual({ cancelled: false });
    await expect(steer()).rejects.toThrow("This subagent is no longer running");
    expect(session.subagentCancels).toHaveLength(cancelsBeforeExit);
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("sends nothing when the runtime dies while the roster is being read", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    session.subagents = [snapshot("child-1")];
    const handle = ompSubagentHandle("session-1", "child-1");
    const gate = Promise.withResolvers<void>();
    const bothReading = Promise.withResolvers<void>();
    let reads = 0;
    session.subagentsGate = gate.promise;
    session.subagentsObserved = () => {
      reads += 1;
      if (reads === 2) bothReading.resolve();
    };
    const cancelling = resolveCancelOmpSubagent(
      { agentId: "agent-1", subagentId: handle },
      registry,
    );
    const steering = resolveSteerOmpSubagent(
      { agentId: "agent-1", subagentId: handle, message: "focus" },
      registry,
    );
    await bothReading.promise;
    session.emit({ type: "process_exit", error: "OMP exited between turns" });
    gate.resolve();
    await expect(cancelling).resolves.toEqual({ cancelled: false });
    await expect(steering).rejects.toThrow("This subagent is no longer running");
    expect(session.subagentCancels).toEqual([]);
    expect(session.subagentSteers).toEqual([]);
    await connection.close();
  });

  test("names the OMP provider behind an agent's opaque model only while its session runs", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-a", "session-a", { PASEO_AGENT_ID: "agent-a" });
    const provider = (agentId: string, model: string) =>
      resolveGetOmpSessionModelProvider({ agentId, model }, registry).provider;

    expect(provider("agent-a", MODEL_PUBLIC_ID)).toBe("anthropic");
    // The answer is for the model the caller saw, not the session's current one: a lookup for a
    // model the agent left (A, then B, then A again) still names that model's provider.
    expect(provider("agent-a", ALTERNATE_MODEL_PUBLIC_ID)).toBe("openai");
    expect(provider("agent-a", "omp:model:unknown")).toBeNull();
    expect(provider("agent-unknown", MODEL_PUBLIC_ID)).toBeNull();
    sessionAt(runtime, 0).emit({ type: "process_exit", error: "OMP exited between turns" });
    await Promise.resolve();
    expect(provider("agent-a", MODEL_PUBLIC_ID)).toBeNull();
    await connection.close();
  });

  test("lets a newer session replace an agent's controls without the older cleanup removing it", () => {
    const registry = new OmpSubagentControlRegistry();
    const controls = (): OmpSubagentControls => ({
      cancelSubagent: async () => false,
      steerSubagent: async () => {},
      modelProvider: () => null,
      listProviderAccounts: async () => [],
    });
    const older = controls();
    const newer = controls();
    const removeOlder = registry.register("agent-1", older);
    const removeNewer = registry.register("agent-1", newer);
    removeOlder();
    expect(registry.get("agent-1")).toBe(newer);
    removeNewer();
    expect(registry.get("agent-1")).toBeUndefined();
  });
});
