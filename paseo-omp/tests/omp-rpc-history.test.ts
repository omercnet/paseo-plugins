import { describe, expect, test } from "vitest";
import type { OmpProtocolViolationDiagnostic } from "../server/provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import {
  FakeRpcChild,
  nextEvent,
  observeCommands,
  READY_FRAME,
  runtimeFor,
  writeChunked,
} from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  test("reassembles bounded v2 chunk frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_state") return;
      const payload = Buffer.from(
        JSON.stringify({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "chunked",
          },
        }),
      );
      const split = Math.ceil(payload.byteLength / 2);
      const parts = [payload.subarray(0, split), payload.subarray(split)];
      for (const [index, part] of parts.entries()) {
        child.write({
          type: "rpc_chunk",
          chunkId: "chunk-1",
          index,
          count: parts.length,
          byteLength: payload.byteLength,
          data: part.toString("base64"),
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    expect(await session.getState()).toEqual(expect.objectContaining({ sessionId: "chunked" }));
    await session.close();
  });
  test("accepts tool-intensive assistant history beyond 64 content parts", async () => {
    const child = new FakeRpcChild();
    const content = Array.from({ length: 65 }, (_, index) => ({
      type: "text",
      text: `part-${index}`,
    }));
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: [{ role: "assistant", content }], totalMessages: 1 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const [assistant] = await session.getMessages();
    expect(assistant?.role).toBe("assistant");
    expect(assistant && "content" in assistant ? assistant.content : undefined).toHaveLength(65);
    await session.close();
  });
  test("accepts every OMP 18.2 message role without reclassifying developer context", async () => {
    const child = new FakeRpcChild();
    const roles = [
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "question" },
      { role: "developer", content: "trusted harness context" },
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [] },
      { role: "bashExecution", command: "pwd", output: "/repo", exitCode: 0 },
      { role: "pythonExecution", code: "print(1)", output: "1", exitCode: 0 },
      { role: "custom", customType: "note", content: "visible", display: true },
      { role: "hookMessage", customType: "legacy", content: "visible", display: true },
      { role: "branchSummary", summary: "branch", fromId: "root" },
      { role: "compactionSummary", summary: "compact", tokensBefore: 100 },
      { role: "fileMention", files: [{ path: "src/a.ts", content: "export {};" }] },
    ];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: roles, totalMessages: roles.length },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getMessages()).resolves.toMatchObject(roles);
    await session.close();
  });

  test("accepts bounded read metadata with more than 1,024 source entries", async () => {
    const child = new FakeRpcChild();
    const sourceEntries = Array.from({ length: 1_223 }, (_, index) => `line-${index}`);
    const details = {
      contentType: "text",
      meta: { source: { value: sourceEntries } },
      displayContent: { lineNumbers: sourceEntries },
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details,
    };
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: Array.from({ length: 4 }, (_, index) => ({
              ...toolResult,
              toolCallId: `call-${index}`,
            })),
            totalMessages: 4,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const toolStart = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
    await expect(toolStart).resolves.toMatchObject({ type: "tool_execution_start" });

    const toolEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: toolResult.content, details },
    });
    await expect(toolEnd).resolves.toMatchObject({
      type: "tool_execution_end",
      result: { details },
    });

    const messageEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "message_end", message: toolResult });
    await expect(messageEnd).resolves.toMatchObject({ type: "message_end", message: { details } });
    const history = await session.getMessages();
    expect(history.map((message) => message.details !== undefined)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    const terminal = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "agent_end",
      messages: [
        toolResult,
        { role: "assistant", id: "answer-1", content: "done", stopReason: "stop" },
      ],
      messageCount: 2,
      isTerminal: true,
    });
    await expect(terminal).resolves.toMatchObject({
      type: "agent_end",
      messages: [expect.objectContaining({ toolCallId: "call-1" }), { stopReason: "stop" }],
      messageCount: 2,
      isTerminal: true,
    });
    await session.close();
  });

  test("omits over-budget optional metadata without losing completion evidence", async () => {
    const child = new FakeRpcChild();
    const details = {
      contentType: "text",
      meta: {
        source: {
          value: Array.from({ length: 2_049 }, (_, index) => `line-${index}`),
        },
      },
    };
    const toolResult = {
      role: "toolResult" as const,
      id: "tool-message-1",
      toolCallId: "call-oversized",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details,
    };
    const assistant = {
      role: "assistant" as const,
      id: "answer-oversized",
      content: "done",
      stopReason: "stop",
      details,
    };
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: [toolResult, assistant], totalMessages: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const toolStart = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_execution_start",
      toolCallId: "call-oversized",
      toolName: "read",
      args: {},
    });
    await expect(toolStart).resolves.toMatchObject({
      type: "tool_execution_start",
      toolCallId: "call-oversized",
    });

    const toolEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_execution_end",
      toolCallId: "call-oversized",
      toolName: "read",
      result: { content: toolResult.content, details },
    });
    await expect(toolEnd).resolves.toEqual({
      type: "tool_execution_end",
      toolCallId: "call-oversized",
      toolName: "read",
      result: { content: toolResult.content },
    });

    const toolMessageEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "message_end", message: toolResult });
    await expect(toolMessageEnd).resolves.toEqual({
      type: "message_end",
      message: {
        role: "toolResult",
        id: "tool-message-1",
        toolCallId: "call-oversized",
        toolName: "read",
        content: toolResult.content,
      },
    });

    const assistantEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "message_end", message: assistant });
    await expect(assistantEnd).resolves.toEqual({
      type: "message_end",
      message: {
        role: "assistant",
        id: "answer-oversized",
        content: "done",
        stopReason: "stop",
      },
    });

    const terminal = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "agent_end",
      requestId: "prompt-oversized",
      messages: [toolResult, assistant],
      messageCount: 2,
      isTerminal: true,
    });
    await expect(terminal).resolves.toEqual({
      requestId: "prompt-oversized",
      type: "agent_end",
      messages: [
        {
          role: "toolResult",
          id: "tool-message-1",
          toolCallId: "call-oversized",
          toolName: "read",
          content: toolResult.content,
        },
        {
          role: "assistant",
          id: "answer-oversized",
          content: "done",
          stopReason: "stop",
        },
      ],
      messageCount: 2,
      isTerminal: true,
    });

    await expect(session.getMessages()).resolves.toEqual([
      {
        role: "toolResult",
        id: "tool-message-1",
        toolCallId: "call-oversized",
        toolName: "read",
        content: toolResult.content,
      },
      {
        role: "assistant",
        id: "answer-oversized",
        content: "done",
        stopReason: "stop",
      },
    ]);
    await session.close();
  });

  test.each([
    ["byte", { payload: "x".repeat(256 * 1024 + 1) }],
    ["node", { groups: Array.from({ length: 1_024 }, () => ({ a: 1, b: 2, c: 3 })) }],
    [
      "depth",
      Array.from({ length: 18 }).reduce<Record<string, unknown>>((nested) => ({ nested }), {}),
    ],
  ])("omits optional metadata beyond the %s budget", async (_budget, details) => {
    const child = new FakeRpcChild();
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { protocolVersion: 2 },
      });
    });
    child.write(READY_FRAME);
    const session = await opening;
    const messageEnd = nextEvent((listener) => session.onEvent(listener));

    child.write({
      type: "message_end",
      message: {
        role: "assistant",
        id: `bounded-${_budget}`,
        content: "done",
        stopReason: "stop",
        details,
      },
    });
    await expect(messageEnd).resolves.toEqual({
      type: "message_end",
      message: {
        role: "assistant",
        id: `bounded-${_budget}`,
        content: "done",
        stopReason: "stop",
      },
    });
    await session.close();
  });

  test("preserves bounded task correlation in a degraded nested subagent event", async () => {
    const child = new FakeRpcChild();
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { protocolVersion: 2 },
      });
    });
    child.write(READY_FRAME);
    const session = await opening;
    const nestedEvent = nextEvent((listener) => session.onEvent(listener));

    child.write({
      type: "subagent_event",
      payload: {
        id: "parent-child",
        event: {
          type: "tool_execution_end",
          toolCallId: "nested-task",
          toolName: "task",
          result: {
            details: {
              results: [
                {
                  id: "nested-child",
                  status: "failed",
                  error: "child failed",
                  aborted: false,
                  ancillary: "discarded",
                },
                { id: "prototype-status", status: "toString" },
              ],
              progress: [{ id: "nested-child", index: 0, status: "completed", extra: true }],
              displayContent: {
                lineNumbers: Array.from({ length: 2_049 }, (_, index) => index),
              },
            },
          },
        },
      },
    });

    await expect(nestedEvent).resolves.toEqual({
      type: "subagent_event",
      payload: {
        id: "parent-child",
        event: {
          type: "tool_execution_end",
          toolCallId: "nested-task",
          toolName: "task",
          result: {
            details: {
              results: [
                {
                  id: "nested-child",
                  status: "failed",
                  error: "child failed",
                  aborted: false,
                },
                { id: "prototype-status" },
              ],
              progress: [{ id: "nested-child", index: 0, status: "completed" }],
            },
          },
        },
      },
    });
    await session.close();
  });

  test("reads byte-heavy history through negotiated v2 chunking", async () => {
    const child = new FakeRpcChild();
    const text = "é".repeat(350_000);
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages_page") {
        writeChunked(
          child,
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              messages: [
                { role: "user", id: "history-user", content: text },
                {
                  role: "toolResult",
                  toolCallId: "call-1",
                  toolName: "read",
                  content: { content: [{ type: "text", text: "result" }], details: { count: 1 } },
                },
                { role: "bashExecution", command: "pwd", exitCode: 0, cancelled: false },
                { role: "assistant", id: "history-assistant", content: text },
                { role: "user", id: "history-user-2", content: text },
              ],
              totalMessages: 5,
            },
          },
          "history-chunks",
        );
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    expect(session.canReplayHistory).toBe(true);
    const messages = await session.getMessages();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "bashExecution",
      "assistant",
      "user",
    ]);
    expect(messages[1]).toEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-1", toolName: "read" }),
    );
    expect(messages[2]).toEqual(expect.objectContaining({ role: "bashExecution", command: "pwd" }));
    expect(messages[2]).not.toHaveProperty("content");
    const assistant = messages[3];
    expect(assistant && "content" in assistant ? assistant.content : undefined).toHaveLength(
      350_000,
    );
    await session.close();
  });

  test("retains reassembled history responses above the live semantic bound", async () => {
    const child = new FakeRpcChild();
    const sevenMiB = "x".repeat(7 * 1024 * 1024);
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        writeChunked(
          child,
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              messages: [
                { role: "assistant", id: "history-one", content: sevenMiB },
                { role: "assistant", id: "history-two", content: sevenMiB },
              ],
              totalMessages: 2,
            },
          },
          "large-history-response",
        );
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const messages = await session.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => ("content" in message ? message.content : undefined))).toEqual(
      [sevenMiB, sevenMiB],
    );
    await session.close();
  });

  test("replays histories larger than 2 MiB through bounded pages", async () => {
    const child = new FakeRpcChild();
    const text = "x".repeat(700_000);
    const cursors: Array<string | undefined> = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_messages_page") return;
      const cursor = typeof command.cursor === "string" ? command.cursor : undefined;
      cursors.push(cursor);
      const offset = cursor ? Number(cursor) : 0;
      child.write({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data: {
          messages: [{ role: "assistant", responseId: `page-${offset}`, content: text }],
          ...(offset < 3 ? { nextCursor: String(offset + 1) } : {}),
          totalMessages: 4,
        },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const messages = await session.getMessages();
    expect(messages).toHaveLength(4);
    expect(
      messages.every((message) => message.role === "assistant" && message.content === text),
    ).toBe(true);
    expect(cursors).toEqual([undefined, "1", "2", "3"]);
    await session.close();
  });

  test("rejects non-progressing message pagination", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: [], nextCursor: "same", totalMessages: 1 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getMessages()).rejects.toThrow("did not make progress");
    await session.close();
  });

  test("rejects repeated message cursors", async () => {
    const child = new FakeRpcChild();
    let page = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        page += 1;
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [{ role: "user", content: `page ${page}` }],
            nextCursor: "repeated",
            totalMessages: 3,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getMessages()).rejects.toThrow("repeated a cursor");
    expect(page).toBe(2);
    await session.close();
  });

  test("accepts bounded opaque cursors with padding and punctuation", async () => {
    const child = new FakeRpcChild();
    const observed: Array<string | undefined> = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        const cursor = typeof command.cursor === "string" ? command.cursor : undefined;
        observed.push(cursor);
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: cursor
            ? { messages: [{ role: "assistant", content: "done" }], totalMessages: 2 }
            : {
                messages: [{ role: "user", content: "start" }],
                nextCursor: "opaque+/==",
                totalMessages: 2,
              },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.getMessages()).resolves.toHaveLength(2);
    expect(observed).toEqual([undefined, "opaque+/=="]);
    await session.close();
  });

  test("rejects overlapping stable message identities across pages", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [{ role: "assistant", responseId: "overlap", content: "same" }],
            ...(command.cursor ? {} : { nextCursor: "second" }),
            totalMessages: 2,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.getMessages()).rejects.toThrow("repeated a message identity");
    await session.close();
  });

  test("rejects excessive underfilled message pages", async () => {
    const child = new FakeRpcChild();
    let pageRequests = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        pageRequests += 1;
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [{ role: "user", content: "x" }],
            nextCursor: `page/${pageRequests}==`,
            totalMessages: 513,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.getMessages()).rejects.toThrow("response exceeded command limits");
    expect(pageRequests).toBe(513);
    await session.close();
  });

  test("falls back to legacy history only when the paging command is unsupported", async () => {
    const child = new FakeRpcChild();
    const commands: string[] = [];
    observeCommands(child, (command) => {
      if (typeof command.type === "string") commands.push(command.type);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          command: "get_messages_page",
          success: false,
          error: "Unknown command: get_messages_page",
        });
      } else if (command.type === "get_messages") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: [{ role: "user", content: "legacy" }] },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getMessages()).resolves.toEqual([{ role: "user", content: "legacy" }]);
    expect(commands.slice(-2)).toEqual(["get_messages_page", "get_messages"]);
    await session.close();
  });

  test("retries busy pages and restarts a stale snapshot without mixing histories", async () => {
    const child = new FakeRpcChild();
    let pageRequest = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_messages_page") return;
      pageRequest += 1;
      if (pageRequest === 1) {
        child.write({
          type: "response",
          id: command.id,
          command: command.type,
          success: false,
          code: "session_busy",
          error: "sanitized",
        });
      } else if (pageRequest === 2) {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [{ role: "user", content: "discarded snapshot" }],
            nextCursor: "old",
            totalMessages: 2,
          },
        });
      } else if (pageRequest === 3) {
        child.write({
          type: "response",
          id: command.id,
          command: command.type,
          success: false,
          code: "stale_cursor",
          error: "sanitized",
        });
      } else {
        const second = command.cursor === "fresh";
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [
              { role: second ? "assistant" : "user", content: second ? "answer" : "fresh" },
            ],
            ...(!second ? { nextCursor: "fresh" } : {}),
            totalMessages: 2,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getMessages()).resolves.toEqual([
      { role: "user", content: "fresh" },
      { role: "assistant", content: "answer" },
    ]);
    expect(pageRequest).toBe(5);
    await session.close();
  });

  test("rejects an explicit v1-only ready frame before negotiation", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ ...READY_FRAME, supportedProtocolVersions: [1] });

    await expect(opening).rejects.toThrow("requires OMP RPC protocol v2");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  test("rejects invalid branch responses immediately and accepts the next valid response", async () => {
    const child = new FakeRpcChild();
    const diagnostics: OmpProtocolViolationDiagnostic[] = [];
    let branchRequestCount = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_branch_messages") return;
      branchRequestCount += 1;
      if (branchRequestCount === 1) {
        child.write({ type: "response", id: command.id, success: "invalid" });
        return;
      }
      const messageCount = branchRequestCount === 2 ? 1_025 : 1_024;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: {
          messages: Array.from({ length: messageCount }, (_, index) => ({
            entryId: `${messageCount === 1_024 ? "entry" : "bad"}-${index}`,
            text: "x",
          })),
        },
      });
    });
    const opening = runtimeFor(child, [], undefined, (diagnostic) => {
      diagnostics.push(diagnostic);
    }).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    let malformedOutcome: string | undefined;
    void session.getBranchMessages().then(
      () => {
        malformedOutcome = "resolved";
      },
      (error) => {
        malformedOutcome = error instanceof Error ? error.message : String(error);
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(malformedOutcome).toBe("OMP RPC response is invalid");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "invalid-response",
        reason: "response-schema",
        frameType: "response",
        field: "response",
        expected: "valid-response-frame",
        actualType: "object",
      }),
    ]);
    let oversizedOutcome: string | undefined;
    void session.getBranchMessages().then(
      () => {
        oversizedOutcome = "resolved";
      },
      (error) => {
        oversizedOutcome = error instanceof Error ? error.message : String(error);
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(oversizedOutcome).toBe("OMP RPC response exceeded command limits");
    const messages = await session.getBranchMessages();
    expect(messages).toHaveLength(1_024);
    expect(messages.at(-1)).toEqual({ entryId: "entry-1023", text: "x" });
    await session.close();
  });
  test("sends bounded native branch identifiers and validates branch results", async () => {
    const child = new FakeRpcChild();
    let branchCount = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "branch") return;
      branchCount += 1;
      if (branchCount === 1) {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { text: "selected prompt", cancelled: false },
        });
      } else if (branchCount === 2) {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { text: 42, cancelled: false },
        });
      } else {
        child.write({ type: "response", id: command.id, success: false });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.branch("entry-1")).resolves.toEqual({
      text: "selected prompt",
      cancelled: false,
    });
    await expect(session.branch("entry-2")).rejects.toThrow("OMP RPC response is invalid");
    await expect(session.branch("entry-3")).rejects.toBeInstanceOf(OmpRpcRequestRejectedError);
    await expect(session.branch("x".repeat(257))).rejects.toThrow(
      "Invalid OMP branch entry identifier",
    );
    expect(branchCount).toBe(3);
    await session.close();
  });
});
