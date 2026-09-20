import { AgentPermissionRequestPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
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
  test("publishes and executes OMP out-of-band commands", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const commands = events.findLast((event) => event.type === "session.commands");
    if (commands?.type !== "session.commands") throw new Error("Expected OMP command catalog");
    expect(commands.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["compact", "autocompact", "handoff", "steer", "follow-up"]),
    );

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "autocompact-command",
        delivery: "auto",
        input: { type: "command", name: "autocompact", arguments: "off" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "autocompact-command",
    );
    expect(session.autoCompactionChanges).toEqual([false]);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "autocompact-toggle",
        delivery: "auto",
        input: { type: "command", name: "autocompact", arguments: "toggle" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "autocompact-toggle",
    );
    expect(session.autoCompactionChanges).toEqual([false, true]);
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: expect.objectContaining({
        type: "assistant_message",
        text: "Auto-compaction disabled.",
      }),
    });

    for (const [name, argumentsText] of [
      ["handoff", "finish implementation"],
      ["follow-up", "run verification"],
    ] as const) {
      const clientMessageId = `${name}-command`;
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input: { type: "command", name, arguments: argumentsText },
        },
      });
      const result = await events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
      );
      const commandTurnId = turnIdFrom(result);
      expect(events).toContainEqual({
        type: "session.turn",
        sessionId: "session-1",
        turnId: commandTurnId,
        state: "started",
      });
      session.emit({
        type: "message_start",
        message: { role: "assistant", responseId: `${name}-response`, content: [] },
      });
      session.emit({
        type: "message_update",
        message: { role: "assistant", responseId: `${name}-response`, content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${name} output` },
      });
      await scheduler.flush();
      session.emit({
        type: "agent_end",
        messages: [
          { role: "assistant", responseId: `${name}-response`, content: `${name} output` },
        ],
        isTerminal: true,
      });
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === commandTurnId &&
          event.state === "completed",
      );
      expect(events).toContainEqual({
        type: "timeline.item",
        sessionId: "session-1",
        item: expect.objectContaining({ type: "assistant_message", text: `${name} output` }),
      });
    }
    expect(session.handoffs).toEqual(["finish implementation"]);
    expect(session.followUps).toEqual(["run verification"]);

    const turnId = turnIdFrom(await startPrompt(connection, events, "active-command", "work"));
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-command",
        delivery: "auto",
        input: { type: "command", name: "steer", arguments: "focus" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "steer-command",
    );
    expect(session.steers).toEqual(["focus"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("publishes command metadata and dispatches structured commands and images", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [
      {
        name: "review",
        aliases: ["rv"],
        description: "Review the current change",
        input: { hint: "[scope]" },
        source: "extension",
      },
      { name: "git:status", description: "Show repository status", source: "extension" },
      { name: "unsafe/name", description: "Unsafe command", source: "extension" },
    ];
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    expect(events).toContainEqual({
      type: "session.commands",
      sessionId: "session-1",
      commands: expect.arrayContaining([
        {
          name: "compact",
          description: "Manually compact the session context",
          argumentHint: "[instructions]",
        },
        {
          name: "autocompact",
          description: "Toggle automatic context compaction",
          argumentHint: "[on|off|toggle]",
        },
        {
          name: "handoff",
          description: "Hand off from planning to implementation",
          argumentHint: "[instructions]",
        },
        {
          name: "steer",
          description: "Steer the active OMP turn",
          argumentHint: "<message>",
        },
        {
          name: "follow-up",
          description: "Queue a follow-up message for OMP",
          argumentHint: "<message>",
        },
        {
          name: "review",
          description: "Review the current change",
          argumentHint: "[scope]",
        },
        {
          name: "git:status",
          description: "Show repository status",
        },
      ]),
    });

    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "structured-command",
        delivery: "auto",
        input: { type: "command", name: "review", arguments: "src" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "structured-command",
    );
    await scheduler.flush();
    expect(session.prompts).toEqual(["/review src"]);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "namespaced-command",
        delivery: "auto",
        input: { type: "command", name: "git:status", arguments: "--short" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "namespaced-command",
    );
    await scheduler.flush();
    expect(session.prompts).toEqual(["/review src", "/git:status --short"]);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unsafe-command",
        delivery: "auto",
        input: { type: "command", name: "unsafe/name", arguments: "" },
      },
    });
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "unsafe-command",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        result: { type: "failed", error: { message: "Invalid OMP command name" } },
      }),
    );

    session.promptAgentInvoked = true;
    const imageResult = connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "image-prompt",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      },
    });
    await imageResult;
    const imageTurn = turnIdFrom(
      await events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "image-prompt",
      ),
    );
    expect(session.promptImages.at(-1)).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    await finishTurn(events, session, imageTurn);
    await connection.close();
  });

  test("continues extension questions through native permissions", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "ask-turn", "choose"));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "ask-tool",
      toolName: "ask_user",
      args: { question: "Deployment" },
    });
    session.emit({
      type: "extension_ui_request",
      id: "native-select",
      method: "select",
      title: "Deployment",
      options: ["Preview", "Production"],
      optionDetails: [{ description: "Safe sandbox" }, { description: "Live traffic" }],
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission event");
    const questions = permission.request.input?.questions;
    expect(questions).toEqual([
      {
        header: "Deployment",
        question: "Deployment",
        options: [
          {
            label: "Preview",
            value: expect.stringMatching(/:option:0$/u),
            description: "Safe sandbox",
          },
          {
            label: "Production",
            value: expect.stringMatching(/:option:1$/u),
            description: "Live traffic",
          },
        ],
        multiSelect: false,
      },
    ]);
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...permission.request, provider: "omp" }),
    ).not.toThrow();
    const optionActions =
      permission.request.actions?.filter((action) => action.id.includes(":option:")) ?? [];
    expect(new Set(optionActions.map((action) => action.id)).size).toBe(2);
    const productionAction = optionActions[1];
    if (!productionAction) throw new Error("Expected production action");
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "allow", selectedActionId: "submit" },
      }),
    ).rejects.toThrow("OMP permission action is invalid");
    expect(session.extensionUiResponses).toHaveLength(0);
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: {
          behavior: "allow",
          updatedInput: { answers: { Deployment: "Unlisted target" } },
        },
      }),
    ).rejects.toThrow("OMP selection response is invalid");
    expect(session.extensionUiResponses).toHaveLength(0);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { Deployment: "Production" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === permission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-select", value: "Production" },
    ]);
    const postResponseTerminalCount = events.filter(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    ).length;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(postResponseTerminalCount);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "ask-tool",
      toolName: "ask_user",
      result: { answer: "Production" },
    });
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.name === "ask_user",
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);
    session.emit({
      type: "extension_ui_request",
      id: "native-input",
      method: "input",
      title: "Branch name",
      placeholder: "feature/...",
    });
    const inputPermission = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.id !== permission.request.id,
    );
    if (inputPermission.type !== "session.permission") throw new Error("Expected input permission");
    expect(inputPermission.request.input).toEqual({
      questions: [
        {
          header: "Branch name",
          question: "Branch name",
          options: [],
          multiSelect: false,
          placeholder: "feature/...",
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...inputPermission.request, provider: "omp" }),
    ).not.toThrow();
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: inputPermission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Branch name": "feature/native" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === inputPermission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-select", value: "Production" },
      { type: "extension_ui_response", id: "native-input", value: "feature/native" },
    ]);
    session.emit({
      type: "extension_ui_request",
      id: "native-editor",
      method: "editor",
      title: "Release notes",
      prefill: "Draft",
      promptStyle: true,
    });
    const editorPermission = await events.waitFor(
      (event) =>
        event.type === "session.permission" &&
        event.request.id !== permission.request.id &&
        event.request.id !== inputPermission.request.id,
    );
    if (editorPermission.type !== "session.permission")
      throw new Error("Expected editor permission");
    expect(editorPermission.request.input).toEqual({
      questions: [
        {
          header: "Release notes",
          question: "Release notes",
          options: [],
          multiSelect: false,
          prefill: "Draft",
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...editorPermission.request, provider: "omp" }),
    ).not.toThrow();
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: editorPermission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Release notes": "Final notes" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === editorPermission.request.id,
    );
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-editor",
      value: "Final notes",
    });
    const permissionCount = events.filter((event) => event.type === "session.permission").length;
    const responseCount = session.extensionUiResponses.length;
    session.emit({
      type: "extension_ui_request",
      id: "open-url",
      method: "open_url",
      url: "https://example.com/oauth?token=public",
      launchUrl: "http://127.0.0.1:4321/launch",
      instructions: "Open this link",
    });
    expect(events.filter((event) => event.type === "session.permission")).toHaveLength(
      permissionCount,
    );
    expect(session.extensionUiResponses).toHaveLength(responseCount);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          message:
            "Open this link\nhttps://example.com/oauth?token=public\nRemote client: if the localhost callback cannot connect, paste the final redirect URL or authorization code into the OMP prompt in this chat.",
        }),
      }),
    );
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "ask-answer",
        content: [{ type: "text", text: "Continuing" }],
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });
});
