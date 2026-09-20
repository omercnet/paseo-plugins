import { describe, expect, test } from "vitest";
import type { OmpMessage } from "../server/provider/omp-rpc";
import {
  ALTERNATE_MODEL_PUBLIC_ID,
  createHarness,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("persists, lists, and resumes the same native session with bounded replay before ready", async () => {
    const runtime = new FakeOmpRuntime();
    const capabilities = [
      "prompt.message",
      "prompt.steer",
      "session.configure",
      "session.list",
      "session.persistence",
    ];
    const { connection, events } = await createHarness(
      runtime,
      new ManualScheduler(),
      capabilities,
    );
    runtime.sessionIds.push(NATIVE_SESSION_ID);
    await connection.send({
      type: "session.open",
      requestId: "new-persisted",
      sessionId: "fresh-session",
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
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "new-persisted",
    );
    const opened = events.find(
      (event) => event.type === "session.opened" && event.sessionId === "fresh-session",
    );
    expect(opened).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      }),
    );
    await connection.send({
      type: "session.close",
      requestId: "close-fresh",
      sessionId: "fresh-session",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-fresh",
    );

    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      title: "Persisted session",
      updatedAt: "2026-09-11T00:00:00.000Z",
    });
    await connection.send({ type: "sessions", requestId: "list", cwd: "/repo", limit: 10 });
    await events.waitFor((event) => event.type === "sessions" && event.requestId === "list");
    expect(events.at(-1)).toEqual({
      type: "sessions",
      requestId: "list",
      sessions: [
        {
          persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
          cwd: "/repo",
          title: "Persisted session",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    });

    runtime.nextHistoryMessages = Array.from(
      { length: 260 },
      (_, index): OmpMessage =>
        index % 2 === 0
          ? { role: "user", id: `history-${index}`, content: `message ${index}` }
          : {
              role: "assistant",
              responseId: index === 1 ? "replayed-response" : `history-${index}`,
              content: `message ${index}`,
            },
    );
    runtime.nextHistoryMessages.push(
      {
        role: "toolResult",
        toolCallId: "history-tool",
        toolName: "read",
        content: { content: [{ type: "text", text: "tool output" }] },
      },
      { role: "bashExecution", command: "pwd", output: "/repo\n", exitCode: 0 },
    );
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    const replayStart = events.length;
    await connection.send({
      type: "session.open",
      requestId: "resume-persisted",
      sessionId: "resumed-session",
      config: {
        cwd: "/repo",
        env: {},
        systemPrompt: "must not be reapplied",
        mcpServers: {},
        model: ALTERNATE_MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "high",
        settings: {},
        providerOptions: { params: { sessionDir: "/sessions/custom" } },
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "resume-persisted",
    );
    expect(runtime.sessionListRequests.at(-1)).toEqual({
      sessionId: NATIVE_SESSION_ID,
      cwd: "/repo",
      limit: 2,
      sessionDir: "/sessions/custom",
    });
    const replayEvents = events.slice(replayStart);
    const readyIndex = replayEvents.findIndex((event) => event.type === "session.ready");
    const timelineIndexes = replayEvents.flatMap((event, index) =>
      event.type === "timeline.item" ? [index] : [],
    );
    expect(Math.max(...timelineIndexes)).toBeLessThan(readyIndex);
    const timelineItems = replayEvents.flatMap((event) =>
      event.type === "timeline.item" ? [event.item] : [],
    );
    expect(
      timelineItems
        .slice(0, 4)
        .map((item) =>
          item.type === "user_message" || item.type === "assistant_message" ? item.text : null,
        ),
    ).toEqual(["message 0", "message 1", "message 2", "message 3"]);
    expect(timelineItems).toHaveLength(263);
    expect(new Set(timelineItems.map((item) => item.id)).size).toBe(262);
    expect(timelineItems).toContainEqual(
      expect.objectContaining({ type: "tool_call", name: "read", status: "completed" }),
    );
    expect(timelineItems).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "bashExecution",
        detail: expect.objectContaining({ type: "shell", command: "pwd", output: "/repo\n" }),
      }),
    );
    const liveTurn = turnIdFrom(
      await startPrompt(connection, events, "live-after-replay", "next", "resumed-session"),
    );
    const liveBaseline = events.length;
    sessionAt(runtime, 1).emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "replayed-response",
        content: "message 1",
      },
    });
    expect(events.slice(liveBaseline)).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "message 1" }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), liveTurn);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(runtime.starts[1]?.model).toBeUndefined();
    expect(runtime.starts[1]?.thinkingOption).toBeUndefined();
    expect(runtime.starts[1]?.systemPrompt).toBeUndefined();
    expect(sessionAt(runtime, 1).historyRequests).toBe(1);
    expect(replayEvents).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          thinkingOption: "medium",
        }),
      }),
    );
    sessionAt(runtime, 1).emit({ type: "process_exit", error: "restart persisted session" });
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    const recoveryTurn = turnIdFrom(
      await startPrompt(connection, events, "persisted-recovery", "continue", "resumed-session"),
    );
    expect(runtime.starts[2]).toEqual(
      expect.objectContaining({ resumeSessionId: NATIVE_SESSION_ID }),
    );
    expect(runtime.starts[2]?.systemPrompt).toBeUndefined();
    await finishTurn(events, sessionAt(runtime, 2), recoveryTurn);
    await connection.close();
  });
  test("replays failed assistant turns and completed tools from the persisted transcript", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.nextHistoryMessages = [{ role: "user", entryId: "user-1", content: "prompt" }];
    const toolCalls = Array.from({ length: 79 }, (_, index) => ({
      type: "toolCall" as const,
      id: `call-${index}`,
      name: "read",
      arguments: { path: `file-${index}.txt` },
    }));
    const assistantContent = [
      ...toolCalls.slice(0, 64),
      ...Array.from({ length: 6 }, (_, index) => ({
        type: "text" as const,
        text: `partial-${index}`,
      })),
      ...Array.from({ length: 22 }, (_, index) => ({
        type: "thinking" as const,
        thinking: `thought-${index}`,
      })),
      ...toolCalls.slice(64),
    ];
    runtime.persistedSessionMessages = {
      sessionFile: "/sessions/root.jsonl",
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 4_096,
      messages: [
        { role: "user", entryId: "user-1", content: "prompt" },
        {
          role: "assistant",
          entryId: "assistant-failed",
          content: assistantContent,
          stopReason: "error",
          errorMessage: "provider failed",
        },
        ...toolCalls.map(
          (call, index): OmpMessage => ({
            role: "toolResult",
            entryId: `tool-${index}`,
            toolCallId: call.id,
            toolName: call.name,
            content: { content: [{ type: "text", text: `completed result ${index}` }] },
          }),
        ),
      ],
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "failed-turn-replay",
      sessionId: "failed-turn-session",
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
      (event) => event.type === "session.ready" && event.requestId === "failed-turn-replay",
    );

    expect(runtime.persistedSessionRequests).toEqual([
      {
        sessionFile: "/sessions/root.jsonl",
        sessionId: NATIVE_SESSION_ID,
        cwd: "/repo",
      },
    ]);
    expect(sessionAt(runtime).historyRequests).toBe(0);
    const timelineItems = events.flatMap((event) =>
      event.type === "timeline.item" ? [event.item] : [],
    );
    expect(timelineItems).toContainEqual(
      expect.objectContaining({
        type: "assistant_message",
        text: expect.stringContaining("partial-0"),
      }),
    );
    expect(timelineItems).toContainEqual(
      expect.objectContaining({ type: "reasoning", text: expect.stringContaining("thought-21") }),
    );
    const completedTools = timelineItems.filter(
      (item) => item.type === "tool_call" && item.status === "completed",
    );
    expect(completedTools).toHaveLength(79);
    expect(completedTools).toEqual(
      toolCalls.map((_, index) =>
        expect.objectContaining({
          detail: expect.objectContaining({ type: "read", filePath: `file-${index}.txt` }),
        }),
      ),
    );
    await connection.close();
  });

  test("replays developer context without publishing a false user turn", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.persistedSessionMessages = {
      sessionFile: "/sessions/root.jsonl",
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 512,
      messages: [
        { role: "user", entryId: "user", content: "visible question" },
        { role: "developer", entryId: "developer", content: "private harness context" },
        { role: "assistant", entryId: "assistant", content: "visible answer" },
      ],
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "developer-replay",
      sessionId: "developer-replay-session",
      config: { cwd: "/repo", env: {}, mcpServers: {}, mode: "full", settings: {}, persist: true },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "developer-replay",
    );

    const textItems = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "user_message" || event.item.type === "assistant_message")
        ? [event.item.text]
        : [],
    );
    expect(textItems).toEqual(["visible question", "visible answer"]);
    expect(JSON.stringify(events)).not.toContain("private harness context");
    await connection.close();
  });

  test("warns once while replaying a transcript with unavailable images", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.persistedSessionMessages = {
      sessionFile: "/sessions/root.jsonl",
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 4_096,
      messages: [
        { role: "user", entryId: "user-1", content: "prompt" },
        { role: "assistant", entryId: "assistant-1", content: "[Image unavailable]" },
      ],
      imageReplayWarning: true,
    };
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "image-replay-warning",
      sessionId: "image-replay-session",
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
      (event) => event.type === "session.ready" && event.requestId === "image-replay-warning",
    );

    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" && event.item.id === "omp:replay-image-unavailable",
      ),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "notification",
          level: "warning",
          message: "OMP skipped one or more unavailable images while replaying this session.",
        }),
      }),
    ]);
    expect(sessionAt(runtime).historyRequests).toBe(0);
    await connection.close();
  });

  test("warns before falling back to filtered RPC history", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      transcriptFile: "/sessions/root.jsonl",
    });
    runtime.persistedSessionError = new Error("unreadable transcript");
    runtime.nextHistoryMessages = [{ role: "user", entryId: "user-1", content: "prompt" }];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "filtered-history-fallback",
      sessionId: "filtered-history-session",
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
      (event) => event.type === "session.ready" && event.requestId === "filtered-history-fallback",
    );

    expect(sessionAt(runtime).historyRequests).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "error",
          message:
            "OMP could not read its complete persisted transcript; displayed history may be incomplete.",
        }),
      }),
    );
    await connection.close();
  });
});
