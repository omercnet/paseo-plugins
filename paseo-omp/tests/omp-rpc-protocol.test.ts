import { describe, expect, test } from "vitest";
import type { OmpSpawnRequest } from "../server/provider/omp-rpc-environment";
import type { OmpRpcEvent } from "../server/provider/omp-rpc-protocol";
import {
  FakeRpcChild,
  NATIVE_TOOL_APPROVAL_FRAME_BYTES,
  nextEvent,
  observeCommands,
  READY_FRAME,
  READY_WITH_TYPED_APPROVALS,
  runtimeFor,
  writeChunked,
} from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  test("accepts a bounded multi-provider model catalog without relaxing other response limits", async () => {
    const child = new FakeRpcChild();
    let oversized = false;
    const models = Array.from({ length: 53 }, (_, index) => ({
      provider: `provider-${index % 3}`,
      id: `model-${index}`,
      reasoning: true,
      thinking: {
        efforts: Array.from({ length: 16 }, (_, n) => `effort-${n}`),
        defaultLevel: "high",
      },
      input: Array.from({ length: 16 }, (_, n) => `input-${n}`),
      contextWindow: 200_000,
    }));
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            models: oversized
              ? models.map((model) => ({ ...model, extra: Array(512).fill(0) }))
              : models,
          },
        });
      } else if (command.type === "get_state") {
        writeChunked(
          child,
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              model: null,
              isStreaming: false,
              isCompacting: false,
              sessionId: "bounded-state",
              systemPrompt: "secret prompt".repeat(200_000),
              dumpTools: Array.from({ length: 10_000 }, (_, index) => ({
                name: `tool-${index}`,
                description: "x".repeat(256),
              })),
            },
          },
          "large-ignored-state",
        );
      } else if (command.type === "get_session_stats") {
        child.write({ type: "response", id: command.id, success: true, data: { nested: models } });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    try {
      await expect(session.getState()).resolves.toEqual({
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "bounded-state",
      });
      await expect(session.getSessionStats()).rejects.toThrow("response exceeded command limits");
      oversized = true;
      await expect(session.getAvailableModels()).rejects.toThrow(
        "response exceeded command limits",
      );
    } finally {
      await session.close();
    }
  });

  test("sends steering and out-of-band commands with native wire shapes", async () => {
    const child = new FakeRpcChild();
    const launches: OmpSpawnRequest[] = [];
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "set_auto_compaction" || command.type === "handoff") {
        child.write({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: {},
        });
      }
    });
    const runtime = runtimeFor(child, launches);
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    expect(session.maxInputFrameBytes).toBe(READY_FRAME.maxFrameBytes);
    const promptResult = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "prompt_result", id: "prompt-1", agentInvoked: false });
    await expect(promptResult).resolves.toEqual({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    });

    const correlatedEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "agent_end",
      requestId: "prompt-2",
      messages: [],
      isTerminal: true,
    });
    await expect(correlatedEnd).resolves.toEqual({
      type: "agent_end",
      requestId: "prompt-2",
      messages: [],
      isTerminal: true,
    });

    await session.steer("focus");
    await session.followUp("verify");
    await session.setAutoCompaction(false);
    await session.handoff("implement now");

    expect(launches[0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--mode", "rpc-ui", "--approval-mode", "yolo"]),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "negotiate_protocol", protocolVersion: 2 }),
    );
    expect(commands).toContainEqual({
      type: "steer",
      message: "focus",
    });
    expect(commands).toContainEqual({ type: "follow_up", message: "verify" });
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "set_auto_compaction", enabled: false }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "handoff", customInstructions: "implement now" }),
    );
    await session.close();
  });

  test("negotiates and correlates bounded typed tool approvals only when advertised", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    expect(session.supportsTypedToolApprovals).toBe(true);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "negotiate_protocol",
        clientCapabilities: { typedToolApprovals: 1 },
      }),
    );

    const request = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "approval-1",
      toolCallId: "tool-call-1",
      toolKind: "shell",
      toolName: "bash",
      tier: "exec",
      identity: { kind: "shell", command: "git status" },
      input: { command: "git status", token: "[redacted]" },
      detail: {
        lines: ["Command: git status"],
        truncated: false,
        truncatedFields: [],
        redacted: true,
        redactedFields: ["input.token"],
      },
    });
    await expect(request).resolves.toMatchObject({
      type: "tool_approval_request",
      id: "approval-1",
      identity: { kind: "shell", command: "git status" },
    });
    await session.respondToToolApproval({
      type: "tool_approval_response",
      id: "approval-1",
      toolCallId: "tool-call-1",
      approved: true,
    });
    expect(commands).toContainEqual({
      type: "tool_approval_response",
      id: "approval-1",
      toolCallId: "tool-call-1",
      approved: true,
    });
    await session.close();
  });

  test("accepts native maximum approval identity and aggregate envelope bounds", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    const metadata = [...Array.from({ length: 32 }, (_, index) => `field-${index}`), "additional"];
    const shell = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "max-shell",
      toolCallId: "max-shell-call",
      toolKind: "shell",
      toolName: "bash",
      tier: "exec",
      identity: { kind: "shell", command: "x".repeat(24 * 1024) },
      input: {},
      detail: {
        lines: [],
        truncated: true,
        truncatedFields: metadata,
        redacted: true,
        redactedFields: metadata,
      },
    });
    await expect(shell).resolves.toMatchObject({ type: "tool_approval_request", id: "max-shell" });

    const write = nextEvent((listener) => session.onEvent(listener));
    const aggregate = {
      type: "tool_approval_request" as const,
      id: "max-write",
      toolCallId: "max-write-call",
      toolKind: "write" as const,
      toolName: "write",
      tier: "write" as const,
      identity: { kind: "write" as const, path: "out.txt", content: "w".repeat(20 * 1024) },
      input: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`value-${index}`, "x".repeat(8 * 1024)]),
      ),
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    };
    aggregate.input.tail = "";
    aggregate.input.tail = "x".repeat(
      NATIVE_TOOL_APPROVAL_FRAME_BYTES - Buffer.byteLength(JSON.stringify(aggregate), "utf8") - 1,
    );
    expect(Buffer.byteLength(aggregate.input.tail, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(JSON.stringify(aggregate), "utf8") + 1).toBe(
      NATIVE_TOOL_APPROVAL_FRAME_BYTES,
    );
    child.write(aggregate);
    await expect(write).resolves.toMatchObject({ type: "tool_approval_request", id: "max-write" });
    const edit = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "max-edit",
      toolCallId: "max-edit-call",
      toolKind: "edit",
      toolName: "edit",
      tier: "write",
      identity: { kind: "edit", paths: ["src/a.ts"], content: "e".repeat(20 * 1024) },
      input: {},
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    });
    await expect(edit).resolves.toMatchObject({ type: "tool_approval_request", id: "max-edit" });
    await session.close();
  });

  test("rejects above-native approval fields and cancels matching native requests", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    const canceled = Promise.withResolvers<void>();
    observeCommands(child, (command) => {
      commands.push(command);
      if (
        command.type === "tool_approval_response" &&
        commands.filter((candidate) => candidate.type === "tool_approval_response").length === 3
      ) {
        canceled.resolve();
      }
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    for (const [id, toolCallId, toolKind, identity] of [
      [
        "over-shell",
        "over-shell-call",
        "shell",
        { kind: "shell", command: "x".repeat(24 * 1024 + 1) },
      ],
      [
        "over-edit",
        "over-edit-call",
        "edit",
        { kind: "edit", paths: ["a.ts"], content: "x".repeat(20 * 1024 + 1) },
      ],
      [
        "over-write",
        "over-write-call",
        "write",
        { kind: "write", path: "a.ts", content: "x".repeat(20 * 1024 + 1) },
      ],
    ] as const) {
      child.write({
        type: "tool_approval_request",
        id,
        toolCallId,
        toolKind,
        toolName: toolKind,
        tier: "write",
        identity,
        input: {},
        detail: {
          lines: [],
          truncated: false,
          truncatedFields: [],
          redacted: false,
          redactedFields: [],
        },
      });
    }
    await canceled.promise;
    expect(commands).toEqual(
      expect.arrayContaining([
        {
          type: "tool_approval_response",
          id: "over-shell",
          toolCallId: "over-shell-call",
          cancelled: true,
        },
        {
          type: "tool_approval_response",
          id: "over-edit",
          toolCallId: "over-edit-call",
          cancelled: true,
        },
        {
          type: "tool_approval_response",
          id: "over-write",
          toolCallId: "over-write-call",
          cancelled: true,
        },
      ]),
    );
    await session.close();
  });

  test("keeps typed approvals disabled for older OMP ready frames", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_FRAME);
    const session = await opening;
    expect(session.supportsTypedToolApprovals).toBe(false);
    expect(commands.find((command) => command.type === "negotiate_protocol")).not.toHaveProperty(
      "clientCapabilities",
    );
    await session.close();
  });

  test("preserves a bounded late prompt scheduling failure after success acknowledgement", async () => {
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
      }
      if (command.type === "prompt") {
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        queueMicrotask(() => {
          child.write({
            type: "response",
            id: command.id,
            command: "prompt",
            success: false,
            error: "Session is already processing a prompt",
            code: "session_busy",
          });
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    const acknowledgement = await session.prompt("work");
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: acknowledgement.requestId,
      error: "Session is already processing a prompt",
      code: "session_busy",
    });
    await session.close();
  });

  test.each([
    [
      "malformed error",
      { error: { message: "unsafe" }, code: "session_busy" },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    [
      "deep malformed error",
      {
        error: Array.from({ length: 17 }).reduce<unknown>((cause) => ({ cause }), "unsafe"),
        code: "session_busy",
      },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    [
      "oversized error",
      { error: "é".repeat(2_049), code: "session_busy" },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    ["malformed code", { error: "native failure", code: 42 }, { error: "native failure" }],
    [
      "wide malformed code",
      { error: "native failure", code: Array(1_025).fill("unsafe") },
      { error: "native failure" },
    ],
    [
      "oversized code",
      { error: "native failure", code: "é".repeat(129) },
      { error: "native failure" },
    ],
  ])("sanitizes %s in late prompt scheduling failures", async (_name, rejected, expected) => {
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
      }
      if (command.type === "prompt") {
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        queueMicrotask(() => {
          child.write({
            type: "response",
            id: command.id,
            command: "prompt",
            success: false,
            ...rejected,
          });
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    const acknowledgement = await session.prompt("work");
    child.write({ type: "notice", level: "info", message: "after failure" });
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: acknowledgement.requestId,
      ...expected,
    });
    await session.close();
  });

  test("ignores unmatched prompt failures", async () => {
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
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const next = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: "unknown-prompt",
      command: "prompt",
      success: false,
      error: "Session is already processing a prompt",
      code: "session_busy",
    });
    child.write({ type: "notice", level: "info", message: "still healthy" });
    await expect(next).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });

  test("ignores a repeated success response for an accepted prompt", async () => {
    const child = new FakeRpcChild();
    let promptId: string | undefined;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "prompt") {
        promptId = command.id as string;
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await session.prompt("work");
    const next = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: promptId,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    child.write({ type: "notice", level: "info", message: "still healthy" });
    await expect(next).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    const failure = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: promptId,
      command: "prompt",
      success: false,
      error: "native failure",
      code: "session_busy",
    });
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: promptId,
      error: "native failure",
      code: "session_busy",
    });
    await session.close();
  });

  test("retains active tool correlation across agent_end", async () => {
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
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));
    child.write({
      type: "tool_execution_start",
      toolCallId: "ask-1",
      toolName: "ask_user",
      args: { questions: [] },
    });
    child.write({ type: "agent_end", messages: [], isTerminal: true });
    child.write({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask_user",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await Promise.resolve();
    expect(received.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "agent_end",
      "tool_execution_end",
    ]);
    await session.close();
  });

  test("accepts current goal retry compaction and subagent events", async () => {
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
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const futureSelector = `provider/${"m".repeat(4_096)}:future-thinking`;
    const frames: OmpRpcEvent[] = [
      { type: "model_changed" },
      { type: "thinking_level_changed", thinkingLevel: "future-thinking" },
      {
        type: "retry_fallback_applied",
        from: futureSelector,
        to: futureSelector,
        role: futureSelector,
      },
      {
        type: "retry_fallback_succeeded",
        model: futureSelector,
        role: futureSelector,
      },
      {
        type: "goal_updated",
        goal: {
          id: "goal-1",
          objective: "Ship the provider",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 2_000,
          timeUsedSeconds: 42,
          createdAt: "2026-09-11T00:00:00Z",
          updatedAt: "2026-09-11T00:01:00Z",
        },
        state: { enabled: true, mode: "focused", reason: "user requested", goal: undefined },
      },
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 4,
        delayMs: 1_500,
        errorMessage: "rate limited",
        errorId: 429,
      },
      {
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "still rate limited",
        recoveredErrors: [{ id: 429 }],
      },
      { type: "auto_compaction_start", reason: "future", action: "future-action" },
      { type: "auto_compaction_end", aborted: false, willRetry: false },
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          agent: "scout",
          agentSource: "builtin",
          description: "Inspect protocol",
          status: "started",
          sessionFile: "/tmp/child.jsonl",
          parentToolCallId: "tool-1",
          index: 0,
          detached: false,
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect protocol",
          progress: {
            id: "child-1",
            status: "running",
            description: "Reading schemas",
            currentTool: { name: "read" },
            recentTools: [{ name: "grep" }],
            recentOutput: [{ text: "found" }],
            resolvedModel: "openai/gpt-5.4",
          },
        },
      },
      {
        type: "message_end",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/repo",
          exitCode: 0,
          timestamp: 1,
          images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "advisor",
          content: "",
          details: {
            notes: [{ note: "Fix the race", severity: "blocker", advisor: "reviewer" }],
          },
        },
      },
      { type: "subagent_event", payload: { id: "child-1", event: { type: "agent_start" } } },
    ];

    for (const frame of frames) {
      const received = nextEvent((listener) => session.onEvent(listener));
      child.write(frame);
      await expect(received).resolves.toEqual(frame);
    }
    const afterMalformed = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "goal_updated",
      goal: { id: "goal-oversized", status: "x".repeat(257) },
    });
    child.write({ type: "notice", level: "info", message: "after malformed current event" });
    await expect(afterMalformed).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "after malformed current event",
    });
    await session.close();
  });

  test("rejects cross-kind extension UI fields", async () => {
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
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));

    for (const frame of [
      {
        type: "extension_ui_request",
        id: "bad-select",
        method: "select",
        title: "Select",
        options: ["one"],
        url: "https://example.com/?token=secret",
      },
      {
        type: "extension_ui_request",
        id: "bad-confirm",
        method: "confirm",
        title: "Confirm",
        message: "Proceed?",
        launchUrl: "javascript:alert(1)",
      },
      {
        type: "extension_ui_request",
        id: "bad-input",
        method: "input",
        title: "Input",
        url: "file:///private/token",
      },
      {
        type: "extension_ui_request",
        id: "bad-editor",
        method: "editor",
        title: "Editor",
        launchUrl: "https://example.com/?code=secret",
      },
    ]) {
      child.write(frame);
    }
    child.write({ type: "notice", level: "info", message: "after invalid UI frames" });
    await Promise.resolve();
    expect(received).toEqual([
      { type: "notice", level: "info", message: "after invalid UI frames" },
    ]);
    await session.close();
  });

  test("registers essential host tools and returns host call frames", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "set_host_tools") {
        child.write({
          type: "response",
          id: command.id,
          command: "set_host_tools",
          success: true,
          data: { toolNames: ["mcp__paseo_read"] },
        });
      }
    });
    const sessionOpening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await sessionOpening;

    await expect(
      session.setHostTools([
        {
          name: "mcp__paseo_read",
          label: "Read",
          description: "Read a caller-scoped workspace file",
          loadMode: "essential",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ]),
    ).resolves.toEqual(["mcp__paseo_read"]);
    session.sendHostToolUpdate({
      type: "host_tool_update",
      id: "host-call-1",
      partialResult: { content: [], details: { progress: 1 } },
    });
    session.sendHostToolResult({
      type: "host_tool_result",
      id: "host-call-1",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await Promise.resolve();

    expect(commands).toContainEqual({
      type: "set_host_tools",
      tools: [expect.objectContaining({ name: "mcp__paseo_read", loadMode: "essential" })],
      id: expect.any(String),
    });
    expect(commands).toContainEqual({
      type: "host_tool_update",
      id: "host-call-1",
      partialResult: { content: [], details: { progress: 1 } },
    });
    expect(commands).toContainEqual({
      type: "host_tool_result",
      id: "host-call-1",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await session.close();
  });

  test("subscribes to bounded subagent lifecycle, timelines, snapshots, and replay", async () => {
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
      } else if (command.type === "set_subagent_subscription") {
        child.write({
          type: "response",
          id: command.id,
          command: "set_subagent_subscription",
          success: true,
          data: { level: "events" },
        });
      } else if (command.type === "get_subagents") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_subagents",
          success: true,
          data: {
            subagents: [
              {
                id: "native-child",
                index: 0,
                agent: "scout",
                status: "running",
                sessionFile: "/sessions/root/native-child.jsonl",
                lastUpdate: 1,
                parentToolCallId: "task-call",
              },
            ],
          },
        });
      } else if (command.type === "get_subagent_messages") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_subagent_messages",
          success: true,
          data: {
            sessionFile: "/sessions/root/native-child.jsonl",
            fromByte: 0,
            nextByte: 10,
            reset: false,
            entries: [],
            messages: [
              {
                role: "toolResult",
                toolCallId: "nested-task",
                toolName: "task",
                content: [],
                details: { results: [{ id: "native-grandchild" }] },
              },
            ],
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await session.setSubagentSubscription("events");
    await expect(session.getSubagents()).resolves.toEqual([
      expect.objectContaining({ id: "native-child", status: "running" }),
    ]);
    await expect(session.getSubagentMessages({ subagentId: "native-child" })).resolves.toEqual(
      expect.objectContaining({
        sessionFile: "/sessions/root/native-child.jsonl",
        messages: [
          expect.objectContaining({ details: { results: [{ id: "native-grandchild" }] } }),
        ],
      }),
    );
    const frames: OmpRpcEvent[] = [
      {
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "scout",
          status: "started",
          index: 0,
          sessionFile: "/sessions/root/native-child.jsonl",
          parentToolCallId: "task-call",
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "inspect",
          progress: { id: "native-child", status: "running", recentOutput: ["working"] },
          sessionFile: "/sessions/root/native-child.jsonl",
          parentToolCallId: "task-call",
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "native-child",
          event: {
            type: "message_end",
            message: { role: "assistant", responseId: "child-answer", content: "done" },
          },
        },
      },
    ];
    for (const frame of frames) {
      const received = nextEvent((listener) => session.onEvent(listener));
      child.write(frame);
      await expect(received).resolves.toEqual(frame);
    }
    await session.close();
  });
});
