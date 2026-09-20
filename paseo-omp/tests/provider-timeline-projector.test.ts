import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { createOmpProvider } from "../server/provider/registration";
import { OmpPublicDataSerializer, truncateUtf8 } from "../server/provider/security";
import { OmpTimelineProjector } from "../server/provider/timeline-projector";
import {
  createHarness,
  createHostToolHarness,
  EventLog,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("bounds text without changing content", () => {
    const serializer = new OmpPublicDataSerializer();
    for (const value of [
      "Authorization: Basic header-secret",
      "Bearer bearer-secret",
      "API_KEY=api-secret",
      "password=password-secret",
      "private-key=private-secret",
      "session token=session-secret",
      "ghp_abcdefgh",
      "/home/private/file",
      String.raw`C:\Users\private\file.txt`,
      "\u0000\u0007\t\n\r",
    ]) {
      expect(serializer.text(value)).toBe(value);
    }

    expect(serializer.text("🙂🙂🙂🙂", 15)).toBe("🙂<truncated>");
    const displayLimit = 4 * 1024 * 1024;
    const multibyte = truncateUtf8("🙂".repeat(displayLimit / 4 + 1), displayLimit);
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(displayLimit - 1);
    expect(multibyte).toMatch(/<truncated>$/u);
    expect(multibyte).not.toContain("�");
  });

  test("bounds JSON-encoded control-heavy tool output", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "encoded-budget-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );

    projector.project(
      { type: "tool_execution_start", toolCallId: "control-output", toolName: "custom", args: {} },
      "encoded-budget-turn",
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "control-output",
        toolName: "custom",
        result: { content: "\0".repeat(60_000) },
      },
      "encoded-budget-turn",
    );

    const completed = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    if (
      completed?.type !== "timeline.item" ||
      completed.item.type !== "tool_call" ||
      completed.item.detail.type !== "unknown"
    ) {
      throw new Error("Expected completed custom tool output");
    }
    const output = completed.item.detail.output;
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(
      output && typeof output === "object" && !Array.isArray(output) ? output.content : null,
    ).toMatch(/^\0+<truncated>$/u);
  });

  test("preserves structured values with sensitive-shaped keys", () => {
    const serializer = new OmpPublicDataSerializer();
    const output = serializer.json({
      apiKey: "another-secret",
      password: "known-sensitive-value",
      secret: { type: "string" },
    });
    expect(output).toEqual({
      apiKey: "another-secret",
      password: "known-sensitive-value",
      secret: { type: "string" },
    });
    expect(Object.getPrototypeOf(output)).toBeNull();
  });

  test("matches native OMP result text precedence for typed details", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "result-text-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );
    const turnId = "result-text-turn";
    const cases = [
      {
        id: "string-result",
        toolName: "read",
        args: { path: "direct.txt" },
        result: "direct string",
        detail: { type: "read", filePath: "direct.txt", content: "direct string" },
      },
      {
        id: "output-result",
        toolName: "bash",
        args: { command: "printf output" },
        result: {
          output: "output value",
          stdout: "stdout value",
          text: "text value",
          content: [{ type: "text", text: "content value" }],
        },
        detail: { type: "shell", command: "printf output", output: "output value" },
      },
      {
        id: "stdout-result",
        toolName: "grep",
        args: { pattern: "needle" },
        result: {
          stdout: "stdout value",
          text: "text value",
          content: [{ type: "text", text: "content value" }],
        },
        detail: {
          type: "search",
          query: "needle",
          toolName: "grep",
          content: "stdout value",
        },
      },
      {
        id: "text-result",
        toolName: "fetch",
        args: { url: "https://example.com/page" },
        result: { text: "text value", content: [{ type: "text", text: "content value" }] },
        detail: { type: "fetch", url: "https://example.com/page", result: "text value" },
      },
      {
        id: "content-result",
        toolName: "task",
        args: { agent: "reviewer", description: "Review projection" },
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "resource", uri: "file:///ignored" },
            { type: "text", text: "second" },
          ],
        },
        detail: {
          type: "sub_agent",
          subAgentType: "reviewer",
          description: "Review projection",
          log: "first\nsecond",
        },
      },
    ] as const;

    for (const fixture of cases) {
      projector.project(
        {
          type: "tool_execution_start",
          toolCallId: fixture.id,
          toolName: fixture.toolName,
          args: fixture.args,
        },
        turnId,
      );
      projector.project(
        {
          type: "tool_execution_end",
          toolCallId: fixture.id,
          toolName: fixture.toolName,
          result: fixture.result,
        },
        turnId,
      );
    }

    const completedDetails = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.status === "completed"
        ? [event.item.detail]
        : [],
    );
    expect(completedDetails).toEqual(cases.map(({ detail }) => detail));
  });

  test("preserves structured unknown output across image finalization and replay", () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const partial = {
      content: [{ type: "record", value: { key: "partial", rows: [1] } }, image],
      progress: { done: false },
    };
    const final = {
      content: [
        { type: "text", text: "first" },
        { type: "record", value: { key: "final", rows: [1, 2] } },
        image,
        { type: "text", text: "second" },
      ],
      details: { source: "fixture" },
      metadata: { complete: true },
    };
    const outputWithoutImage = {
      content: [final.content[0], final.content[1], final.content[3]],
      details: final.details,
      metadata: final.metadata,
    };
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "mixed-result-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );
    const turnId = "mixed-result-turn";

    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "mixed-result",
        toolName: "vendor_tool",
        args: { operation: "inspect" },
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_update",
        toolCallId: "mixed-result",
        toolName: "vendor_tool",
        partialResult: partial,
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "mixed-result",
        toolName: "vendor_tool",
        result: final,
      },
      turnId,
    );

    const liveSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "vendor_tool"
        ? [event.item]
        : [],
    );
    expect(
      liveSnapshots.map(({ id, callId, status, detail }) => ({ id, callId, status, detail })),
    ).toEqual([
      {
        id: "omp:tool:1",
        callId: "omp:tool:1",
        status: "running",
        detail: { type: "unknown", input: { operation: "inspect" }, output: null },
      },
      {
        id: "omp:tool:1",
        callId: "omp:tool:1",
        status: "running",
        detail: { type: "unknown", input: { operation: "inspect" }, output: partial },
      },
      {
        id: "omp:tool:1",
        callId: "omp:tool:1",
        status: "completed",
        detail: {
          type: "unknown",
          input: { operation: "inspect" },
          output: outputWithoutImage,
        },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          id: "omp:tool:1:images",
          callId: "omp:tool:1:images",
          name: "vendor_tool images",
          status: "completed",
          error: null,
          metadata: {
            ompImageOwner: "omp",
            ompImage: {
              label: "vendor_tool",
              images: [
                {
                  id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
                  data: image.data,
                  mimeType: image.mimeType,
                },
              ],
              text: "first\nsecond",
              details: final.details,
            },
          },
        }),
      }),
    );

    const replayEvents: ProviderEvent[] = [];
    const replayProjector = new OmpTimelineProjector(
      "mixed-replay-session",
      (event) => replayEvents.push(event),
      new ManualScheduler(),
    );
    replayProjector.projectReplayMessage({
      role: "assistant",
      responseId: "mixed-replay-response",
      content: [
        {
          type: "toolCall",
          id: "mixed-replay-result",
          name: "vendor_tool",
          arguments: { operation: "replay" },
        },
      ],
    });
    replayProjector.projectReplayMessage({
      role: "toolResult",
      toolCallId: "mixed-replay-result",
      toolName: "vendor_tool",
      content: final.content,
      details: final.details,
    });

    const replayCompleted = replayEvents.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "vendor_tool" &&
        event.item.status === "completed",
    );
    expect(
      replayCompleted?.type === "timeline.item" && replayCompleted.item.type === "tool_call"
        ? replayCompleted.item.detail
        : undefined,
    ).toEqual({
      type: "unknown",
      input: { operation: "replay" },
      output: { content: outputWithoutImage.content, details: final.details },
    });
    expect(
      replayEvents.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "omp:tool:1:images" &&
          event.item.status === "completed",
      ),
    ).toBe(true);
  });

  test("redacts configured values in structured unknown image output and replay", () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const result = {
      content: [
        { type: "record", value: { key: "configured-secret", rows: [1, 2] } },
        image,
        { type: "text", text: "result configured-secret" },
      ],
      details: { source: "configured-secret" },
    };
    const redactedPartial = {
      content: [
        { type: "record", value: { key: "<redacted>", rows: [1, 2] } },
        image,
        { type: "text", text: "result <redacted>" },
      ],
      details: { source: "<redacted>" },
    };
    const redactedFinal = {
      content: [redactedPartial.content[0], redactedPartial.content[2]],
      details: redactedPartial.details,
    };
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "redacted-result-session",
      (event) => events.push(event),
      new ManualScheduler(),
      ["configured-secret"],
    );

    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "redacted-result",
        toolName: "vendor_tool",
        args: {},
      },
      "redacted-result-turn",
    );
    projector.project(
      {
        type: "tool_execution_update",
        toolCallId: "redacted-result",
        toolName: "vendor_tool",
        partialResult: result,
      },
      "redacted-result-turn",
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "redacted-result",
        toolName: "vendor_tool",
        result,
      },
      "redacted-result-turn",
    );

    const snapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "vendor_tool"
        ? [event.item]
        : [],
    );
    expect(snapshots.map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: "running", detail: { type: "unknown", input: {}, output: null } },
      {
        status: "running",
        detail: { type: "unknown", input: {}, output: redactedPartial },
      },
      {
        status: "completed",
        detail: { type: "unknown", input: {}, output: redactedFinal },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          id: "omp:tool:1:images",
          metadata: expect.objectContaining({
            ompImage: expect.objectContaining({
              text: "result <redacted>",
              details: redactedPartial.details,
            }),
          }),
        }),
      }),
    );

    const replayEvents: ProviderEvent[] = [];
    const replayProjector = new OmpTimelineProjector(
      "redacted-replay-session",
      (event) => replayEvents.push(event),
      new ManualScheduler(),
      ["configured-secret"],
    );
    replayProjector.projectReplayMessage({
      role: "toolResult",
      toolCallId: "redacted-replay-result",
      toolName: "vendor_tool",
      content: result.content,
      details: result.details,
    });
    const replayCompleted = replayEvents.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "vendor_tool" &&
        event.item.status === "completed",
    );
    expect(
      replayCompleted?.type === "timeline.item" && replayCompleted.item.type === "tool_call"
        ? replayCompleted.item.detail
        : undefined,
    ).toEqual({ type: "unknown", input: null, output: redactedFinal });
  });

  test("preserves unknown structures while typed details omit absent text", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "structured-result-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );
    const turnId = "structured-result-turn";
    const input = { operation: "inspect", options: { depth: 2 } };
    const partial = {
      output: "partial summary",
      data: { rows: [{ id: 1, active: true }] },
      content: [{ type: "record", value: { key: "partial" } }],
    };
    const final = {
      output: "final summary",
      stdout: "not selected",
      text: "not selected either",
      data: { rows: [{ id: 1, active: true }], cursor: null },
      content: [{ type: "record", value: { key: "final" } }],
      details: { elapsedMs: 12 },
    };

    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "structured-result",
        toolName: "vendor_tool",
        args: input,
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_update",
        toolCallId: "structured-result",
        toolName: "vendor_tool",
        partialResult: partial,
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "structured-result",
        toolName: "vendor_tool",
        result: final,
      },
      turnId,
    );

    const unknownSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "vendor_tool"
        ? [event.item]
        : [],
    );
    expect(unknownSnapshots).toEqual([
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "vendor_tool",
        detail: { type: "unknown", input, output: null },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "vendor_tool",
        detail: { type: "unknown", input, output: partial },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "vendor_tool",
        detail: { type: "unknown", input, output: final },
        status: "completed",
        error: null,
      },
    ]);

    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "structured-read",
        toolName: "read",
        args: { path: "structured.txt" },
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "structured-read",
        toolName: "read",
        result: {
          data: { rows: [1, 2] },
          content: [{ type: "resource", uri: "file:///structured.txt" }],
        },
      },
      turnId,
    );
    const completedRead = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read" &&
        event.item.status === "completed",
    );
    expect(
      completedRead?.type === "timeline.item" && completedRead.item.type === "tool_call"
        ? completedRead.item.detail
        : undefined,
    ).toEqual({ type: "read", filePath: "structured.txt" });

    const errorResult = {
      stdout: "permission denied",
      code: 13,
      data: { operation: "read", retryable: false },
    };
    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "failed-read",
        toolName: "read",
        args: { path: "forbidden.txt" },
      },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "failed-read",
        toolName: "read",
        result: errorResult,
        isError: true,
      },
      turnId,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: {
          type: "tool_call",
          id: "omp:tool:3",
          callId: "omp:tool:3",
          name: "read",
          detail: { type: "read", filePath: "forbidden.txt", content: "permission denied" },
          status: "failed",
          error: errorResult,
        },
      }),
    );
  });

  test("projects Windows drive paths as read details", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "windows-read-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );
    const filePath = String.raw`C:\Users\private\file.txt`;

    projector.project(
      {
        type: "tool_execution_start",
        toolCallId: "windows-read",
        toolName: "read",
        args: { path: filePath },
      },
      "windows-read-turn",
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "windows-read",
        toolName: "read",
        result: "file contents",
      },
      "windows-read-turn",
    );

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "tool_call"
          ? [event.item.detail]
          : [],
      ),
    ).toEqual([
      { type: "read", filePath },
      { type: "read", filePath, content: "file contents" },
    ]);
  });

  test("publishes partial snapshots immediately and completes tools from final results", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector(
      "partial-snapshot-session",
      (event) => events.push(event),
      new ManualScheduler(),
    );
    const turnId = "partial-snapshot-turn";

    projector.project(
      {
        type: "message_start",
        message: { role: "assistant", content: [], responseId: "partial-response" },
      },
      turnId,
    );
    projector.project(
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "tests" },
            { type: "thinking", thinking: "alpha" },
          ],
          responseId: "partial-response",
        },
      },
      turnId,
    );
    projector.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ type: "assistant_message", text: "tests" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ type: "reasoning", text: "alpha" }),
      }),
    );

    projector.project({ type: "command_output", text: "sync" }, turnId);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ type: "assistant_message", text: "sync" }),
      }),
    );

    projector.project(
      { type: "tool_execution_start", toolCallId: "suffix-p", toolName: "custom", args: {} },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_update",
        toolCallId: "suffix-p",
        toolName: "custom",
        partialResult: { content: "help" },
      },
      turnId,
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          status: "running",
          detail: expect.objectContaining({ output: expect.objectContaining({ content: "help" }) }),
        }),
      }),
    );

    projector.project(
      { type: "tool_execution_start", toolCallId: "suffix-r", toolName: "custom", args: {} },
      turnId,
    );
    projector.project(
      {
        type: "tool_execution_update",
        toolCallId: "suffix-r",
        toolName: "custom",
        partialResult: { content: "Au" },
      },
      turnId,
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          status: "running",
          detail: expect.objectContaining({ output: expect.objectContaining({ content: "Au" }) }),
        }),
      }),
    );
    projector.project(
      {
        type: "tool_execution_end",
        toolCallId: "suffix-r",
        toolName: "custom",
        result: { content: "render" },
      },
      turnId,
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          status: "completed",
          detail: expect.objectContaining({
            output: expect.objectContaining({ content: "render" }),
          }),
        }),
      }),
    );
  });

  test("redacts only configured values across root output surfaces", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextInheritedRedactionValues = ["inherited-setting-value"];
    const { connection, events, scheduler } = await createHostToolHarness(runtime);
    await openSession(
      connection,
      events,
      "configured-redaction-open",
      "session-1",
      { MY_RUNTIME_SECRET: "credential-value-1234", SHORT_TOKEN: "xyz" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      {
        providerOptions: {
          outputRedaction: "configured-values",
          env: { LICENSE_SECRET: "license-secret" },
        },
        mcpServers: {
          local: {
            type: "stdio",
            command: "server",
            env: { MCP_SECRET: "custom-secret", SHORT: "abc" },
          },
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "mcp-header-secret", "X-Short": "xyz" },
          },
        },
      },
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "preserved-prompt", "work"));
    const session = sessionAt(runtime);
    session.emit({
      type: "notice",
      id: "provider-internal-notice-id",
      level: "warning",
      message: "credential-value-1234 at /home/private/config",
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "inherited-setting-value",
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "provider-internal-tool-id",
      toolName: "read",
      args: JSON.parse(
        '{"__proto__":{"polluted":"yes"},"apiKey":"another-secret","/home/private":"first","literal":"second"}',
      ),
    });
    for (const message of [
      "Authorization=Basic basic-equals-secret",
      "Authorization: Token token-scheme-secret",
      "Authorization: Digest username=user, nonce=digest-nonce; response=digest-response\r\n\tqop=auth\nFollowing line",
      "Authorization=AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=host, Signature=aws-signature\nNext line",
    ]) {
      session.emit({ type: "notice", level: "warning", message });
    }
    session.emit({
      type: "tool_execution_start",
      toolCallId: "credential-value-1234",
      toolName: "write",
      args: { value: "safe" },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      args: { value: "safe" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      partialResult: { content: "Authorization: Basic tool-secret" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      result: { content: "Authorization: Basic tool-secret" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "credential-value-1234",
      toolName: "write",
      partialResult: { content: "credential-value-1234" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "credential-value-1234",
      toolName: "write",
      result: { content: "credential-value-1234" },
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "Authorization: Bearer token-not-from-env",
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "Authorization: Basic basic-token-not-from-env",
    });
    session.emit({ type: "notice", level: "warning", message: "license-secret" });
    session.emit({ type: "notice", level: "warning", message: "custom-secret" });
    session.emit({ type: "notice", level: "warning", message: "mcp-header-secret" });
    session.emit({ type: "notice", level: "warning", message: "xyz" });
    session.emit({ type: "command_output", text: "credential-value-1234" });
    session.emit({ type: "command_output", text: " ghp_abcdefgh" });
    for (const [type, contentIndex, value] of [
      ["text_delta", 1, "Bearer alpha"],
      ["thinking_delta", 2, "Bearer alpha"],
      ["text_delta", 3, "credential-value-1234"],
      ["thinking_delta", 4, "credential-value-1234"],
      ["text_delta", 5, "ghp_abcdefgh"],
      ["thinking_delta", 6, "Authorization: Basic header-secret"],
    ] as const) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, delta: value },
        message: { role: "assistant", responseId: "split-stream", content: [] },
      });
      await scheduler.flush();
    }
    const formattedText = "```ts\n\tconst value = 1;\r\n```";
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "whitespace-stream",
        content: [{ type: "text", text: formattedText }],
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "credential-value-1234",
      },
      message: {
        role: "assistant",
        responseId: "provider-internal-response-id",
        content: [{ type: "text", text: "credential-value-1234 from /home/private/file" }],
      },
    });
    await scheduler.flush();

    const visible = JSON.stringify(events);
    for (const configuredValue of [
      "credential-value-1234",
      "license-secret",
      "custom-secret",
      "mcp-header-secret",
      "inherited-setting-value",
    ]) {
      expect(visible).not.toContain(configuredValue);
    }
    expect(visible).toContain("another-secret");
    expect(visible).not.toContain("provider-internal-notice-id");
    expect(visible).not.toContain("provider-internal-tool-id");
    expect(visible).not.toContain("provider-internal-response-id");
    expect(visible).toContain("/home/private");
    expect(visible).toContain("xyz");
    const notificationMessages = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "notification"
        ? [event.item.message]
        : [],
    );
    expect(notificationMessages).toEqual(
      expect.arrayContaining([
        "<redacted> at /home/private/config",
        "Authorization=Basic basic-equals-secret",
        "Authorization: Token token-scheme-secret",
        "Authorization: Digest username=user, nonce=digest-nonce; response=digest-response\r\n\tqop=auth\nFollowing line",
        "Authorization=AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=host, Signature=aws-signature\nNext line",
        "Authorization: Bearer token-not-from-env",
        "Authorization: Basic basic-token-not-from-env",
        "xyz",
      ]),
    );
    expect(notificationMessages.filter((message) => message === "<redacted>")).toHaveLength(4);
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === formattedText,
      ),
    ).toBe(true);
    const splitAssistant = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:1:text"),
    );
    const splitReasoning = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:2:reasoning"),
    );
    expect(
      splitAssistant?.type === "timeline.item" && splitAssistant.item.type === "assistant_message"
        ? splitAssistant.item.text
        : null,
    ).toBe("Bearer alpha");
    expect(
      splitReasoning?.type === "timeline.item" && splitReasoning.item.type === "reasoning"
        ? splitReasoning.item.text
        : null,
    ).toBe("Bearer alpha");
    const literalSplitAssistant = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:3:text"),
    );
    const literalSplitReasoning = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:4:reasoning"),
    );
    expect(
      literalSplitAssistant?.type === "timeline.item" &&
        literalSplitAssistant.item.type === "assistant_message"
        ? literalSplitAssistant.item.text
        : null,
    ).toBe("<redacted>");
    expect(
      literalSplitReasoning?.type === "timeline.item" &&
        literalSplitReasoning.item.type === "reasoning"
        ? literalSplitReasoning.item.text
        : null,
    ).toBe("<redacted>");
    const command = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.startsWith("omp:command:"),
    );
    expect(
      command?.type === "timeline.item" && command.item.type === "assistant_message"
        ? command.item.text
        : null,
    ).toBe("<redacted> ghp_abcdefgh");
    const streamedTool = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "write" &&
      event.item.detail.type === "unknown"
        ? [event.item.detail.output]
        : [],
    );
    expect(streamedTool).toEqual([null, { content: "<redacted>" }, { content: "<redacted>" }]);
    const deferredTool = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "auth-write" &&
      event.item.detail.type === "unknown"
        ? [event.item.detail.output]
        : [],
    );
    expect(deferredTool).toEqual([
      null,
      { content: "Authorization: Basic tool-secret" },
      { content: "Authorization: Basic tool-secret" },
    ]);
    const splitToken = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:5:text"),
    );
    const splitAuthorization = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:6:reasoning"),
    );
    expect(
      splitToken?.type === "timeline.item" && splitToken.item.type === "assistant_message"
        ? splitToken.item.text
        : null,
    ).toBe("ghp_abcdefgh");
    expect(
      splitAuthorization?.type === "timeline.item" && splitAuthorization.item.type === "reasoning"
        ? splitAuthorization.item.text
        : null,
    ).toBe("Authorization: Basic header-secret");
    const toolIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item.callId] : [],
    );
    expect(new Set(toolIds).size).toBe(3);
    expect(JSON.stringify(toolIds)).not.toContain("credential-value-1234");
    const firstTool = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    if (
      firstTool?.type !== "timeline.item" ||
      firstTool.item.type !== "tool_call" ||
      firstTool.item.detail.type !== "unknown"
    ) {
      throw new Error("Expected bounded tool item");
    }
    const detailInput = firstTool.item.detail.input;
    if (!detailInput || typeof detailInput !== "object" || Array.isArray(detailInput)) {
      throw new Error("Expected bounded tool input object");
    }
    expect(Object.getPrototypeOf(detailInput)).toBeNull();
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(Object.keys(detailInput)).toEqual(["apiKey", "/home/private", "literal"]);
    expect(detailInput.apiKey).toBe("another-secret");

    const terminal = await finishTurn(events, session, turnId);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });
  test("bounds aggregate retained bytes across many active tools", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "tool-budget", "work"));
    const session = sessionAt(runtime);
    for (let index = 0; index < 64; index += 1) {
      session.emit({
        type: "tool_execution_start",
        toolCallId: `large-tool-${index}`,
        toolName: "read",
        args: { content: "x".repeat(100 * 1024) },
      });
    }
    const publicTools = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(publicTools.length).toBeGreaterThan(0);
    expect(publicTools.length).toBeLessThan(64);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("publishes two 2 MiB blocks and redacts before the four MiB display bound", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    runtime.nextInheritedRedactionValues = ["abcd"];
    await openSession(
      connection,
      events,
      "byte-limit-open",
      "session-1",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "byte-limit", "work"));
    const session = sessionAt(runtime);
    const twoMiB = "é".repeat(1024 * 1024);
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "two-blocks",
        content: [
          { type: "text", text: twoMiB },
          { type: "thinking", thinking: twoMiB },
        ],
      },
    });
    await scheduler.flush();

    const published = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [event.item]
        : [],
    );
    expect(published).toEqual([
      expect.objectContaining({ type: "assistant_message", text: twoMiB }),
      expect.objectContaining({ type: "reasoning", text: twoMiB }),
    ]);

    const displayLimit = 4 * 1024 * 1024;
    const boundaryPrefix = "x".repeat(displayLimit - 2);
    const boundaryBaseline = events.length;
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "boundary-secret",
        content: [{ type: "text", text: `${boundaryPrefix}abcd` }],
        stopReason: "stop",
      },
    });
    const boundaryItems = events
      .slice(boundaryBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "assistant_message"
          ? [event.item]
          : [],
      );
    expect(boundaryItems).toHaveLength(1);
    expect(Buffer.byteLength(boundaryItems[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(
      displayLimit,
    );
    expect(boundaryItems[0]?.text).toMatch(/<truncated>$/u);
    expect(boundaryItems[0]?.text).not.toContain("abcd");

    const expandingBlock = "abcd".repeat((2 * 1024 * 1024) / 4);
    const expansionBaseline = events.length;
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "expanding-blocks",
        content: [
          { type: "text", text: expandingBlock },
          { type: "thinking", thinking: expandingBlock },
        ],
        stopReason: "stop",
      },
    });
    const expandedItems = events
      .slice(expansionBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" &&
        (event.item.type === "assistant_message" || event.item.type === "reasoning")
          ? [event.item]
          : [],
      );
    expect(expandedItems).toHaveLength(1);
    expect(
      expandedItems.reduce((bytes, item) => bytes + Buffer.byteLength(item.text, "utf8"), 0),
    ).toBeLessThanOrEqual(displayLimit);
    expect(expandedItems[0]?.text).toMatch(/<truncated>$/u);
    expect(expandedItems[0]?.text).not.toContain("abcd");
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("fails unsupported interactive permission UI without reflecting its payload", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-turn", "work"));
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "permission-request",
      method: "confirm",
      title: "Approve API_KEY=secret-value from /home/private/file",
      message: "Continue?",
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP runtime failed" } }),
    );
    const visible = JSON.stringify(events);
    expect(visible).not.toContain("secret-value");
    expect(visible).not.toContain("/home/private/file");
    expect(visible).not.toContain("permission-request");
    await connection.close();
  });
});
