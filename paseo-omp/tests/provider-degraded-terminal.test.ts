import { describe, expect, onTestFinished, test } from "vitest";
import type { OmpMessage } from "../server/provider/omp-rpc";
import {
  createHarness,
  establishTerminalOwnership,
  finishTurn,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("completes a later turn from a request-matched degraded agent_end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(
      await startPrompt(connection, events, "degraded-keyed-a", "first"),
    );
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "degraded-keyed-b", "second"));
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: "done", stopReason: "stop" },
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
    ).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("uses complete streamed evidence when agent_end omits terminal messages", async () => {
    for (const [suffix, assistant, expectedState, expectedError] of [
      [
        "success",
        { role: "assistant" as const, content: "done", stopReason: "stop" },
        "completed",
        null,
      ],
      [
        "failure",
        {
          role: "assistant" as const,
          content: "failed",
          stopReason: "error",
          errorMessage: "native failure",
        },
        "failed",
        "OMP assistant turn failed",
      ],
      [
        "canceled",
        { role: "assistant" as const, content: "interrupted", stopReason: "aborted" },
        "canceled",
        null,
      ],
    ] as const) {
      const { connection, events, runtime } = await createHarness();
      await openSession(connection, events);
      const result = await startPrompt(connection, events, `degraded-${suffix}`, "work");
      const turnId = turnIdFrom(result);
      const session = sessionAt(runtime);
      session.canReplayHistory = false;
      establishTerminalOwnership(session);
      session.emit({ type: "message_end", message: assistant });
      session.emit({ type: "agent_end", messageCount: 1, messages: [], isTerminal: true });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );

      expect(terminal).toEqual(
        expect.objectContaining({
          state: expectedState,
          ...(expectedError ? { error: { message: expectedError } } : {}),
        }),
      );
      expect(session.historyRequests).toBe(0);
      await connection.close();
    }
  });

  test("fails closed when retained evidence hides a missing middle message", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "degraded-middle", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);
    session.canReplayHistory = false;
    establishTerminalOwnership(session);
    const finalAssistant = { role: "assistant" as const, content: "done", stopReason: "stop" };
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: "before gap", stopReason: "stop" },
    });
    session.emit({ type: "message_end", message: finalAssistant });
    session.emit({
      type: "agent_end",
      messageCount: 3,
      messages: [finalAssistant],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: {
          message:
            "OMP agent_end omitted terminal messages; outcome is unknown " +
            "(declaredCount=3, observedCount=2, retainedTerminalMessages=1, " +
            "lastAssistantStatus=completed)",
        },
      }),
    );
    expect(session.historyRequests).toBe(0);
    await connection.close();
  });

  test("recovers omitted terminal messages from bounded history after provider idle", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "degraded-history", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);
    const history = Array.from(
      { length: 46 },
      (_, index): OmpMessage => ({
        role: "assistant",
        entryId: `history-${index}`,
        content: index === 45 ? "done" : `step ${index}`,
        stopReason: "stop",
      }),
    );
    session.historyMessages = [
      { role: "assistant", entryId: "previous-turn", stopReason: "error" },
      ...history,
    ];
    establishTerminalOwnership(session);
    for (const [index, message] of history.entries()) {
      if (index !== 20) session.emit({ type: "message_end", message });
    }
    session.emit({ type: "agent_end", messageCount: 46, isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.historyRequests).toBe(1);
    await connection.close();
  });

  test.each([
    ["error", "failed"],
    ["aborted", "canceled"],
  ] as const)("recovers the terminal %s outcome from history", async (stopReason, state) => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "history-outcome", "work"));
    const session = sessionAt(runtime);
    const streamed: OmpMessage = {
      role: "assistant",
      entryId: "history-streamed",
      content: "partial",
      stopReason: "stop",
    };
    session.historyMessages = [
      streamed,
      {
        role: "assistant",
        entryId: "history-terminal",
        content: "private terminal content",
        stopReason,
        errorMessage: "private native diagnostic",
      },
    ];
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: streamed });
    session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state }));
    expect(JSON.stringify(terminal)).not.toContain("private");
  });

  test("fails closed when correlated history has no assistant outcome", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "history-unknown", "work"));
    const session = sessionAt(runtime);
    const streamed: OmpMessage = { role: "user", entryId: "history-user", content: "work" };
    session.historyMessages = [
      streamed,
      { role: "custom", entryId: "history-custom", content: "private history content" },
    ];
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: streamed });
    session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
    expect(JSON.stringify(terminal)).not.toContain("private");
  });

  test("fails closed with count diagnostics when bounded history is unavailable", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "degraded-unavailable", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);
    session.historyError = new Error("history unavailable");
    establishTerminalOwnership(session);
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: "partial", stopReason: "stop" },
    });
    session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: {
          message:
            "OMP agent_end omitted terminal messages; outcome is unknown " +
            "(declaredCount=2, observedCount=1, retainedTerminalMessages=0, " +
            "lastAssistantStatus=completed)",
        },
      }),
    );
    expect(session.historyRequests).toBe(1);
    await connection.close();
  });

  test.each(["retained", "streamed"] as const)(
    "fails closed when %s and recovered terminal outcomes conflict",
    async (source) => {
      const { connection, events, runtime } = await createHarness();
      onTestFinished(() => connection.close());
      await openSession(connection, events);
      const turnId = turnIdFrom(await startPrompt(connection, events, "history-conflict", "work"));
      const session = sessionAt(runtime);
      const user: OmpMessage = { role: "user", entryId: "history-user", content: "work" };
      const failed: OmpMessage = {
        role: "assistant",
        entryId: "history-final",
        stopReason: "error",
        errorMessage: "private failure",
      };
      session.historyMessages = [
        user,
        { role: "assistant", entryId: "history-final", stopReason: "stop" },
      ];
      establishTerminalOwnership(session);
      session.emit({ type: "message_end", message: source === "retained" ? user : failed });
      session.emit({
        type: "agent_end",
        messageCount: 2,
        isTerminal: true,
        messages: source === "retained" ? [failed] : [],
      });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
      expect(JSON.stringify(terminal)).not.toContain("private");
    },
  );

  test("preserves an acknowledged interrupt during terminal history recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "history-interrupt", "work"));
    const session = sessionAt(runtime);
    const history = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.historyGate = history.promise;
    session.historyObserved = observed.resolve;
    const streamed: OmpMessage = {
      role: "assistant",
      entryId: "history-streamed",
      content: "partial",
      stopReason: "stop",
    };
    session.historyMessages = [
      streamed,
      { role: "assistant", entryId: "history-final", content: "done", stopReason: "stop" },
    ];
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: streamed });
    session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
    await observed.promise;

    await connection.send({
      type: "session.interrupt",
      requestId: "history-interrupt",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "history-interrupt",
    );
    history.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
  });

  test("does not recover stale history after a permission resumes native work", async () => {
    const { connection, events, runtime } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "history-resumed", "work"));
    const session = sessionAt(runtime);
    const history = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.historyGate = history.promise;
    session.historyObserved = observed.resolve;
    const user: OmpMessage = { role: "user", entryId: "history-user", content: "work" };
    const retained: OmpMessage = {
      role: "assistant",
      entryId: "history-retained",
      stopReason: "stop",
    };
    session.historyMessages = [user, retained];
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: user });
    session.emit({
      type: "extension_ui_request",
      id: "resume-work",
      method: "confirm",
      title: "Continue",
      message: "Continue work?",
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission event");
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messageCount: 2,
      messages: [retained],
      isTerminal: true,
    });
    await observed.promise;
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow" },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === permission.request.id,
    );
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    history.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    session.isStreaming = false;
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [{ role: "assistant", stopReason: "error" }],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
  });

  test.each([
    ["outside suffix", ["a", "b"], ["a", "old", "b", "end"], []],
    ["reordered stream", ["a", "b"], ["b", "a", "end"], []],
    ["missing stream identity", [undefined, "b"], ["a", "b", "end"], []],
    ["uncorrelated retained message", ["a", "b"], ["a", "b", "end"], ["other"]],
    ["retained overlap", ["a", "b"], ["a", "gap", "b"], ["b"]],
  ] as const)(
    "checks terminal history correlation: %s",
    async (name, streamed, history, retained) => {
      const { connection, events, runtime } = await createHarness();
      onTestFinished(() => connection.close());
      await openSession(connection, events);
      const turnId = turnIdFrom(
        await startPrompt(connection, events, "history-correlation", "work"),
      );
      const session = sessionAt(runtime);
      const message = (entryId: string | undefined): OmpMessage => ({
        role: "assistant",
        entryId,
        content: "private message content",
        stopReason: "stop",
      });
      session.historyMessages = history.map(message);
      establishTerminalOwnership(session);
      for (const entryId of streamed)
        session.emit({ type: "message_end", message: message(entryId) });
      session.emit({
        type: "agent_end",
        messageCount: 3,
        messages: retained.map(message),
        isTerminal: true,
      });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      expect(terminal).toEqual(
        expect.objectContaining({ state: name === "retained overlap" ? "completed" : "failed" }),
      );
      expect(JSON.stringify(terminal)).not.toContain("private");
    },
  );

  test("bounds terminal history retrieval and ignores a late result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    onTestFinished(() => connection.close());
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "history-timeout", "work"));
    const session = sessionAt(runtime);
    const history = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.historyGate = history.promise;
    session.historyObserved = observed.resolve;
    const streamed: OmpMessage = {
      role: "assistant",
      entryId: "streamed",
      content: "partial",
      stopReason: "stop",
    };
    session.historyMessages = [
      streamed,
      {
        role: "assistant",
        entryId: "late",
        content: "private history content",
        stopReason: "stop",
      },
    ];
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: streamed });
    session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
    await observed.promise;
    await scheduler.flush(2_000);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
    expect(JSON.stringify(terminal)).not.toContain("private");
    history.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([terminal]);
  });

  test.each(["isStreaming", "isCompacting"] as const)(
    "does not recover history while %s",
    async (activeState) => {
      const { connection, events, runtime } = await createHarness();
      onTestFinished(() => connection.close());
      await openSession(connection, events);
      const turnId = turnIdFrom(await startPrompt(connection, events, "history-busy", "work"));
      const session = sessionAt(runtime);
      const streamed: OmpMessage = {
        role: "assistant",
        entryId: "streamed",
        content: "partial",
        stopReason: "stop",
      };
      session.historyMessages = [
        streamed,
        { role: "assistant", entryId: "final", content: "done", stopReason: "stop" },
      ];
      establishTerminalOwnership(session);
      session.emit({ type: "message_end", message: streamed });
      session[activeState] = true;
      session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.historyRequests).toBe(0);
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
        ),
      ).toBe(false);
      session[activeState] = false;
      session.emit({ type: "agent_end", messageCount: 2, isTerminal: true });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    },
  );

  test("projects safe passive updates outside a turn without wedging the session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    session.emit({
      type: "notice",
      id: "notice-idle",
      level: "warning",
      message: "Background task delayed",
    });
    session.emit({
      type: "todo_reminder",
      todos: [{ id: "todo-idle", content: "Wait for background task", status: "blocked" }],
    });
    session.emit({
      type: "extension_ui_request",
      id: "notify-idle",
      method: "notify",
      notifyType: "info",
      message: "Background task resumed",
    });
    session.emit({
      type: "extension_ui_request",
      id: "widget-idle",
      method: "setWidget",
      widgetKey: "status",
    });
    const urlBaseline = events.length;
    session.emit({
      type: "extension_ui_request",
      id: "oauth-url",
      method: "open_url",
      url: "https://auth.example.com/callback?next=%2Fdashboard%3Fview%3Dcompact#resume%20here",
      instructions: "Authenticate",
    });
    session.emit({
      type: "extension_ui_request",
      id: "safe-url",
      method: "open_url",
      url: "https://docs.example.com/guide",
      instructions: "Documentation",
    });
    session.emit({
      type: "extension_ui_request",
      id: "malformed-url",
      method: "open_url",
      url: "not a URL",
    });
    session.emit({
      type: "extension_ui_request",
      id: "credential-url",
      method: "open_url",
      url: "https://user:password@example.com/private",
    });
    const urlItems = events
      .slice(urlBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "notification" ? [event.item] : [],
      );
    expect(urlItems).toEqual([
      {
        type: "notification",
        id: "omp:ui:3",
        level: "info",
        message:
          "Authenticate\nhttps://auth.example.com/callback?next=%2Fdashboard%3Fview%3Dcompact#resume%20here",
      },
      {
        type: "notification",
        id: "omp:ui:4",
        level: "info",
        message: "Documentation\nhttps://docs.example.com/guide",
      },
    ]);
    expect(JSON.stringify(urlItems)).not.toContain("password");

    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: "omp:notice:1",
        level: "warning",
        message: "Background task delayed",
      },
    });
    expect(
      events.filter((event) => event.type === "timeline.item" && event.item.type === "todo"),
    ).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "todo",
          id: "omp:todos",
          items: [
            {
              id: expect.stringMatching(/^omp:todo:/u),
              text: "Wait for background task",
              completed: false,
              status: "pending",
            },
          ],
        },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          id: "omp:ui:2",
          message: "Background task resumed",
        }),
      }),
    );
    const unsafeLaunchBaseline = events.length;
    session.emit({
      type: "extension_ui_request",
      id: "script-launch-url",
      method: "open_url",
      url: "https://safe.example.com/callback",
      launchUrl: "javascript:alert(1)",
    });
    session.emit({
      type: "extension_ui_request",
      id: "file-launch-url",
      method: "open_url",
      url: "https://safe.example.com/callback",
      launchUrl: "file:///private/oauth-token",
    });
    const unsafeLaunchItems = events
      .slice(unsafeLaunchBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "notification" ? [event.item] : [],
      );
    expect(unsafeLaunchItems).toHaveLength(2);
    expect(
      unsafeLaunchItems.every((item) => item.message === "https://safe.example.com/callback"),
    ).toBe(true);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    const turnId = turnIdFrom(await startPrompt(connection, events, "after-passive", "continue"));
    const terminal = await finishTurn(events, session, turnId);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("preserves configured credential values by default", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events, "default-output-open", "session-1", {
      API_TOKEN: "credential-secret",
      DEBUG: "1",
      NODE_ENV: "dev",
    });
    sessionAt(runtime).emit({
      type: "notice",
      level: "info",
      message: "credential-secret value 1 in dev",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          message: "credential-secret value 1 in dev",
        }),
      }),
    );
    await connection.close();
  });
});
