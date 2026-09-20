import { describe, expect, test } from "vitest";
import {
  createHarness,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("publishes remote-safe MCP authorization cards when negotiated", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "permission", "timeline.plugin"],
    );
    await openSession(connection, events);
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "mcp-auth",
      method: "open_url",
      url: "https://auth.example.com/authorize?state=opaque",
      launchUrl: "http://127.0.0.1:4321/launch",
      instructions: "Authorize the MCP server",
    });
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "documentation-link",
      method: "open_url",
      url: "https://docs.example.com/mcp",
      instructions: "Read the MCP guide",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: {
          type: "plugin",
          id: "omp:ui:1",
          pluginId: "paseo-omp",
          kind: "omp-mcp-authorization",
          version: 1,
          data: {
            url: "https://auth.example.com/authorize?state=opaque",
            instructions: "Authorize the MCP server",
            loopbackCallback: true,
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: {
          type: "notification",
          id: "omp:ui:2",
          level: "info",
          message: "Read the MCP guide\nhttps://docs.example.com/mcp",
        },
      }),
    );
    expect(
      events.filter((event) => event.type === "timeline.item" && event.item.type === "plugin"),
    ).toHaveLength(1);
    await connection.close();
  });

  test("routes an allowed freeform select through OMP's native follow-up input", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "freeform-turn", "choose"));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "freeform-ask",
      toolName: "ask_user",
      args: { question: "Deployment", allowFreeform: true },
    });
    session.emit({
      type: "extension_ui_request",
      id: "native-freeform-select",
      method: "select",
      title: "Deployment",
      options: ["Preview", "✏️ Type custom response..."],
    });
    const permission = events.findLast(
      (event) => event.type === "session.permission" && event.request.title === "Deployment",
    );
    if (permission?.type !== "session.permission") throw new Error("Expected freeform permission");
    expect(permission.request.input?.questions).toEqual([
      {
        header: "Deployment",
        question: "Deployment",
        options: [
          {
            label: "Preview",
            value: expect.stringMatching(/:option:0$/u),
          },
        ],
        multiSelect: false,
        allowOther: true,
      },
    ]);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { Deployment: "Custom staging ring" } },
      },
    });
    expect(session.extensionUiResponses).toEqual([
      {
        type: "extension_ui_response",
        id: "native-freeform-select",
        value: "✏️ Type custom response...",
      },
    ]);
    session.emit({
      type: "extension_ui_request",
      id: "native-freeform-input",
      method: "input",
      title: "Custom response",
    });
    await Promise.resolve();
    expect(session.extensionUiResponses).toEqual([
      {
        type: "extension_ui_response",
        id: "native-freeform-select",
        value: "✏️ Type custom response...",
      },
      {
        type: "extension_ui_response",
        id: "native-freeform-input",
        value: "Custom staging ring",
      },
    ]);

    session.emit({
      type: "extension_ui_request",
      id: "native-oversized-select",
      method: "select",
      title: "Another deployment",
      options: ["Preview", "✏️ Type custom response..."],
    });
    const oversized = events.findLast(
      (event) =>
        event.type === "session.permission" && event.request.title === "Another deployment",
    );
    if (oversized?.type !== "session.permission") throw new Error("Expected bounded permission");
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: oversized.request.id,
        response: {
          behavior: "allow",
          updatedInput: { answers: { "Another deployment": "x".repeat(64 * 1024 + 1) } },
        },
      }),
    ).rejects.toThrow("OMP freeform response is invalid");
    expect(session.extensionUiResponses).toHaveLength(2);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: oversized.request.id,
      response: { behavior: "deny" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "freeform-ask",
      toolName: "ask_user",
      result: { answer: "Custom staging ring" },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "freeform-answer",
        content: [{ type: "text", text: "Continuing" }],
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("claims permission responses once and expires unanswered questions locally", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.emit({
      type: "extension_ui_request",
      id: "native-race",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission");
    const permissionCountBeforeUpdate = events.filter(
      (event) => event.type === "session.permission",
    ).length;
    const replacementRequest = {
      type: "extension_ui_request" as const,
      id: "native-race",
      method: "confirm" as const,
      title: "Continue updated",
      message: "Proceed now?",
    };
    session.emit(replacementRequest);
    const updatedPermissions = events.filter((event) => event.type === "session.permission");
    expect(updatedPermissions).toHaveLength(permissionCountBeforeUpdate + 1);
    const updatedPermission = updatedPermissions.at(-1);
    if (updatedPermission?.type !== "session.permission") {
      throw new Error("Expected updated permission");
    }
    expect(updatedPermission.request.id).not.toBe(permission.request.id);
    expect(events).toContainEqual({
      type: "session.permission_resolved",
      sessionId: "session-1",
      permissionId: permission.request.id,
    });
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");

    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: updatedPermission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    const permissionCountInFlight = events.filter(
      (event) => event.type === "session.permission",
    ).length;
    session.emit(replacementRequest);
    expect(events.filter((event) => event.type === "session.permission")).toHaveLength(
      permissionCountInFlight,
    );
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: updatedPermission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    gate.resolve();
    await inFlightResponse;
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === updatedPermission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-race", confirmed: true },
    ]);

    session.extensionUiResponseGate = null;
    session.extensionUiResponseObserved = null;
    session.extensionUiResponseError = new Error("write failed");
    session.emit({
      type: "extension_ui_request",
      id: "native-retry",
      method: "input",
      title: "Retry input",
      timeout: 1_000,
    });
    const retryPermission = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.title === "Retry input",
    );
    if (retryPermission.type !== "session.permission") throw new Error("Expected retry permission");
    const retryResponse = {
      behavior: "allow" as const,
      updatedInput: { answers: { "Retry input": "value" } },
    };
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: retryPermission.request.id,
        response: retryResponse,
      }),
    ).rejects.toThrow("write failed");
    expect(scheduler.delays.at(-1)).toBeLessThanOrEqual(1_000);
    const retryObserved = Promise.withResolvers<void>();
    session.extensionUiResponseObserved = retryObserved.resolve;
    session.extensionUiResponseError = null;
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: retryPermission.request.id,
      response: retryResponse,
    });
    await retryObserved.promise;
    await Promise.resolve();
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-retry",
      value: "value",
    });
    session.emit({
      type: "extension_ui_request",
      id: "native-timeout",
      method: "input",
      title: "Timed input",
      timeout: 250,
    });
    const timed = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.title === "Timed input",
    );

    if (timed.type !== "session.permission") throw new Error("Expected timed permission");
    const responsesBeforeTimeout = session.extensionUiResponses.length;
    await scheduler.flush();
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" && event.permissionId === timed.request.id,
    );
    expect(session.extensionUiResponses).toHaveLength(responsesBeforeTimeout + 1);
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-timeout",
      cancelled: true,
      timedOut: true,
    });

    await connection.close();
  });
  test("fails closed when an in-flight native permission changes semantics", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "changed-in-flight", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "changing-native",
      method: "confirm",
      title: "Original",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    session.emit({
      type: "extension_ui_request",
      id: "changing-native",
      method: "confirm",
      title: "Replacement",
      message: "Different request",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.permission" && event.request.title === "Replacement",
      ),
    ).toHaveLength(0);
    gate.resolve();
    await inFlightResponse;
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("scopes permission evidence to its turn and never reuses public ids", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const firstSession = sessionAt(runtime);
    firstSession.emit({
      type: "extension_ui_request",
      id: "reused-native-id",
      method: "confirm",
      title: "Idle question",
      message: "Idle?",
    });
    const idlePermission = events.findLast((event) => event.type === "session.permission");
    if (idlePermission?.type !== "session.permission") throw new Error("Expected idle permission");

    const turnId = turnIdFrom(await startPrompt(connection, events, "scoped-turn", "work"));
    firstSession.emit({
      type: "extension_ui_request",
      id: "turn-question",
      method: "confirm",
      title: "Turn question",
      message: "Continue?",
    });
    const turnPermission = events.findLast((event) => event.type === "session.permission");
    if (turnPermission?.type !== "session.permission") throw new Error("Expected turn permission");
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: turnPermission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await Promise.resolve();
    firstSession.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "permission-answer", content: "Continuing" },
    });
    firstSession.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    firstSession.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.send({
      type: "session.close",
      requestId: "close-first",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-first",
    );

    await openSession(
      connection,
      events,
      "open-second",
      "session-2",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    sessionAt(runtime, 1).emit({
      type: "extension_ui_request",
      id: "reused-native-id",
      method: "confirm",
      title: "Idle question",
      message: "Idle?",
    });
    const secondPermission = events.findLast(
      (event) => event.type === "session.permission" && event.sessionId === "session-2",
    );
    if (secondPermission?.type !== "session.permission")
      throw new Error("Expected second permission");
    expect(secondPermission.request.id).not.toBe(idlePermission.request.id);
    await connection.close();
  });

  test("cancels saturated permission queues and fails empty selects closed", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    for (let index = 0; index < 33; index += 1) {
      session.emit({
        type: "extension_ui_request",
        id: `native-${index}`,
        method: "confirm",
        title: `Question ${index}`,
        message: "Continue?",
      });
    }
    await events.waitFor(
      (event) => event.type === "session.notice" && event.notice.title === "OMP question canceled",
    );
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "native-32",
      cancelled: true,
    });
    const turnId = turnIdFrom(await startPrompt(connection, events, "empty-select", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "empty-select",
      method: "select",
      title: "Empty",
      options: [],
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(expect.objectContaining({ error: { message: "OMP runtime failed" } }));
    await connection.close();
  });

  test("bounds cumulative pending permission bytes", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const options = Array.from({ length: 128 }, (_, index) => `${index}:${"x".repeat(2_040)}`);
    for (let index = 0; index < 10; index += 1) {
      session.emit({
        type: "extension_ui_request",
        id: `large-${index}`,
        method: "select",
        title: `Large ${index}`,
        options,
      });
      if (
        events.some(
          (event) =>
            event.type === "session.notice" &&
            event.notice.description === "OMP question data exceeded the pending input budget",
        )
      ) {
        break;
      }
    }
    const permissions = events.filter((event) => event.type === "session.permission");
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.length).toBeLessThan(10);
    await Promise.resolve();
    expect(session.extensionUiResponses.at(-1)).toEqual(
      expect.objectContaining({ type: "extension_ui_response", cancelled: true }),
    );
    await connection.close();
  });
});
