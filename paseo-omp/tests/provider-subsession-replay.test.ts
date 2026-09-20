import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import type { OmpMessage } from "../server/provider/omp-rpc";
import { OmpSubsessionProjector } from "../server/provider/subsessions";
import {
  createHarness,
  FakeOmpRuntime,
  FakeOmpSession,
  ManualScheduler,
  NATIVE_SESSION_ID,
  sessionAt,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("replays cold child transcripts once with stable persisted identity", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    const configureReplay = () => {
      runtime.nextHistoryMessages = [
        {
          role: "assistant",
          responseId: "root-task-message",
          content: [
            {
              type: "toolCall",
              id: "replayed-task",
              name: "task",
              arguments: { agent: "scout", task: "inspect" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "replayed-task",
          toolName: "task",
          content: [{ type: "text", text: "done" }],
          details: {
            results: [],
            progress: [
              { index: 0, id: "native-replayed-child", agent: "scout", status: "pending" },
            ],
          },
        },
      ];
      runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0native-replayed-child", {
        sessionFile: "/sessions/root/native-replayed-child.jsonl",
        nativeSessionId: "01a0915d-e337-7009-af23-7382348f59b5",
        byteLength: 42,
        messages: [
          { role: "user", entryId: "child-user", content: "inspect" },
          { role: "assistant", responseId: "child-response", content: "replayed child output" },
        ],
      });
    };
    configureReplay();
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    const openReplay = async (requestId: string, sessionId: string) => {
      const baseline = events.length;
      await connection.send({
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
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === requestId,
      );
      const replay = events.slice(baseline);
      const childOpened = replay.find(
        (event) => event.type === "session.opened" && event.parentSessionId === sessionId,
      );
      if (childOpened?.type !== "session.opened") throw new Error("Missing replayed child");
      expect(childOpened.toolCallId).toBe("replayed-task");
      expect(
        replay.filter(
          (event) =>
            event.type === "timeline.item" &&
            event.sessionId === childOpened.sessionId &&
            event.item.type === "assistant_message",
        ),
      ).toHaveLength(1);
      expect(
        replay.filter(
          (event) => event.type === "session.opened" && event.sessionId === childOpened.sessionId,
        ),
      ).toHaveLength(1);
      return childOpened.sessionId;
    };
    const firstChildId = await openReplay("replay-one", "resumed-one");
    await connection.send({
      type: "session.close",
      requestId: "close-replay-one",
      sessionId: "resumed-one",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-replay-one",
    );
    configureReplay();
    const secondChildId = await openReplay("replay-two", "resumed-two");
    expect(secondChildId).toBe(firstChildId);
    expect(runtime.persistedSubagentRequests).toEqual([
      { parentSessionFile: "/sessions/root.jsonl", childTranscriptId: "native-replayed-child" },
      { parentSessionFile: "/sessions/root.jsonl", childTranscriptId: "native-replayed-child" },
    ]);
    expect(runtime.sessions.every((session) => session.subagentMessages.size === 0)).toBe(true);
    await connection.close();
  });

  test("attaches snapshot children using validated nested transcript paths", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "nested-snapshot-child",
        index: 1,
        agent: "nested snapshot",
        status: "completed",
        lastUpdate: 2,
      },
      {
        id: "parent-snapshot-child",
        index: 0,
        agent: "parent snapshot",
        status: "completed",
        lastUpdate: 1,
      },
    ];
    runtime.nextSubagentMessages.set("parent-snapshot-child", {
      sessionFile: "/sessions/root/parent-snapshot-child.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    runtime.nextSubagentMessages.set("nested-snapshot-child", {
      sessionFile: "/sessions/root/parent-snapshot-child/nested-snapshot-child.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "nested-snapshot-replay",
      sessionId: "nested-snapshot-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "nested-snapshot-replay",
    );

    const parent = events.find(
      (event) => event.type === "session.opened" && event.title === "parent snapshot",
    );
    const nested = events.find(
      (event) => event.type === "session.opened" && event.title === "nested snapshot",
    );
    if (parent?.type !== "session.opened" || nested?.type !== "session.opened") {
      throw new Error("Missing snapshot child sessions");
    }
    expect(parent.parentSessionId).toBe("nested-snapshot-root");
    expect(nested.parentSessionId).toBe(parent.sessionId);

    await connection.close();
  });
  test("prefers direct snapshot transcripts and isolates an oversized sibling", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "direct-child",
        index: 0,
        agent: "direct",
        status: "completed",
        sessionFile: "/sessions/root/direct-child.jsonl",
        lastUpdate: 1,
      },
      {
        id: "oversized-child",
        index: 1,
        agent: "oversized",
        status: "completed",
        sessionFile: "/sessions/root/oversized-child.jsonl",
        lastUpdate: 2,
      },
      {
        id: "fallback-child",
        index: 2,
        agent: "fallback",
        status: "completed",
        sessionFile: "/sessions/root/fallback-child.jsonl",
        lastUpdate: 3,
      },
    ];
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0direct-child", {
      sessionFile: "/sessions/root/direct-child.jsonl",
      nativeSessionId: "native_direct_child",
      byteLength: 100,
      messages: [{ role: "assistant", responseId: "direct-output", content: "direct output" }],
    });
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0oversized-child", {
      sessionFile: "/sessions/root/oversized-child.jsonl",
      nativeSessionId: "native_oversized_child",
      byteLength: 16 * 1024 * 1024,
      messages: Array.from({ length: 3_100 }, (_, index) => ({
        role: "assistant" as const,
        responseId: `oversized-${index}`,
        content: Array.from({ length: 64 }, () => ({ type: "text" as const, text: "x" })),
      })),
    });
    runtime.nextSubagentMessages.set("fallback-child", {
      sessionFile: "/sessions/root/fallback-child.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [{ role: "assistant", responseId: "fallback-output", content: "fallback output" }],
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "direct-child-replay",
      sessionId: "direct-child-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "direct-child-replay",
    );

    expect(sessionAt(runtime).subagentMessageRequests).toEqual([{ subagentId: "fallback-child" }]);
    expect(runtime.persistedSubagentRequests).toEqual([
      {
        parentSessionFile: "/sessions/root.jsonl",
        childTranscriptId: "direct-child",
        sessionFile: "/sessions/root/direct-child.jsonl",
      },
      {
        parentSessionFile: "/sessions/root.jsonl",
        childTranscriptId: "oversized-child",
        sessionFile: "/sessions/root/oversized-child.jsonl",
      },
      {
        parentSessionFile: "/sessions/root.jsonl",
        childTranscriptId: "fallback-child",
        sessionFile: "/sessions/root/fallback-child.jsonl",
      },
    ]);
    const direct = events.find(
      (event) => event.type === "session.opened" && event.title === "direct",
    );
    const oversized = events.find(
      (event) => event.type === "session.opened" && event.title === "oversized",
    );
    const fallback = events.find(
      (event) => event.type === "session.opened" && event.title === "fallback",
    );
    if (
      direct?.type !== "session.opened" ||
      oversized?.type !== "session.opened" ||
      fallback?.type !== "session.opened"
    ) {
      throw new Error("Missing direct snapshot children");
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: direct.sessionId,
        item: expect.objectContaining({ type: "assistant_message", text: "direct output" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: fallback.sessionId,
        item: expect.objectContaining({ type: "assistant_message", text: "fallback output" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: oversized.sessionId,
        state: "failed",
        error: { message: "OMP subagent history is unavailable or incomplete" },
      }),
    );
    expect(events.some((event) => event.type === "request.failed")).toBe(false);
    await connection.close();
  });

  test("parents an oversized nested snapshot before failing only that child", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "oversized-nested-snapshot",
        index: 1,
        agent: "oversized nested",
        status: "running",
        lastUpdate: 2,
      },
      {
        id: "oversized-parent-snapshot",
        index: 0,
        agent: "oversized parent",
        status: "completed",
        lastUpdate: 1,
      },
    ];
    runtime.nextSubagentMessages.set("oversized-parent-snapshot", {
      sessionFile: "/sessions/root/oversized-parent-snapshot.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    runtime.nextSubagentMessages.set("oversized-nested-snapshot", {
      sessionFile: "/sessions/root/oversized-parent-snapshot/oversized-nested-snapshot.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: Array.from({ length: 3_100 }, (_, index) => ({
        role: "assistant" as const,
        responseId: `oversized-nested-${index}`,
        content: Array.from({ length: 64 }, () => ({ type: "text" as const, text: "x" })),
      })),
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "oversized-nested-snapshot-replay",
      sessionId: "oversized-nested-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.ready" && event.requestId === "oversized-nested-snapshot-replay",
    );

    const parent = events.find(
      (event) => event.type === "session.opened" && event.title === "oversized parent",
    );
    const nested = events.find(
      (event) => event.type === "session.opened" && event.title === "oversized nested",
    );
    if (parent?.type !== "session.opened" || nested?.type !== "session.opened") {
      throw new Error("Missing oversized snapshot child sessions");
    }
    expect(nested.parentSessionId).toBe(parent.sessionId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: nested.sessionId,
        state: "failed",
        error: { message: "OMP subagent history is unavailable or incomplete" },
      }),
    );
    expect(events.some((event) => event.type === "request.failed")).toBe(false);
    await connection.close();
  });

  test("keeps snapshot terminal state over stale buffered running progress", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "completed-snapshot-child",
        index: 0,
        agent: "completed snapshot",
        status: "completed",
        lastUpdate: 1,
      },
    ];
    runtime.nextSubagentMessages.set("completed-snapshot-child", {
      sessionFile: "/sessions/root/completed-snapshot-child.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.subagentsGate = gate.promise;
      session.subagentsObserved = observed.resolve;
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "stale-progress-replay",
      sessionId: "stale-progress-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    sessionAt(runtime).emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "completed snapshot",
        task: "stale update",
        progress: { id: "completed-snapshot-child", status: "started" },
      },
    });
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "stale-progress-replay",
    );

    const child = events.find(
      (event) => event.type === "session.opened" && event.title === "completed snapshot",
    );
    if (child?.type !== "session.opened") throw new Error("Missing completed snapshot child");
    const turns = events.flatMap((event) =>
      event.type === "session.turn" && event.sessionId === child.sessionId ? [event] : [],
    );
    expect(turns.filter((event) => event.state === "started")).toHaveLength(1);
    expect(turns.filter((event) => event.state === "completed")).toHaveLength(1);
    await connection.close();
  });

  test("fail-closes a buffered child selected for advisory eviction", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "evicted-snapshot-child",
        index: 0,
        agent: "evicted snapshot",
        status: "running",
        lastUpdate: 1,
      },
    ];
    runtime.nextSubagentMessages.set("evicted-snapshot-child", {
      sessionFile: "/sessions/root/evicted-snapshot-child.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.subagentsGate = gate.promise;
      session.subagentsObserved = observed.resolve;
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "evicted-snapshot-replay",
      sessionId: "evicted-snapshot-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    const session = sessionAt(runtime);
    session.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "evicted snapshot",
        task: "advisory",
        progress: { id: "evicted-snapshot-child", status: "started" },
      },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "evicted-snapshot-child",
        agent: "evicted snapshot",
        status: "started",
        index: 0,
      },
    });
    session.emit({
      type: "subagent_event",
      payload: {
        id: "evicted-snapshot-child",
        event: {
          type: "message_end",
          message: { role: "assistant", responseId: "evicted-output", content: "must not leak" },
        },
      },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "evicted-snapshot-child",
        agent: "evicted snapshot",
        status: "completed",
        index: 0,
      },
    });
    for (let index = 1; index < 1_024; index += 1) {
      session.emit({
        type: "subagent_progress",
        payload: {
          index,
          agent: "scout",
          task: "advisory",
          progress: { id: `advisory-child-${index}`, status: "started" },
        },
      });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "replacement-child", agent: "replacement", status: "completed", index: 0 },
    });
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "evicted-snapshot-replay",
    );

    const evicted = events.find(
      (event) => event.type === "session.opened" && event.title === "evicted snapshot",
    );
    if (evicted?.type !== "session.opened") throw new Error("Missing evicted snapshot child");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: evicted.sessionId,
        state: "failed",
        error: { message: "OMP subagent history is unavailable or incomplete" },
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === evicted.sessionId &&
          event.item.type === "assistant_message",
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("fails a snapshot child whose buffered event exceeded replay bounds", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    runtime.nextSubagents = [
      {
        id: "oversized-buffered-snapshot",
        index: 0,
        agent: "oversized buffered snapshot",
        status: "running",
        lastUpdate: 1,
      },
    ];
    runtime.nextSubagentMessages.set("oversized-buffered-snapshot", {
      sessionFile: "/sessions/root/oversized-buffered-snapshot.jsonl",
      fromByte: 0,
      nextByte: 1,
      reset: false,
      messages: [],
    });
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.subagentsGate = gate.promise;
      session.subagentsObserved = observed.resolve;
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "oversized-buffered-snapshot-replay",
      sessionId: "oversized-buffered-snapshot-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    sessionAt(runtime).emit({
      type: "subagent_event",
      payload: {
        id: "oversized-buffered-snapshot",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            responseId: "oversized-buffered-output",
            content: "x".repeat(4 * 1024 * 1024),
          },
        },
      },
    });
    gate.resolve();
    await events.waitFor(
      (event) =>
        event.type === "session.ready" && event.requestId === "oversized-buffered-snapshot-replay",
    );

    const child = events.find(
      (event) => event.type === "session.opened" && event.title === "oversized buffered snapshot",
    );
    if (child?.type !== "session.opened") throw new Error("Missing oversized buffered child");
    const turns = events.flatMap((event) =>
      event.type === "session.turn" && event.sessionId === child.sessionId ? [event] : [],
    );
    expect(turns.filter((event) => event.state === "started")).toHaveLength(1);
    expect(turns.filter((event) => event.state === "failed")).toEqual([
      expect.objectContaining({
        error: { message: "OMP subagent history is unavailable or incomplete" },
      }),
    ]);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("retains required child events for all 1024 children at buffer saturation", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.subagentsGate = gate.promise;
      session.subagentsObserved = observed.resolve;
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "required-event-saturation",
      sessionId: "required-event-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    const session = sessionAt(runtime);
    for (let index = 0; index < 1_024; index += 1) {
      const id = `saturated-child-${index}`;
      session.emit({
        type: "subagent_lifecycle",
        payload: { id, agent: "worker", status: "started", index },
      });
      session.emit({
        type: "subagent_event",
        payload: {
          id,
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              responseId: `response-${index}`,
              content: `output-${index}`,
            },
          },
        },
      });
      session.emit({
        type: "subagent_lifecycle",
        payload: { id, agent: "worker", status: "completed", index },
      });
    }
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "required-event-saturation",
    );

    expect(
      events.filter(
        (event) =>
          event.type === "session.opened" && event.parentSessionId === "required-event-root",
      ),
    ).toHaveLength(1_024);
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId.startsWith("omp:subsession:") &&
          event.item.type === "assistant_message",
      ),
    ).toHaveLength(1_024);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId.startsWith("omp:subsession:") &&
          event.state === "completed",
      ),
    ).toHaveLength(1_024);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("keeps omitted child tracking bounded after more than 1024 unique overflows", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [];
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.subagentsGate = gate.promise;
      session.subagentsObserved = observed.resolve;
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "omitted-child-overflow",
      sessionId: "omitted-child-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    const session = sessionAt(runtime);
    for (let index = 0; index < 1_024; index += 1) {
      session.emit({
        type: "subagent_lifecycle",
        payload: { id: `retained-child-${index}`, agent: "retained", status: "started", index },
      });
    }
    for (let index = 0; index < 1_025; index += 1) {
      session.emit({
        type: "subagent_lifecycle",
        payload: { id: `omitted-child-${index}`, agent: "omitted", status: "completed", index },
      });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "omitted-child-0", agent: "omitted", status: "completed", index: 0 },
    });
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "omitted-child-overflow",
    );

    expect(
      events.some(
        (event) =>
          event.type === "session.opened" &&
          (event.title === "retained" || event.title === "omitted"),
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("does not restart existing children after global omission saturation", async () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpSubsessionProjector(
      "saturated-root",
      "saturated-root-identity",
      "/sessions/root.jsonl",
      "/repo",
      (event) => events.push(event),
      new ManualScheduler(),
      () => undefined,
      [],
    );
    projector.handle({
      type: "subagent_lifecycle",
      payload: { id: "existing-child", agent: "existing", status: "started", index: 0 },
    });
    const session = new FakeOmpSession();
    session.subagents = [
      {
        id: "existing-child",
        index: 0,
        agent: "existing",
        status: "started",
        lastUpdate: 1,
      },
    ];
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.subagentsGate = gate.promise;
    session.subagentsObserved = observed.resolve;
    const replay = projector.replay(
      [],
      session,
      new FakeOmpRuntime(),
      new AbortController().signal,
    );
    await observed.promise;
    for (let index = 0; index < 1_023; index += 1) {
      projector.handle({
        type: "subagent_lifecycle",
        payload: { id: `buffered-child-${index}`, agent: "buffered", status: "started", index },
      });
    }
    for (let index = 0; index < 1_025; index += 1) {
      projector.handle({
        type: "subagent_lifecycle",
        payload: { id: `omitted-overflow-${index}`, agent: "omitted", status: "completed", index },
      });
    }
    gate.resolve();
    await replay;

    const child = events.find(
      (event) => event.type === "session.opened" && event.title === "existing",
    );
    if (child?.type !== "session.opened") throw new Error("Missing existing child session");
    const turns = events.flatMap((event) =>
      event.type === "session.turn" && event.sessionId === child.sessionId ? [event] : [],
    );
    expect(turns.map((event) => event.state)).toEqual(["started", "failed"]);
    expect(projector.hasActiveChildren()).toBe(false);
    projector.close();
  });

  test("continues root recovery when one persisted child transcript is unavailable", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "missing-task", name: "task", arguments: { task: "missing" } },
          {
            type: "toolCall",
            id: "available-task",
            name: "task",
            arguments: { task: "available" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "missing-task",
        toolName: "task",
        content: [],
        details: { results: [{ id: "missing-child", agent: "missing" }] },
      },
      {
        role: "toolResult",
        toolCallId: "available-task",
        toolName: "task",
        content: [],
        details: { results: [{ id: "available-child", agent: "available" }] },
      },
    ];
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0available-child", {
      sessionFile: "/sessions/root/available-child.jsonl",
      nativeSessionId: "native_available_child",
      byteLength: 1,
      messages: [
        { role: "assistant", responseId: "available-response", content: "available output" },
      ],
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "partial-child-replay",
      sessionId: "partial-child-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "partial-child-replay",
    );

    const missing = events.find(
      (event) => event.type === "session.opened" && event.title === "missing",
    );
    const available = events.find(
      (event) => event.type === "session.opened" && event.title === "available",
    );
    if (missing?.type !== "session.opened" || available?.type !== "session.opened") {
      throw new Error("Missing reconstructed child sessions");
    }
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === missing.sessionId &&
          event.state === "failed",
      ),
    ).toEqual([
      expect.objectContaining({
        error: { message: "OMP subagent history is unavailable or incomplete" },
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: available.sessionId,
        item: expect.objectContaining({ type: "assistant_message", text: "available output" }),
      }),
    );
    expect(events.some((event) => event.type === "request.failed")).toBe(false);
    await connection.close();
  });

  test("drops replay-time progress overflow while preserving terminal child lifecycle", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "anchor-task", name: "task", arguments: { task: "wait" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "anchor-task",
        toolName: "task",
        content: [],
        details: { results: [{ id: "anchor-child", agent: "anchor" }] },
      },
    ];
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.persistedSubagentGates.set("/sessions/root.jsonl\0anchor-child", gate.promise);
    runtime.persistedSubagentObserved = (key) => {
      if (key.endsWith("\0anchor-child")) observed.resolve();
    };
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0anchor-child", {
      sessionFile: "/sessions/root/anchor-child.jsonl",
      nativeSessionId: "native_anchor_child",
      byteLength: 1,
      messages: [],
    });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    void connection.send({
      type: "session.open",
      requestId: "progress-overflow-replay",
      sessionId: "progress-overflow-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    const session = sessionAt(runtime);
    for (let index = 0; index < 1_100; index += 1) {
      session.emit({
        type: "subagent_progress",
        payload: {
          index,
          agent: "scout",
          task: "working",
          progress: { id: `progress-${index}`, status: "started" },
        },
      });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "anchor-child", agent: "anchor", status: "completed", index: 0 },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "terminal-before-progress",
        agent: "terminal first",
        status: "completed",
        index: 1,
      },
    });
    session.emit({
      type: "subagent_progress",
      payload: {
        index: 1,
        agent: "terminal first",
        task: "stale",
        progress: { id: "terminal-before-progress", status: "started" },
      },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "ordered-child", agent: "ordered", status: "started", index: 2 },
    });
    session.emit({
      type: "subagent_event",
      payload: {
        id: "ordered-child",
        event: {
          type: "message_end",
          message: { role: "assistant", responseId: "ordered-output", content: "kept output" },
        },
      },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "ordered-child", agent: "ordered", status: "completed", index: 2 },
    });
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "progress-overflow-replay",
    );

    const anchor = events.find(
      (event) => event.type === "session.opened" && event.title === "anchor",
    );
    if (anchor?.type !== "session.opened") throw new Error("Missing anchor child session");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: anchor.sessionId,
        state: "completed",
      }),
    );
    const terminalFirst = events.find(
      (event) => event.type === "session.opened" && event.title === "terminal first",
    );
    const ordered = events.find(
      (event) => event.type === "session.opened" && event.title === "ordered",
    );
    if (terminalFirst?.type !== "session.opened" || ordered?.type !== "session.opened") {
      throw new Error("Missing buffered child sessions");
    }
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === terminalFirst.sessionId &&
          event.state === "started",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: terminalFirst.sessionId,
        state: "completed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: ordered.sessionId,
        item: expect.objectContaining({ type: "assistant_message", text: "kept output" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.turn",
        sessionId: ordered.sessionId,
        state: "completed",
      }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("cancels recursive child replay at the shared deadline without late publication", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "timed-task",
            name: "task",
            arguments: { task: "wait" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "timed-task",
        toolName: "task",
        content: [],
        details: { results: [{ id: "timed-child" }] },
      },
    ];
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.persistedSubagentGates.set(
      "/sessions/root/timed-child.jsonl\0timed-grandchild",
      gate.promise,
    );
    runtime.persistedSubagentObserved = (key) => {
      if (key.endsWith("\0timed-grandchild")) observed.resolve();
    };
    runtime.persistedSubagentMessages.set("/sessions/root.jsonl\0timed-child", {
      sessionFile: "/sessions/root/timed-child.jsonl",
      nativeSessionId: "01a0915d-e337-7009-af23-7382348f59b6",
      byteLength: 10,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "timed-nested-task",
              name: "task",
              arguments: { task: "nested wait" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "timed-nested-task",
          toolName: "task",
          content: [],
          details: { results: [{ id: "timed-grandchild" }] },
        },
      ],
    });
    runtime.persistedSubagentMessages.set("/sessions/root/timed-child.jsonl\0timed-grandchild", {
      sessionFile: "/sessions/root/timed-child/timed-grandchild.jsonl",
      nativeSessionId: "01a0915d-e337-7009-af23-7382348f59b8",
      byteLength: 10,
      messages: [{ role: "assistant", responseId: "too-late", content: "too late" }],
    });
    const { connection, events } = await createHarness(
      runtime,
      new ManualScheduler(),
      ["prompt.message", "session.persistence", "session.subsession"],
      5,
    );
    await connection.send({
      type: "session.open",
      requestId: "timed-replay",
      sessionId: "timed-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await observed.promise;
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "timed-replay",
    );
    const childEventCount = events.filter(
      (event) => "sessionId" in event && event.sessionId.startsWith("omp:subsession:"),
    ).length;
    expect(childEventCount).toBeGreaterThan(0);
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      events.filter(
        (event) => "sessionId" in event && event.sessionId.startsWith("omp:subsession:"),
      ),
    ).toHaveLength(childEventCount);
    expect(
      events.some((event) => event.type === "session.ready" && event.requestId === "timed-replay"),
    ).toBe(false);
    await connection.close();
  });

  test("bounds root and child replay with one cumulative byte and node budget", async () => {
    const bytePayload = "x".repeat(1024 * 1024);
    const oversizedCases: Array<{ id: string; messages: OmpMessage[] }> = [
      {
        id: "bytes",
        messages: Array.from({ length: 65 }, (_, index) => ({
          role: "assistant",
          responseId: `bytes-${index}`,
          content: bytePayload,
        })),
      },
      {
        id: "nodes",
        messages: Array.from({ length: 3_100 }, (_, index) => ({
          role: "assistant",
          responseId: `nodes-${index}`,
          content: Array.from({ length: 64 }, () => ({ type: "text", text: "x" })),
        })),
      },
    ];
    for (const oversized of oversizedCases) {
      const runtime = new FakeOmpRuntime();
      runtime.descriptors.push({
        id: NATIVE_SESSION_ID,
        cwd: "/repo",
        transcriptFile: "/sessions/root.jsonl",
      });
      runtime.nextHistoryMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `budget-task-${oversized.id}`,
              name: "task",
              arguments: { task: "overflow" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: `budget-task-${oversized.id}`,
          toolName: "task",
          content: [],
          details: { results: [{ id: `budget-child-${oversized.id}` }] },
        },
      ];
      runtime.persistedSubagentMessages.set(`/sessions/root.jsonl\0budget-child-${oversized.id}`, {
        sessionFile: `/sessions/root/budget-child-${oversized.id}.jsonl`,
        nativeSessionId: `native_budget_${oversized.id}`,
        byteLength: 1,
        messages: oversized.messages,
      });
      const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
        "prompt.message",
        "session.persistence",
        "session.subsession",
      ]);
      await connection.send({
        type: "session.open",
        requestId: `budget-${oversized.id}`,
        sessionId: `budget-root-${oversized.id}`,
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
        (event) => event.type === "session.ready" && event.requestId === `budget-${oversized.id}`,
      );
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.state === "failed" &&
            event.error?.message === "OMP subagent history is unavailable or incomplete",
        ),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === "request.failed")).toBe(false);
      await connection.close();
    }
  });

  test("derives pending cold async outcomes from terminal yield payloads", async () => {
    for (const { outcome, yieldStatus } of [
      { outcome: "canceled" as const, yieldStatus: "aborted" },
      { outcome: "failed" as const, yieldStatus: "failed" },
      { outcome: "completed" as const, yieldStatus: "success" },
    ]) {
      const runtime = new FakeOmpRuntime();
      runtime.descriptors.push({
        id: NATIVE_SESSION_ID,
        cwd: "/repo",
        transcriptFile: "/sessions/root.jsonl",
      });
      runtime.nextHistoryMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `pending-${outcome}-task`,
              name: "task",
              arguments: { task: outcome },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: `pending-${outcome}-task`,
          toolName: "task",
          content: [],
          details: {
            results: [],
            progress: [
              {
                index: 0,
                id: `pending-${outcome}-child`,
                agent: "scout",
                status: "pending",
              },
            ],
          },
        },
      ];
      runtime.persistedSubagentMessages.set(`/sessions/root.jsonl\0pending-${outcome}-child`, {
        sessionFile: `/sessions/root/pending-${outcome}-child.jsonl`,
        nativeSessionId: `native_pending_${outcome}`,
        byteLength: 1,
        messages: [
          {
            role: "assistant",
            responseId: `pending-${outcome}-response`,
            content: `${outcome} output`,
            stopReason: "stop",
          },
          {
            role: "toolResult",
            toolCallId: `pending-${outcome}-yield`,
            toolName: "yield",
            content: [{ type: "text", text: "Result submitted." }],
            details: { status: yieldStatus },
          },
        ],
      });
      const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
        "prompt.message",
        "session.persistence",
        "session.subsession",
      ]);
      await connection.send({
        type: "session.open",
        requestId: `pending-${outcome}-open`,
        sessionId: `pending-${outcome}-root`,
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
        (event) => event.type === "session.ready" && event.requestId === `pending-${outcome}-open`,
      );
      const child = events.find(
        (event) =>
          event.type === "session.opened" && event.parentSessionId === `pending-${outcome}-root`,
      );
      if (child?.type !== "session.opened") throw new Error("Missing pending history child");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.turn",
          sessionId: child.sessionId,
          state: outcome,
        }),
      );
      await connection.close();
    }
  });
});
