import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import type {
  OmpOperationalFailure,
  OmpOperationalFailureReporter,
} from "../server/operational-failure-diagnostics";
import { ompImageTimelineSchema, transformOmpImageToolItem } from "../shared/provider-image";
import {
  createHarness,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openSession,
  sessionAt,
  startPrompt,
  timelineContentModulePath,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("accepts null command input and preserves command and custom names", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [
      { name: "help", description: "Help", input: null, source: "builtin" },
      { name: "secret-command", description: "Private", input: null, source: "extension" },
    ];
    const { connection, events } = await createHarness(runtime);
    await openSession(
      connection,
      events,
      "configured-output-open",
      "session-1",
      { SECRET_NAME: "secret-command" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const commandEvent = events.find((event) => event.type === "session.commands");
    expect(commandEvent).toEqual(
      expect.objectContaining({
        commands: expect.arrayContaining([
          { name: "help", description: "Help" },
          { name: "<redacted>", description: "Private" },
        ]),
      }),
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "custom-output", "work"));
    sessionAt(runtime).emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "stable-custom",
        customType: "secret-command",
        display: true,
        content: "visible",
      },
    });
    const custom = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(custom).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ name: "<redacted>" }) }),
    );
    await finishTurn(events, sessionAt(runtime), turnId);
    await connection.close();
  });
  test("accepts future compaction actions and actionless completion", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;

    session.emit({ type: "auto_compaction_start", reason: "future", action: "future-action" });
    session.emit({ type: "auto_compaction_end", aborted: false, willRetry: false });

    expect(
      events
        .slice(baseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : [],
        ),
    ).toEqual([
      { type: "compaction", id: "omp:compaction:1", status: "loading", trigger: "auto" },
      { type: "compaction", id: "omp:compaction:1", status: "completed", trigger: "auto" },
    ]);
    await connection.close();
  });

  test("renders native tools custom messages hidden notices and compaction once", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "render-turn", "work"));
    for (const [toolCallId, toolName, args, result, detailType] of [
      [
        "bash",
        "bash",
        { command: "pwd", cwd: "/repo" },
        { content: [{ type: "text", text: "/repo" }], details: { exitCode: 0 } },
        "shell",
      ],
      [
        "edit",
        "edit",
        { path: "a.ts", oldString: "a", newString: "b" },
        { content: [{ type: "text", text: "updated" }], details: { diff: "-a\n+b" } },
        "edit",
      ],
      ["write", "write", { path: "b.ts", content: "b" }, { ok: true }, "write"],
      ["grep", "grep", { pattern: "needle" }, { content: "a.ts:1" }, "search"],
      ["fetch", "fetch", { url: "https://example.com" }, { content: "page" }, "fetch"],
      ["task", "task", { agent: "reviewer", description: "Review" }, { log: "done" }, "sub_agent"],
      ["advisor", "advisor", { prompt: "Check" }, { content: "Concern" }, "plain_text"],
      ["custom", "vendor_tool", { value: 1 }, { value: 2 }, "unknown"],
    ] as const) {
      session.emit({ type: "tool_execution_start", toolCallId, toolName, args });
      session.emit({ type: "tool_execution_end", toolCallId, toolName, result });
      const snapshots = events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === toolName
          ? [event.item]
          : [],
      );
      expect(snapshots).toHaveLength(2);
      expect(new Set(snapshots.map((item) => item.id)).size).toBe(1);
      expect(snapshots.at(-1)?.detail.type).toBe(detailType);
    }
    session.emit({
      type: "tool_execution_start",
      toolCallId: "mcp-route",
      toolName: "write",
      args: { path: "xd://mcp__paseo_list_agents", content: "{}" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "mcp-route",
      toolName: "write",
      result: { content: [{ type: "text", text: "agent-1" }] },
    });
    const mcpSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "Paseo list agents"
        ? [event.item]
        : [],
    );
    expect(mcpSnapshots).toHaveLength(2);
    expect(new Set(mcpSnapshots.map((item) => item.id)).size).toBe(1);
    expect(mcpSnapshots.at(-1)).toMatchObject({
      name: "Paseo list agents",
      status: "completed",
      detail: {
        type: "unknown",
        input: { path: "xd://mcp__paseo_list_agents", content: "{}" },
        output: { content: [{ type: "text", text: "agent-1" }] },
      },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "direct-mcp",
      toolName: "mcp__paseo_list_providers",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "direct-mcp",
      toolName: "mcp__paseo_list_providers",
      result: { content: [{ type: "text", text: "provider-1" }] },
    });
    const directMcpSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "Paseo list providers"
        ? [event.item]
        : [],
    );
    expect(directMcpSnapshots).toHaveLength(2);
    expect(directMcpSnapshots.at(-1)).toMatchObject({
      name: "Paseo list providers",
      status: "completed",
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "preserved-fetch",
      toolName: "web_fetch",
      args: { url: "https://example.com/page?next=%2Fdocs%3Ftab%3Dapi#section%202" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "preserved-fetch",
      toolName: "web_fetch",
      result: { output: "page" },
    });
    const preservedFetch = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "web_fetch" &&
        event.item.status === "completed",
    );
    expect(
      preservedFetch?.type === "timeline.item" && preservedFetch.item.type === "tool_call"
        ? preservedFetch.item.detail
        : undefined,
    ).toEqual({
      type: "fetch",
      url: "https://example.com/page?next=%2Fdocs%3Ftab%3Dapi#section%202",
      result: "page",
    });
    const preservedReadUrl = "https://EXAMPLE.com/%7Eguide?next=%2Fdocs%3Ftab%3Dapi#section%202";
    session.emit({
      type: "tool_execution_start",
      toolCallId: "preserved-read-url",
      toolName: "read",
      args: { path: preservedReadUrl },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "preserved-read-url",
      toolName: "read",
      result: { output: "read page" },
    });
    const preservedRead = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read" &&
        event.item.status === "completed",
    );
    expect(
      preservedRead?.type === "timeline.item" && preservedRead.item.type === "tool_call"
        ? preservedRead.item.detail
        : undefined,
    ).toEqual({ type: "fetch", url: preservedReadUrl, result: "read page" });

    session.emit({
      type: "tool_execution_start",
      toolCallId: "unsafe-fetch",
      toolName: "web_fetch",
      args: { url: "javascript:alert('secret')" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "unsafe-fetch",
      toolName: "web_fetch",
      result: { output: "ignored" },
    });
    const unsafeFetch = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "web_fetch" &&
        event.item.status === "completed",
    );
    expect(
      unsafeFetch?.type === "timeline.item" && unsafeFetch.item.type === "tool_call"
        ? unsafeFetch.item.detail
        : undefined,
    ).toEqual({ type: "plain_text", label: "web_fetch", text: "ignored" });
    expect(JSON.stringify(unsafeFetch)).not.toContain("javascript");
    session.emit({
      type: "tool_execution_start",
      toolCallId: "edit-default-input",
      toolName: "edit",
      args: { input: "apply prepared edit" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "edit-default-input",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "updated" }],
        details: {
          path: "src/derived.ts",
          perFileResults: [
            { path: "src/derived.ts", diff: "-old\n+new" },
            { path: "src/other.ts", diff: "-before\n+after" },
          ],
        },
      },
    });
    const derivedEdit = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed" &&
        event.item.detail.type === "edit" &&
        event.item.detail.filePath === "src/derived.ts",
    );
    expect(
      derivedEdit?.type === "timeline.item" && derivedEdit.item.type === "tool_call"
        ? derivedEdit.item.detail
        : undefined,
    ).toEqual({
      type: "edit",
      filePath: "src/derived.ts",
      unifiedDiff: "-old\n+new\n-before\n+after",
    });
    const screenshotBytes = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(225 * 1024),
    ]).toString("base64");
    session.emit({
      type: "tool_execution_start",
      toolCallId: "browser-shot",
      toolName: "browser_screenshot",
      args: { browserId: "browser-1" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "browser-shot",
      toolName: "browser_screenshot",
      result: {
        content: [
          { type: "text", text: "token test-value" },
          { type: "image", data: screenshotBytes, mimeType: "image/png" },
        ],
        details: { width: 1280, height: 720, authorization: "test-value" },
      },
    });
    const browserTool = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "browser_screenshot" &&
        event.item.status === "completed",
    );
    if (browserTool?.type !== "timeline.item" || browserTool.item.type !== "tool_call") {
      throw new Error("Expected terminal browser screenshot tool");
    }
    const browserCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.id === `${browserTool.item.id}:images`,
    );
    if (browserCarrier?.type !== "timeline.item" || browserCarrier.item.type !== "tool_call") {
      throw new Error("Expected browser screenshot image carrier");
    }
    // Static imports pull the host's incompatible Node/Zod declaration graph into this package.
    const timelineContent = (await import(timelineContentModulePath)) as unknown as {
      limitAgentTimelineItemContent(item: ProviderTimelineItem): ProviderTimelineItem;
    };
    const reducedCarrier = timelineContent.limitAgentTimelineItemContent(browserCarrier.item);
    if (reducedCarrier.type !== "tool_call") throw new Error("Expected reduced image carrier");
    const browserTransform = transformOmpImageToolItem(reducedCarrier);
    const browserImage = browserTransform?.items[0];
    expect(JSON.stringify(browserImage?.data).length).toBeGreaterThan(256 * 1024);
    expect(ompImageTimelineSchema.parse(browserImage?.data).images[0]?.data).toBe(screenshotBytes);
    expect(browserImage).toEqual({
      type: "plugin",
      id: browserCarrier.item.id,
      kind: "omp-images",
      version: 1,
      data: {
        label: "browser_screenshot",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: screenshotBytes,
            mimeType: "image/png",
          },
        ],
        text: "token test-value",
        details: { width: 1280, height: 720, authorization: "test-value" },
      },
    });
    const screenshotLifecycle = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.id === browserTool.item.id ? [event.item] : [],
    );
    expect(screenshotLifecycle[0]?.type).toBe("tool_call");
    expect(
      new Map(screenshotLifecycle.map((item) => [item.id, item])).get(browserTool.item.id),
    ).toEqual(expect.objectContaining({ type: "tool_call", status: "completed" }));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "read-image",
      toolName: "read",
      args: { path: "image.png" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "read-image",
      toolName: "read",
      result: {
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    const readCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read images",
    );
    if (readCarrier?.type !== "timeline.item" || readCarrier.item.type !== "tool_call") {
      throw new Error("Expected read image carrier");
    }
    expect(transformOmpImageToolItem(readCarrier.item)?.items[0]).toEqual(
      expect.objectContaining({ type: "plugin", kind: "omp-images" }),
    );
    session.emit({
      type: "tool_execution_start",
      toolCallId: "image-with-large-text",
      toolName: "multi_image",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "image-with-large-text",
      toolName: "multi_image",
      result: {
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "a".repeat(150 * 1024) },
          { type: "text", text: "b".repeat(150 * 1024) },
          { type: "text", text: "c".repeat(150 * 1024) },
        ],
      },
    });
    const boundedTextCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "multi_image images",
    );
    if (
      boundedTextCarrier?.type !== "timeline.item" ||
      boundedTextCarrier.item.type !== "tool_call"
    ) {
      throw new Error("Expected bounded image text carrier");
    }
    const boundedImage = transformOmpImageToolItem(boundedTextCarrier.item)?.items[0];
    const boundedImageData = ompImageTimelineSchema.parse(boundedImage?.data);
    expect(Buffer.byteLength(boundedImageData.text ?? "", "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(boundedImageData.images).toHaveLength(1);
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "custom-image",
        customType: "gallery",
        display: true,
        content: [
          { type: "text", text: "caption test-value" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        details: { token: "test-value" },
      },
    });
    const customCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "gallery images",
    );
    if (customCarrier?.type !== "timeline.item" || customCarrier.item.type !== "tool_call") {
      throw new Error("Expected custom image carrier");
    }
    expect(transformOmpImageToolItem(customCarrier.item)?.items[0]).toEqual({
      type: "plugin",
      id: customCarrier.item.id,
      kind: "omp-images",
      version: 1,
      data: {
        label: "gallery",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
        text: "caption test-value",
        details: { token: "test-value" },
      },
    });
    const completedMappedTools = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.status === "completed"
        ? [event.item]
        : [],
    );
    expect(completedMappedTools.find((item) => item.name === "bash")?.detail).toEqual({
      type: "shell",
      command: "pwd",
      cwd: "/repo",
      output: "/repo",
      exitCode: 0,
    });
    expect(completedMappedTools.find((item) => item.name === "edit")?.detail).toEqual({
      type: "edit",
      filePath: "a.ts",
      oldString: "a",
      newString: "b",
      unifiedDiff: "-a\n+b",
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "todo",
      toolName: "todo",
      args: { op: "view" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "todo",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "updated" }],
        details: {
          phases: [
            {
              id: "phase-1",
              name: "Build",
              tasks: [{ id: "task-1", content: "Map events", status: "in_progress" }],
            },
          ],
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.name === "todo",
      ),
    ).toHaveLength(0);
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "todo",
        id: "omp:todos",
        items: [
          {
            id: expect.stringMatching(/^omp:todo:/u),
            text: "Map events",
            completed: false,
            status: "in_progress",
            activeForm: "Build",
          },
        ],
      },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "failed-ask",
      toolName: "ask_user",
      args: { questions: [] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "failed-ask",
      toolName: "ask_user",
      result: { content: [{ type: "text", text: "question failed" }] },
      isError: true,
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "failed-todo",
      toolName: "todo",
      args: { op: "view" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "failed-todo",
      toolName: "todo",
      result: { content: [{ type: "text", text: "missing phases" }] },
    });
    for (const name of ["ask_user", "todo"]) {
      const fallback = events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === name
          ? [event.item]
          : [],
      );
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.status).toBe("failed");
    }
    session.emit({
      type: "todo_reminder",
      todos: [{ id: "task-1", content: "Map events", status: "in_progress" }],
    });
    const todoRows = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "todo" ? [event.item] : [],
    );
    expect(todoRows.map((item) => item.items[0]?.id)).toEqual([
      expect.stringMatching(/^omp:todo:/u),
      expect.stringMatching(/^omp:todo:/u),
    ]);
    expect(todoRows[0]?.items[0]?.id).toBe(todoRows[1]?.items[0]?.id);
    expect(new Set(todoRows.map((item) => item.id))).toEqual(new Set(["omp:todos"]));

    const beforeCustom = events.length;
    session.emit({
      type: "message_end",
      message: { role: "custom", customType: "internal-notice", display: false, content: "hidden" },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "advisor-native-id",
        customType: "advisor-message",
        display: true,
        content: "",
        details: {
          severity: "warning",
          attribution: "reviewer",
          notes: ["Check the race"],
        },
      },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "advisor-native-id",
        customType: "advisor-message",
        display: true,
        content: "",
        details: {
          severity: "error",
          attribution: "reviewer",
          notes: [{ note: "Race confirmed", severity: "blocker", advisor: "reviewer" }],
        },
      },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "bashExecution",
        id: "bash-native-id",
        command: "pwd",
        output: "/repo\n",
        exitCode: 0,
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    session.emit({ type: "compaction_start" });
    session.emit({
      type: "compaction_end",
      aborted: true,
      willRetry: false,
      errorMessage: "manual compaction aborted",
    });
    session.emit({ type: "compaction_start" });
    session.emit({ type: "compaction_end", skipped: true, aborted: false, willRetry: false });
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      aborted: false,
      willRetry: true,
      errorMessage: "retrying",
    });
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      result: { tokensBefore: 8_000 },
      aborted: false,
      willRetry: false,
    });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { preTokens: 12_345 },
      aborted: false,
      willRetry: false,
    });
    const overlapBaseline = events.length;
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      aborted: false,
      willRetry: false,
    });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      aborted: false,
      willRetry: false,
    });
    const overlapEvents = events
      .slice(overlapBaseline)
      .flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
    const overlapId = overlapEvents[0]?.id;
    expect(overlapId).toEqual(expect.any(String));
    expect(overlapEvents).toEqual([
      {
        type: "compaction",
        id: overlapId,
        status: "loading",
        trigger: "auto",
      },
      {
        type: "compaction",
        id: overlapId,
        status: "completed",
        trigger: "auto",
      },
      {
        type: "error",
        id: `${overlapId}:error`,
        message: "OMP emitted overlapping compactions",
      },
    ]);
    session.emit({ type: "advisor_yielded" });
    const rendered = events.slice(beforeCustom).filter((event) => event.type === "timeline.item");
    expect(JSON.stringify(rendered)).not.toContain("hidden");
    const customItems = rendered.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
    );
    expect(customItems).toHaveLength(4);
    expect(new Set(customItems.map((item) => item.id)).size).toBe(3);
    expect(JSON.stringify(customItems)).toContain("[blocker] [reviewer] Race confirmed");
    const bashImageCarrier = customItems.find((item) => item.name === "bashExecution images");
    expect(
      bashImageCarrier ? transformOmpImageToolItem(bashImageCarrier)?.items[0] : undefined,
    ).toEqual(expect.objectContaining({ type: "plugin", kind: "omp-images" }));
    expect(rendered).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: expect.stringMatching(/^omp:advisor:/u),
        level: "info",
        message: "Advisor review completed",
      },
    });
    expect(customItems.find((item) => item.detail.type === "shell")?.detail).toEqual({
      type: "shell",
      command: "pwd",
      output: "/repo\n",
      exitCode: 0,
    });
    const compactions = rendered.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : [],
    );
    const compactionIds = [...new Set(compactions.map((item) => item.id))];
    expect(compactionIds).toHaveLength(5);
    const [manualAbortedId, manualSkippedId, retryId, thresholdId] = compactionIds;
    expect(compactions).toContainEqual({
      type: "compaction",
      id: thresholdId,
      status: "loading",
      trigger: "auto",
    });
    expect(compactions).toContainEqual({
      type: "compaction",
      id: thresholdId,
      status: "completed",
      trigger: "auto",
      preTokens: 12_345,
    });
    const compactionResults = rendered.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "compaction" || event.item.type === "error")
        ? [event.item]
        : [],
    );
    expect(compactionResults).toContainEqual({
      type: "error",
      id: `${manualAbortedId}:error`,
      message: "manual compaction aborted",
    });
    const reducedTimeline = new Map(
      rendered.flatMap((event) =>
        event.type === "timeline.item" ? [[event.item.id, event.item] as const] : [],
      ),
    );
    expect(reducedTimeline.get(manualAbortedId)).toEqual({
      type: "compaction",
      id: manualAbortedId,
      status: "completed",
      trigger: "manual",
    });
    expect(compactionResults).toContainEqual({
      type: "compaction",
      id: manualSkippedId,
      status: "completed",
      trigger: "manual",
    });
    expect(rendered).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: `${manualSkippedId}:skipped`,
        level: "warning",
        message: "OMP compaction was skipped",
      },
    });
    expect(compactionResults).toContainEqual({
      type: "compaction",
      id: retryId,
      status: "completed",
      trigger: "auto",
      preTokens: 8_000,
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("honors interrupts after questions and retires compactions across recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const interruptedTurn = turnIdFrom(
      await startPrompt(connection, events, "interrupt-question", "work"),
    );
    session.emit({
      type: "extension_ui_request",

      id: "interrupt-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    await events.waitFor((event) => event.type === "session.permission");
    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-question-request",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) =>
        event.type === "request.completed" && event.requestId === "interrupt-question-request",
    );
    await finishTurn(events, session, interruptedTurn);
    await Promise.resolve();
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "interrupt-ui",
      cancelled: true,
    });
    expect(events.filter((event) => event.type === "session.permission_resolved")).toHaveLength(1);

    const recoveryTurn = turnIdFrom(
      await startPrompt(connection, events, "compaction-death", "continue"),
    );
    const recoveredSource = sessionAt(runtime);
    recoveredSource.emit({ type: "compaction_start" });
    recoveredSource.emit({ type: "compaction_start" });
    recoveredSource.emit({ type: "compaction_end", aborted: false, willRetry: false });
    recoveredSource.emit({ type: "process_exit", error: "transport died" });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === recoveryTurn && event.state === "failed",
    );
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "error",
        id: "omp:compaction:1:error",
        message: "OMP emitted overlapping compactions",
      },
    });

    const finalTurn = turnIdFrom(
      await startPrompt(connection, events, "after-compaction-death", "again"),
    );
    const recovered = sessionAt(runtime, 1);
    recovered.emit({ type: "compaction_start" });
    recovered.emit({ type: "compaction_end", aborted: false, willRetry: false });
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "compaction",
        id: "omp:compaction:2",
        status: "completed",
        trigger: "manual",
      },
    });
    await finishTurn(events, recovered, finalTurn);
    await openSession(
      connection,
      events,
      "open-2",
      "session-2",
      { TEST_ENV: "test-value" },
      MODEL_PUBLIC_ID,
      "medium",
      false,
    );
    sessionAt(runtime, 2).emit({ type: "compaction_start" });
    await connection.send({ type: "session.close", requestId: "close-2", sessionId: "session-2" });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-2",
    );
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-2",
      item: {
        type: "error",
        id: "omp:compaction:1:error",
        message: "OMP compaction ended when the session closed",
      },
    });
    await connection.close();
  });
  test("resolves turnless permissions on direct runtime invalidation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.emit({
      type: "extension_ui_request",
      id: "idle-before-invalidation",
      method: "confirm",
      title: "Idle",
      message: "Continue?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected idle permission");
    const turnId = turnIdFrom(await startPrompt(connection, events, "invalidate-state", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "turn-before-invalidation",
      method: "confirm",
      title: "Turn",
      message: "Continue?",
    });
    session.extensionUiResponseError = new Error("cancel failed");
    await connection.send({
      type: "session.interrupt",
      requestId: "invalidate-interrupt",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "invalidate-interrupt",
    );
    await finishTurn(events, session, turnId);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("completes a manual compaction once from its RPC result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "local-compaction", "/compact"),
    );
    await scheduler.flush();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    const compactions = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : [],
    );
    expect(compactions).toHaveLength(2);
    const operationId = compactions[0]?.id;
    expect(operationId).toEqual(expect.any(String));
    expect(compactions).toEqual([
      { type: "compaction", id: operationId, status: "loading", trigger: "manual" },
      {
        type: "compaction",
        id: operationId,
        status: "completed",
        trigger: "manual",
        preTokens: 1_000,
      },
    ]);
    await connection.close();
  });

  test("does not restore claimed permissions after transport death", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-death", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "dying-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    session.extensionUiResponseError = new Error("transport died");
    session.emit({ type: "process_exit", error: "transport died" });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    gate.resolve();
    await inFlightResponse;
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-permission-death", "continue"),
    );
    expect(runtime.sessions).toHaveLength(2);
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    await connection.close();
  });

  test("bounds aggregate text reasoning and image stream output", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "image-flood", "render"));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", responseId: "image-flood-response", content: [] },
    });
    for (let replacement = 0; replacement < 20; replacement += 1) {
      const imageData = Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.alloc(2 * 1024 * 1024 - 8, replacement),
      ]).toString("base64");
      session.emit({
        type: "message_update",
        message: { role: "assistant", responseId: "image-flood-response", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: imageData, mimeType: "image/png" },
        },
      });
      await scheduler.flush();
    }
    const renderedImages = events.flatMap((event) => {
      if (event.type !== "timeline.item" || event.item.type !== "tool_call") return [];
      const transformed = transformOmpImageToolItem(event.item)?.items[0];
      if (!transformed) return [];
      return ompImageTimelineSchema.parse(transformed.data).images.map((image) => image.data);
    });
    expect(renderedImages.length).toBeGreaterThan(0);
    expect(renderedImages.length).toBeLessThan(20);
    expect(renderedImages.reduce((total, data) => total + Buffer.byteLength(data), 0)).toBeLessThan(
      16 * 1024 * 1024,
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("data:image"),
      ),
    ).toBe(false);
    await finishTurn(events, sessionAt(runtime), turnId);
    await connection.close();
  });

  test("reports startup recovery projector and terminal operational failures once", async () => {
    const failures: OmpOperationalFailure[] = [];
    const reportFailure: OmpOperationalFailureReporter = (failure) => failures.push(failure);

    const startupRuntime = new FakeOmpRuntime();
    startupRuntime.nextStartError = new Error("startup failed");
    const startup = await createHarness(
      startupRuntime,
      new ManualScheduler(),
      undefined,
      undefined,
      reportFailure,
    );
    await expect(openSession(startup.connection, startup.events)).rejects.toThrow();
    expect(failures).toEqual([{ category: "session-open", stage: "startup" }]);
    await startup.connection.close();

    failures.length = 0;
    const recovery = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      reportFailure,
    );
    await openSession(recovery.connection, recovery.events);
    sessionAt(recovery.runtime).emit({ type: "process_exit", error: "runtime stopped" });
    recovery.runtime.nextStartError = new Error("recovery failed");
    await startPrompt(recovery.connection, recovery.events, "recovery-failure", "continue");
    expect(failures).toEqual([{ category: "replay-recovery", stage: "runtime-recovery" }]);
    await recovery.connection.close();

    failures.length = 0;
    const projector = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      reportFailure,
    );
    await openSession(projector.connection, projector.events);
    await startPrompt(projector.connection, projector.events, "projector-failure", "render");
    const removeThrowingListener = projector.connection.onEvent((event) => {
      if (event.type === "timeline.item") throw new Error("renderer unavailable");
    });
    sessionAt(projector.runtime).emit({
      type: "message_start",
      message: { role: "assistant", responseId: "projector-response", content: [] },
    });
    expect(() =>
      sessionAt(projector.runtime).emit({
        type: "message_end",
        message: { role: "assistant", responseId: "projector-response", content: "done" },
      }),
    ).toThrow("renderer unavailable");
    removeThrowingListener();
    expect(failures).toEqual([{ category: "tool-projector", stage: "timeline-projector" }]);
    await projector.connection.close();

    failures.length = 0;
    const terminal = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      undefined,
      undefined,
      reportFailure,
    );
    await openSession(terminal.connection, terminal.events);
    const turnId = turnIdFrom(
      await startPrompt(terminal.connection, terminal.events, "terminal-failure", "fail"),
    );
    const terminalSession = sessionAt(terminal.runtime);
    establishTerminalOwnership(terminalSession);
    terminalSession.emit({
      type: "agent_end",
      requestId: `rpc-prompt-${terminalSession.promptCount}`,
      messages: [{ role: "assistant", content: "", errorMessage: "model failed" }],
      isTerminal: true,
    });
    await terminal.events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(failures).toEqual([{ category: "terminal-outcome", stage: "failed" }]);
    await terminal.connection.close();
  });
});
