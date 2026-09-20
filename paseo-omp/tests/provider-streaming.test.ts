import { describe, expect, test } from "vitest";
import { transformOmpImageToolItem } from "../shared/provider-image";
import {
  createHarness,
  FakeOmpRuntime,
  finishTurn,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("coalesces streams, preserves tool snapshots, and resets IDs between turns", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const firstResult = await startPrompt(connection, events, "client-1", "hello");
    const firstTurnId = turnIdFrom(firstResult);
    const session = sessionAt(runtime);
    session.branchMessages = [{ entryId: "entry-user-1", text: "hello" }];
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "client-1",
    );

    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-main" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Think" },
          { type: "text", text: "Hel" },
        ],
        responseId: "response-main",
      },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking" },
          { type: "text", text: "Hello" },
        ],
        responseId: "response-main",
      },
    });
    expect(
      events.some(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toBe(false);
    await scheduler.flush();
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking more" },
          { type: "text", text: "Hello world" },
        ],
        responseId: "response-main",
      },
    });
    await scheduler.flush();

    session.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "file.ts" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      partialResult: { output: "partial" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { output: "complete" },
    });
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-after-tool" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "After tool" }],
        responseId: "response-after-tool",
      },
    });
    const firstTerminal = await finishTurn(events, session, firstTurnId);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    const firstAssistant = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    const firstReasoning = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "reasoning",
    );
    expect(firstAssistant).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Hello" }) }),
    );
    expect(firstReasoning).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Thinking more" }) }),
    );
    expect(firstTerminal).toEqual(expect.objectContaining({ state: "completed" }));
    const assistantSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(assistantSnapshots.map((item) => item.text)).toEqual([
      "Hello",
      "Hello world",
      "After tool",
    ]);
    const firstStreamSnapshots = assistantSnapshots.filter(
      (item) => item.text === "Hello" || item.text === "Hello world",
    );
    expect(firstStreamSnapshots.map((item) => item.id)).toEqual([
      "omp:assistant:1:W-GOZ8cyzNX6:content:1:text",
      "omp:assistant:1:W-GOZ8cyzNX6:content:1:text",
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === firstTurnId &&
          event.state !== "started",
      ),
    ).toHaveLength(1);
    const toolSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
    );
    expect(toolSnapshots).toEqual([
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts" },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts", content: "partial" },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts", content: "complete" },
        status: "completed",
        error: null,
      },
    ]);

    const secondResult = await startPrompt(connection, events, "client-2", "again");
    const secondTurnId = turnIdFrom(secondResult);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-again" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Again" }],
        responseId: "response-again",
      },
    });
    await finishTurn(events, session, secondTurnId);
    const assistantIds = events
      .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
      .map((event) => (event.type === "timeline.item" ? event.item.id : ""));
    expect(new Set(assistantIds).size).toBe(3);
    await connection.close();
  });

  test("keeps multiple native assistant messages distinct within one turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);

    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-1", id: "generic-id" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First" },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        responseId: "response-1",
        id: "generic-id",
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        responseId: "response-1",
        id: "generic-id",
      },
    });
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-2", id: "generic-id" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second" },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
        responseId: "response-2",
        id: "generic-id",
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
        responseId: "response-2",
        id: "generic-id",
      },
    });
    await finishTurn(events, session, turnId);

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    const firstFinal = assistantItems.findLast((item) => item.text === "First");
    const secondFinal = assistantItems.findLast((item) => item.text === "Second");
    if (!firstFinal || !secondFinal) throw new Error("Expected final assistant snapshots");
    expect(new Set(assistantItems.map((item) => item.messageId))).toEqual(
      new Set([firstFinal.messageId, secondFinal.messageId]),
    );
    expect(
      assistantItems
        .filter((item) => item.messageId === firstFinal.messageId)
        .every((item) => item.id === firstFinal.id),
    ).toBe(true);
    expect(
      assistantItems
        .filter((item) => item.messageId === secondFinal.messageId)
        .every((item) => item.id === secondFinal.id),
    ).toBe(true);
    expect(firstFinal.text).toBe("First");
    expect(secondFinal.text).toBe("Second");
    expect(assistantItems.some((item) => item.id.includes("generic-id"))).toBe(false);
    await connection.close();
  });

  test("keeps repeated and adversarial native assistant identities collision free", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    const emitAssistant = async (responseId: string, text: string) => {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
        message: {
          role: "assistant",
          responseId,
          content: [{ type: "text", text }],
        },
      });
      await scheduler.flush();
    };

    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "identity-1", "first"));
    await emitAssistant("x", "First");
    await finishTurn(events, session, firstTurnId);

    const adversarialTurnId = turnIdFrom(
      await startPrompt(connection, events, "identity-2", "adversarial"),
    );
    await emitAssistant("x:occurrence:2", "Adversarial");
    await finishTurn(events, session, adversarialTurnId);

    const repeatedTurnId = turnIdFrom(
      await startPrompt(connection, events, "identity-3", "repeated"),
    );
    await emitAssistant("x", "Third draft");
    await emitAssistant("x", "Third final");
    await finishTurn(events, session, repeatedTurnId);

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    const firstFinal = assistantItems.findLast((item) => item.text === "First");
    const adversarialFinal = assistantItems.findLast((item) => item.text === "Adversarial");
    const repeatedFinal = assistantItems.findLast((item) => item.text === "Third final");
    if (!firstFinal || !adversarialFinal || !repeatedFinal) {
      throw new Error("Expected final assistant snapshots");
    }
    const finalItems = [firstFinal, adversarialFinal, repeatedFinal];
    expect(new Set(assistantItems.map((item) => item.messageId))).toEqual(
      new Set(finalItems.map((item) => item.messageId)),
    );
    for (const finalItem of finalItems) {
      expect(
        assistantItems
          .filter((item) => item.messageId === finalItem.messageId)
          .every((item) => item.id === finalItem.id),
      ).toBe(true);
    }
    expect(finalItems.map((item) => item.text)).toEqual(["First", "Adversarial", "Third final"]);
    expect(JSON.stringify(finalItems.map((item) => item.messageId))).not.toContain("x:occurrence");
    expect(JSON.stringify(finalItems.map((item) => item.messageId))).not.toContain(
      "repeated-native-response",
    );
    await connection.close();
  });

  test("keeps timeline IDs unique after bounded native identity eviction", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    for (let index = 0; index < 1_030; index += 1) {
      const turnId = turnIdFrom(
        await startPrompt(connection, events, `bounded-identity-${index}`, `prompt-${index}`),
      );
      session.emit({
        type: "message_end",
        message: {
          role: "user",
          content: `prompt-${index}`,
          entryId: index === 1_029 ? "entry-0" : `entry-${index}`,
        },
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer-${index}` },
        message: {
          role: "assistant",
          responseId: "repeated-native-response",
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
      await finishTurn(events, session, turnId);
    }

    const userIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item.id] : [],
    );
    const assistantIds = events.flatMap((event) => {
      if (event.type !== "timeline.item" || event.item.type !== "assistant_message") return [];
      return event.item.messageId ? [event.item.messageId] : [];
    });
    expect(new Set(userIds).size).toBe(1_030);
    expect(new Set(assistantIds).size).toBe(1_030);
    expect(userIds.some((id) => id.includes("entry-0"))).toBe(false);
    expect(assistantIds.some((id) => id.includes("repeated-native-response"))).toBe(false);
    await connection.close();
  });

  test("does not let delayed tool completion resolve a reused later-turn ID", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "tool-owner-a", "first"));
    first.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "first.ts" },
    });
    await finishTurn(events, first, firstTurnId);

    const secondTurnId = turnIdFrom(
      await startPrompt(connection, events, "tool-owner-b", "second"),
    );
    const secondBaseline = events.length;
    first.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "second.ts" },
    });
    first.emit({
      type: "tool_execution_end",
      toolCallId: "reused-tool",
      toolName: "read",
      result: { content: "late first result" },
    });
    expect(events.slice(secondBaseline).filter((event) => event.type === "timeline.item")).toEqual(
      [],
    );
    await finishTurn(events, first, secondTurnId);

    first.emit({ type: "process_exit", error: "restart generation" });
    const thirdTurnId = turnIdFrom(await startPrompt(connection, events, "tool-owner-c", "third"));
    const recovered = sessionAt(runtime, 1);
    const thirdBaseline = events.length;
    recovered.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "third.ts" },
    });
    recovered.emit({
      type: "tool_execution_end",
      toolCallId: "reused-tool",
      toolName: "read",
      result: { content: "third result" },
    });
    expect(
      events
        .slice(thirdBaseline)
        .filter(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "tool_call" &&
            event.item.name === "read",
        ),
    ).toHaveLength(2);
    await finishTurn(events, recovered, thirdTurnId);
    await connection.close();
  });

  test("keeps contentIndex 0 to 1 to 0 snapshots stable", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-interleaved" },
    });
    const snapshots = [
      {
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reason A" },
        content: [{ type: "thinking", thinking: "Reason A" }],
      },
      {
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer A" },
        content: [
          { type: "thinking", thinking: "Reason A" },
          { type: "text", text: "Answer A" },
        ],
      },
      {
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " revised" },
        content: [
          { type: "thinking", thinking: "Reason A revised" },
          { type: "text", text: "Answer A" },
        ],
      },
    ] as const;
    for (const snapshot of snapshots) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: snapshot.assistantMessageEvent,
        message: {
          role: "assistant",
          content: [...snapshot.content],
          responseId: "response-interleaved",
        },
      });
      await scheduler.flush();
    }

    await finishTurn(events, session, turnId);
    const timelineUpdates = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [event.item]
        : [],
    );
    const finalById = new Map(timelineUpdates.map((item) => [item.id, item]));
    expect([...finalById.values()]).toEqual([
      {
        type: "reasoning",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:0:reasoning",
        text: "Reason A revised",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:1:text",
        messageId: "omp:assistant:1:_rtzMvYnX4Ti",
        text: "Answer A",
      },
    ]);
    await connection.close();
  });

  test("bounds huge and excessive content indices without sparse state", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-bounded" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1_000_000, delta: "huge" },
      message: { role: "assistant", content: [], responseId: "response-bounded" },
    });
    for (let contentIndex = 0; contentIndex <= 64; contentIndex += 1) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex,
          delta: `block-${contentIndex}`,
        },
        message: { role: "assistant", content: [], responseId: "response-bounded" },
      });
    }
    for (const contentIndex of [4_095, 4_096]) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex, delta: `block-${contentIndex}` },
        message: { role: "assistant", content: [], responseId: "response-bounded" },
      });
    }
    await scheduler.flush();

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "assistant_message"
          ? [event.item]
          : [],
      ),
    ).toEqual([
      ...Array.from({ length: 65 }, (_, contentIndex) => ({
        type: "assistant_message" as const,
        id: `omp:assistant:1:B7lAkpW__Trl:content:${contentIndex}:text`,
        messageId: "omp:assistant:1:B7lAkpW__Trl",
        text: `block-${contentIndex}`,
      })),
      {
        type: "assistant_message",
        id: "omp:assistant:1:B7lAkpW__Trl:content:4095:text",
        messageId: "omp:assistant:1:B7lAkpW__Trl",
        text: "block-4095",
      },
    ]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("accepts image blocks and projects later indexed text", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-image" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });
    await scheduler.flush();

    const imageCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "Assistant image images",
    );
    if (imageCarrier?.type !== "timeline.item" || imageCarrier.item.type !== "tool_call") {
      throw new Error("Expected assistant image carrier");
    }
    expect(transformOmpImageToolItem(imageCarrier.item)?.items[0]).toEqual({
      type: "plugin",
      id: imageCarrier.item.callId,
      kind: "omp-images",
      version: 1,
      data: {
        label: "Assistant image",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
      },
    });
    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      ),
    ).toEqual(["after image"]);
    expect(JSON.stringify(events)).not.toContain("data:image");
    const webpData = Buffer.from("RIFF\0\0\0\0WEBP", "binary").toString("base64");
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 2,
        content: { type: "image", data: webpData, mimeType: "image/webp" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
          { type: "image", data: webpData, mimeType: "image/webp" },
        ],
      },
    });
    await scheduler.flush();
    const webpCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.id.endsWith(":content:2:image:images"),
    );
    if (webpCarrier?.type !== "timeline.item" || webpCarrier.item.type !== "tool_call") {
      throw new Error("Expected WebP assistant image carrier");
    }
    expect(transformOmpImageToolItem(webpCarrier.item)?.items[0]).toEqual({
      type: "plugin",
      id: webpCarrier.item.callId,
      kind: "omp-images",
      version: 1,
      data: {
        label: "Assistant image",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: webpData,
            mimeType: "image/webp",
          },
        ],
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("waits for a native identity before publishing an assistant stream", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Draft" },
      message: { role: "assistant", content: [{ type: "text", text: "Draft" }] },
    });
    await scheduler.flush();
    expect(
      events.some(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toBe(false);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " final" },
      message: {
        role: "assistant",
        responseId: "response-late",
        content: [{ type: "text", text: "Draft final" }],
      },
    });
    await scheduler.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          id: "omp:assistant:2:DP-A_9m7gBMN:content:0:text",
          messageId: "omp:assistant:2:DP-A_9m7gBMN",
          text: "Draft final",
        }),
      }),
    );
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("correlates equal user text to distinct native entry IDs", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "same-1", "repeat"));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-repeat-1" },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "same-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "same-2",
    );
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-repeat-2" },
    });

    const userItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(userItems).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "same-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "same-2",
      }),
    ]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });
});
