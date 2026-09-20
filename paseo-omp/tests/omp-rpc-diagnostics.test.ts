import { describe, expect, test } from "vitest";
import type {
  OmpProtocolViolationDiagnostic,
  OmpRpcEvent,
} from "../server/provider/omp-rpc-protocol";
import {
  FakeRpcChild,
  nextEvent,
  observeCommands,
  READY_FRAME,
  runtimeFor,
  writeChunked,
} from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  test("carries bounded final text intact for redaction-first projection", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_end") terminal.resolve();
    });

    const displayLimit = 4 * 1024 * 1024;
    const withinLimit = "é".repeat(displayLimit / 2);
    const overLimit = `${"x".repeat(displayLimit - 2)}abcd`;
    writeChunked(
      child,
      {
        type: "message_end",
        message: {
          role: "assistant",
          responseId: "final-within-limit",
          content: withinLimit,
          stopReason: "stop",
        },
      },
      "final-within-limit",
    );
    writeChunked(
      child,
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            entryId: "assistant-over-limit",
            responseId: "response-over-limit",
            content: overLimit,
            stopReason: "length",
          },
          {
            role: "bashExecution",
            entryId: "bash-over-limit",
            command: "generate-output",
            output: overLimit,
            exitCode: 137,
            cancelled: true,
            truncated: true,
          },
        ],
        messageCount: 2,
        isTerminal: true,
      },
      "terminal-over-limit",
    );
    await terminal.promise;

    expect(events[0]).toEqual({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "final-within-limit",
        content: withinLimit,
        stopReason: "stop",
      },
    });
    const terminalEvent = events[1];
    expect(terminalEvent).toEqual(
      expect.objectContaining({ type: "agent_end", messageCount: 2, isTerminal: true }),
    );
    if (terminalEvent?.type !== "agent_end" || !terminalEvent.messages) {
      throw new Error("Expected terminal messages");
    }
    const [assistant, bash] = terminalEvent.messages;
    expect(assistant).toEqual(
      expect.objectContaining({
        role: "assistant",
        entryId: "assistant-over-limit",
        responseId: "response-over-limit",
        stopReason: "length",
      }),
    );
    expect(assistant && "content" in assistant ? assistant.content : undefined).toBe(overLimit);
    expect(bash).toEqual(
      expect.objectContaining({
        role: "bashExecution",
        entryId: "bash-over-limit",
        command: "generate-output",
        exitCode: 137,
        cancelled: true,
        truncated: true,
      }),
    );
    expect(bash && "output" in bash ? bash.output : undefined).toBe(overLimit);
    await session.close();
  });

  test("sanitizes oversized chunked message_end and agent_end payloads before admission", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_end") terminal.resolve();
    });
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);

    writeChunked(
      child,
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "assistant-native-id",
          responseId: "assistant-response-id",
          content: oversized,
          stopReason: "length",
        },
      },
      "oversized-message-end",
    );
    writeChunked(
      child,
      {
        type: "agent_end",
        messages: [
          {
            role: "bashExecution",
            id: "bash-native-id",
            entryId: "bash-entry-id",
            command: "generate-output",
            output: oversized,
            exitCode: 137,
            cancelled: true,
            truncated: true,
          },
        ],
        messageCount: 1,
        isTerminal: true,
      },
      "oversized-agent-end",
    );
    await terminal.promise;

    expect(events).toEqual([
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "assistant-native-id",
          responseId: "assistant-response-id",
          content: "<truncated>",
          stopReason: "length",
        },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "bashExecution",
            id: "bash-native-id",
            entryId: "bash-entry-id",
            command: "generate-output",
            output: "<truncated>",
            exitCode: 137,
            cancelled: true,
            truncated: true,
          },
        ],
        messageCount: 1,
        isTerminal: true,
      },
    ]);
    await session.close();
  });

  test("rejects a 13 MiB chunked event while a history response is pending", async () => {
    const child = new FakeRpcChild();
    const historyRequested = Promise.withResolvers<void>();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        historyRequested.resolve();
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    session.onEvent((event) => events.push(event));
    const failure = nextEvent((listener) => session.onEvent(listener));
    const history = session.getMessages();
    void history.catch(() => undefined);
    await historyRequested.promise;

    writeChunked(
      child,
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "thirteen-mib-message",
          content: "x".repeat(13 * 1024 * 1024),
          stopReason: "length",
        },
      },
      "thirteen-mib-event",
    );

    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC frame exceeds the semantic byte limit",
    });
    await expect(history).rejects.toThrow("OMP RPC frame exceeds the semantic byte limit");
    expect(events.some((event) => event.type === "message_end")).toBe(false);
    await session.close();
  });

  test("keeps the physical limit for an unchunked oversized terminal payload", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_end") terminal.resolve();
    });

    child.write({
      type: "message_end",
      message: {
        role: "assistant",
        id: "oversized-physical-message",
        content: "x".repeat(8 * 1024 * 1024 + 1),
        stopReason: "length",
      },
    });
    child.write({ type: "agent_end", messages: [], messageCount: 1, isTerminal: true });
    await terminal.promise;

    expect(events).toEqual([
      { type: "agent_end", messages: [], messageCount: 1, isTerminal: true },
    ]);
    await session.close();
  });

  test("reports safe coalesced protocol diagnostics without changing frame recovery", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const diagnostics: OmpProtocolViolationDiagnostic[] = [];
    const opening = runtimeFor(child, [], undefined, (diagnostic) => {
      diagnostics.push(diagnostic);
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));
    const secret = "API_KEY=fabricated-secret";
    const malformed = {
      type: "notice",
      level: 42,
      message: secret,
      arguments: { token: secret },
      result: secret,
      path: `/private/${secret}`,
      environment: { TOKEN: secret },
    };

    for (let index = 0; index < 100; index += 1) child.write(malformed);
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    expect(diagnostics).toEqual([
      {
        category: "invalid-event",
        reason: "notice-level-type",
        phase: "idle",
        eventType: "notice",
        occurrenceCount: 1,
        frameType: "notice",
        field: "notice.level",
        expected: "notice-level-enum",
        actualType: "number",
        maxByteSize: Buffer.byteLength(JSON.stringify(malformed)),
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);

    await session.close();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "invalid-event",
        reason: "notice-level-type",
        occurrenceCount: 1,
        phase: "idle",
        eventType: "notice",
        field: "notice.level",
        expected: "notice-level-enum",
        actualType: "number",
      }),
      expect.objectContaining({
        category: "invalid-event",
        reason: "notice-level-type",
        occurrenceCount: 99,
        phase: "idle",
        eventType: "notice",
        field: "notice.level",
        expected: "notice-level-enum",
        actualType: "number",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  test("coalesces mixed violation reasons independently", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const diagnostics: OmpProtocolViolationDiagnostic[] = [];
    const opening = runtimeFor(child, [], undefined, (diagnostic) => {
      diagnostics.push(diagnostic);
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    child.write({ type: "notice", level: 42, message: "bad level" });
    child.write({ type: "notice", level: "info", message: 42 });
    await session.close();

    expect(diagnostics).toEqual([
      expect.objectContaining({ reason: "notice-level-type", occurrenceCount: 1 }),
      expect.objectContaining({ reason: "notice-message-type", occurrenceCount: 1 }),
    ]);
  });

  test("ignores a throwing protocol diagnostic sink", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child, [], undefined, () => {
      throw new Error("diagnostic sink failed");
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({ type: "notice", level: 42, message: "malformed" });
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });

  test("ignores an asynchronously rejecting protocol diagnostic sink", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child, [], undefined, async () => {
      await Promise.resolve();
      throw new Error("diagnostic sink rejected");
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({ type: "notice", level: 42, message: "malformed" });
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });

  test("isolates malformed recognized and physical frames from later valid events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({ type: "notice", level: 42, message: "invalid notice" });
    child.writeRaw(`${"x".repeat(1_048_577)}\n`);
    child.write({
      type: "rpc_chunk",
      chunkId: "bad-order",
      index: 1,
      count: 2,
      byteLength: 4,
      data: "e30=",
    });
    for (let index = 0; index < 100; index += 1) {
      child.write({ type: `unknown_${index}`, detail: "API_KEY=must-not-surface" });
    }
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });
  for (const chunking of ["same stdout chunk", "separate stdout chunks"] as const) {
    test(`isolates a complete oversized physical line from a valid frame in ${chunking}`, async () => {
      const child = new FakeRpcChild();
      observeCommands(child, (command) => {
        if (command.type === "negotiate_protocol") {
          child.write({
            type: "response",
            id: command.id,
            success: true,
            data: { protocolVersion: 2 },
          });
        }
      });
      const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
      child.write(READY_FRAME);
      const session = await opening;
      const observed: OmpRpcEvent[] = [];
      const unsubscribe = session.onEvent((event) => observed.push(event));
      const oversized = "x".repeat(1_048_577);
      const valid = JSON.stringify({ type: "notice", level: "info", message: "still healthy" });

      if (chunking === "same stdout chunk") child.writeRaw(`${oversized}\n${valid}\n`);
      else {
        child.writeRaw(`${oversized}\n`);
        child.writeRaw(`${valid}\n`);
      }

      expect(observed).toContainEqual({
        type: "notice",
        level: "info",
        message: "still healthy",
      });
      unsubscribe();
      await session.close();
    });
  }

  test("fails the runtime on a complete oversized physical frame", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    child.writeRaw(`${"x".repeat(12 * 1024 * 1024 + 1)}\n`);
    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC frame exceeds the semantic byte limit",
    });
    await session.close();
  });

  test("preserves validated events internally while keeping stderr out of failures", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({
      cwd: "/repo",
      mode: "full",
      env: { OPENAI_API_KEY: "credential-value-1234" },
    });
    child.write(READY_FRAME);
    const session = await opening;
    const observed: OmpRpcEvent[] = [];
    const unsubscribe = session.onEvent((event) => observed.push(event));
    const notice = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });
    expect(await notice).toEqual({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });

    const exit = nextEvent((listener) => session.onEvent(listener));
    child.stderr.write("OPENAI_API_KEY=credential-value-1234 /home/private/config raw stderr");
    child.close(7);
    expect(await exit).toEqual({ type: "process_exit", error: "OMP RPC process exited (code 7)" });
    expect(observed.filter((event) => event.type === "process_exit")).toHaveLength(1);
    unsubscribe();
    await session.close();
  });

  test("preserves frame-valid tool payloads and isolates malformed events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const noticeDelivered = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") noticeDelivered.resolve();
    });

    child.write({
      type: "todo_reminder",
      todos: Array.from({ length: 257 }, (_, index) => ({
        id: `todo-${index}`,
        content: "bounded",
        status: "pending",
      })),
    });
    child.write({
      type: "tool_execution_start",
      toolCallId: "large-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, (_, index) => `value-${index}`),
    });
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      },
      assistantMessageEvent: { type: "image_end", contentIndex: 0 },
    });
    child.write({ type: "notice", level: "warning", message: "valid after rejected frames" });
    await noticeDelivered.promise;

    expect(events).toHaveLength(2);
    const toolEvent = events[0];
    if (toolEvent?.type !== "tool_execution_start" || !Array.isArray(toolEvent.args)) {
      throw new Error("Expected preserved tool event");
    }
    expect(toolEvent.args).toHaveLength(513);
    expect(events[1]).toEqual({
      type: "notice",
      level: "warning",
      message: "valid after rejected frames",
    });
    await session.close();
  });

  test("bounds cumulative streamed text while retaining later protocol events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const recovered = Promise.withResolvers<OmpRpcEvent>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") recovered.resolve(event);
    });
    child.write({
      type: "message_start",
      message: { role: "assistant", responseId: "bounded", content: [] },
    });
    for (let index = 0; index < 5; index += 1) {
      child.write({
        type: "message_update",
        message: { role: "assistant", responseId: "bounded", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(900_000) },
      });
    }
    child.write({ type: "notice", level: "info", message: "after stream bound" });
    await recovered.promise;

    expect(events.filter((event) => event.type === "message_update")).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "notice", level: "info", message: "after stream bound" });
    await session.close();
  });

  test("drops spoofed lifecycle and malformed permission frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "process_exit", error: "spoofed", sessionId: "other-session" });
    child.write({ type: "extension_ui_request", id: "permission", method: 42, approved: true });
    child.write({
      type: "notice",
      level: "info",
      message: "safe",
      sessionId: "other-session",
      capabilities: ["admin"],
    });

    await expect(recovered).resolves.toEqual({ type: "notice", level: "info", message: "safe" });
    await session.close();
  });
});
