import { describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  EventLog,
  MODEL,
  NATIVE_SESSION_ID,
  ProviderRpcChild,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("publishes selected branch history from chunked OMP RPC before ready", async () => {
    const largeText = "x".repeat(1_200_000);
    let child: ProviderRpcChild;
    child = new ProviderRpcChild((command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_state") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            model: MODEL,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionId: NATIVE_SESSION_ID,
          },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { models: [MODEL] },
        });
      } else if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { commands: [] },
        });
      } else if (command.type === "get_messages_page") {
        const firstPage = command.cursor === undefined;
        child.writeChunked(
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              messages: firstPage
                ? [
                    { role: "user", id: "selected-user", content: "selected branch" },
                    {
                      role: "assistant",
                      responseId: "selected-assistant-1",
                      content: [
                        { type: "text", text: largeText },
                        {
                          type: "toolCall",
                          id: "selected-tool",
                          name: "read",
                          arguments: { path: "selected.ts" },
                        },
                      ],
                    },
                  ]
                : [
                    {
                      role: "toolResult",
                      toolCallId: "selected-tool",
                      toolName: "read",
                      content: [{ type: "text", text: "selected result" }],
                    },
                    { role: "bashExecution", command: "pwd", output: "/repo\n", exitCode: 0 },
                    {
                      role: "assistant",
                      responseId: "selected-assistant-2",
                      content: largeText,
                    },
                  ],
              ...(firstPage ? { nextCursor: "selected-page-2" } : {}),
              totalMessages: 5,
            },
          },
          firstPage ? "selected-history-1" : "selected-history-2",
        );
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      listSessions: () => [{ id: NATIVE_SESSION_ID, cwd: "/repo" }],
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    queueMicrotask(() =>
      child.write({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "selected-branch-open",
      sessionId: "selected-branch-session",
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
      (event) => event.type === "session.ready" && event.requestId === "selected-branch-open",
    );
    const readyIndex = events.findIndex((event) => event.type === "session.ready");
    const timeline = events.flatMap((event, index) =>
      event.type === "timeline.item" ? [{ index, item: event.item }] : [],
    );
    expect(timeline.every((entry) => entry.index < readyIndex)).toBe(true);
    expect(timeline.map((entry) => entry.item.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(timeline.filter((entry) => entry.item.type === "assistant_message")[0]?.item).toEqual(
      expect.objectContaining({ text: largeText }),
    );
    expect(
      timeline.find((entry) => entry.item.type === "tool_call" && entry.item.status === "completed")
        ?.item,
    ).toEqual(
      expect.objectContaining({
        detail: {
          type: "read",
          filePath: "selected.ts",
          content: "selected result",
        },
      }),
    );
    await connection.close();
  });
  test("advances replay suppression at an in-chunk prompt acknowledgement", async () => {
    const duplicate = {
      role: "assistant" as const,
      entryId: "transport-shared-entry",
      responseId: "transport-shared-response",
      content: "same answer",
    };
    const preAckDuplicate = {
      ...duplicate,
      content: [
        { type: "thinking" as const, thinking: "pre-ack replay duplicate" },
        { type: "text" as const, text: "same answer" },
      ],
    };
    let child: ProviderRpcChild;
    child = new ProviderRpcChild((command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_state") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            model: MODEL,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionId: NATIVE_SESSION_ID,
          },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { models: [MODEL] },
        });
      } else if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { commands: [] },
        });
      } else if (command.type === "get_messages_page") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [
              { role: "user", entryId: "transport-user-1", content: "first" },
              preAckDuplicate,
              { role: "user", entryId: "transport-user-2", content: "second" },
              duplicate,
            ],
            totalMessages: 4,
          },
        });
      } else if (command.type === "prompt") {
        child.stdout.write(
          `${[
            { type: "message_end", message: preAckDuplicate },
            {
              type: "response",
              id: command.id,
              success: true,
              data: { agentInvoked: true },
            },
            { type: "message_end", message: duplicate },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n")}\n`,
        );
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      listSessions: () => [{ id: NATIVE_SESSION_ID, cwd: "/repo" }],
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    queueMicrotask(() =>
      child.write({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "transport-boundary-open",
      sessionId: "transport-boundary-session",
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
      (event) => event.type === "session.ready" && event.requestId === "transport-boundary-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(replayedAssistants.map((item) => item.text)).toEqual(["same answer", "same answer"]);

    const baseline = events.length;
    const turnId = turnIdFrom(
      await startPrompt(
        connection,
        events,
        "transport-boundary-prompt",
        "continue",
        "transport-boundary-session",
      ),
    );
    expect(
      events
        .slice(baseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["same answer"]);
    expect(
      events
        .slice(baseline)
        .some((event) => event.type === "timeline.item" && event.item.type === "reasoning"),
    ).toBe(false);
    child.write({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.close();
  });
});
