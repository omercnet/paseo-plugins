import { existsSync } from "node:fs";
import type { ProviderContent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  ALTERNATE_MODEL,
  ALTERNATE_MODEL_PUBLIC_ID,
  createHarness,
  finishTurn,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("renders prompt attachments exactly and keeps images as ordered image blocks", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const png = "iVBORw0KGgo=";
    const jpeg = "/9j/";
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "attachments",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "Review these" },
            {
              type: "forge_change_request",
              mimeType: "application/paseo-forge-change-request",
              forge: "gitea",
              number: 42,
              title: "Fix auth",
              url: "https://gitea.example/p/pulls/42",
              projectPath: "team/project",
              baseRefName: "main",
              headRefName: "fix/auth",
              body: "Closes the gap.",
            },
            { type: "image", data: png, mimeType: "image/png" },
            {
              type: "github_pr",
              mimeType: "application/github-pr",
              number: 7,
              title: "Legacy pull request",
              url: "https://github.example/p/pull/7",
              baseRefName: "main",
              headRefName: "legacy-fix",
              body: "Legacy change body.",
            },
            {
              type: "forge_issue",
              mimeType: "application/paseo-forge-issue",
              forge: "codeberg",
              number: 9,
              title: "Current issue",
              url: "https://codeberg.example/p/issues/9",
              projectPath: "team/project",
              body: "Current issue body.",
            },
            {
              type: "text",
              mimeType: "text/plain",
              title: "Context",
              text: "Attached text context",
            },
            {
              type: "github_issue",
              mimeType: "application/github-issue",
              number: 11,
              title: "Legacy issue",
              url: "https://github.example/p/issues/11",
              body: "Legacy issue body.",
            },
            { type: "image", data: jpeg, mimeType: "image/jpeg" },
            {
              type: "review",
              mimeType: "application/paseo-review",
              cwd: "/repo",
              mode: "base",
              baseRef: "main",
              comments: [
                {
                  filePath: "src/auth.ts",
                  side: "new",
                  lineNumber: 2,
                  body: "Check this branch.",
                  context: {
                    hunkHeader: "@@ -1,2 +1,2 @@",
                    targetLine: {
                      oldLineNumber: null,
                      newLineNumber: 2,
                      type: "add",
                      content: "secure();",
                    },
                    lines: [
                      {
                        oldLineNumber: 1,
                        newLineNumber: 1,
                        type: "context",
                        content: "const secure = false;",
                      },
                      {
                        oldLineNumber: 2,
                        newLineNumber: null,
                        type: "remove",
                        content: "insecure();",
                      },
                      {
                        oldLineNumber: null,
                        newLineNumber: 2,
                        type: "add",
                        content: "secure();",
                      },
                    ],
                  },
                },
              ],
            },
            {
              type: "uploaded_file",
              id: "upload-1",
              fileName: "spec.txt",
              mimeType: "text/plain",
              size: 12,
              path: "/repo/spec.txt",
            },
          ],
        },
      },
    });
    const attachmentResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "attachments",
    );
    expect(session.prompts).toEqual([
      [
        "Review these",
        "Gitea PR #42: Fix auth\nhttps://gitea.example/p/pulls/42\nProject: team/project\nBase: main\nHead: fix/auth\n\nCloses the gap.",
        "GitHub PR #7: Legacy pull request\nhttps://github.example/p/pull/7\nBase: main\nHead: legacy-fix\n\nLegacy change body.",
        "Codeberg Issue #9: Current issue\nhttps://codeberg.example/p/issues/9\nProject: team/project\n\nCurrent issue body.",
        "Attached text context",
        "GitHub Issue #11: Legacy issue\nhttps://github.example/p/issues/11\n\nLegacy issue body.",
        [
          "Paseo review attachment (base)",
          "CWD: /repo",
          "Base: main",
          "",
          "Comment 1: src/auth.ts:new:2",
          "Check this branch.",
          "@@ -1,2 +1,2 @@",
          "   1  1  const secure = false;",
          "   2  - -insecure();",
          ">  -  2 +secure();",
        ].join("\n"),
        "Uploaded file: spec.txt\nPath: /repo/spec.txt\nMIME: text/plain\nSize: 12 bytes",
      ].join("\n\n"),
    ]);
    expect(session.promptImages).toEqual([
      [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
      ],
    ]);
    await finishTurn(events, session, turnIdFrom(attachmentResult));
    await connection.close();
  });

  test("preserves prompt part and byte bounds plus image and empty validation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const expectPromptFailure = async (
      clientMessageId: string,
      content: ProviderContent[],
      message: string,
    ) => {
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input: { type: "message", content },
        },
      });
      await expect(
        events.waitFor(
          (event) =>
            event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
        ),
      ).resolves.toEqual(
        expect.objectContaining({ result: { type: "failed", error: { message } } }),
      );
    };

    await expectPromptFailure(
      "empty-prompt",
      [{ type: "text", text: " \n " }],
      "OMP prompt cannot be empty",
    );
    await expectPromptFailure(
      "too-many-parts",
      Array.from({ length: 65 }, () => ({ type: "text" as const, text: "x" })),
      "OMP prompt has too many content parts",
    );
    await expectPromptFailure(
      "too-many-bytes",
      [{ type: "text", text: "é".repeat(512 * 1024 + 1) }],
      "OMP prompt is too large",
    );
    await expectPromptFailure(
      "invalid-image",
      [{ type: "image", mimeType: "image/png", data: "not-base64" }],
      "OMP prompt image is invalid",
    );

    expect(session.prompts).toEqual([]);
    expect(session.promptImages).toEqual([]);
    await connection.close();
  });

  test("materializes images when an inline prompt exceeds the OMP input frame", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.maxInputFrameBytes = 1024 * 1024;
    const smallPng = "iVBORw0KGgo=";

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "small-inline-image",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: smallPng, mimeType: "image/png" }],
        },
      },
    });
    const inlineResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "small-inline-image",
    );
    expect(session.promptImages.at(-1)).toEqual([
      { type: "image", data: smallPng, mimeType: "image/png" },
    ]);
    await finishTurn(events, session, turnIdFrom(inlineResult));

    const largePng = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(768 * 1024 - 8),
    ]).toString("base64");
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "oversized-inline-image",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: largePng, mimeType: "image/png" }],
        },
      },
    });
    const materializedResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "oversized-inline-image",
    );
    expect(session.promptImages.at(-1)).toEqual([]);
    const materialized = session.prompts
      .at(-1)
      ?.match(/^\[Image available at: (?<path>.*[\\/][0-9a-f]{64}\.png)\]$/u)?.groups?.path;
    if (!materialized) throw new Error("Expected oversized image path");
    expect(existsSync(materialized)).toBe(true);
    await finishTurn(events, session, turnIdFrom(materializedResult));
    expect(existsSync(materialized)).toBe(false);
    await connection.close();
  });

  test("materializes images for text-only models", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(
      connection,
      events,
      "text-image-open",
      "session-1",
      {},
      ALTERNATE_MODEL_PUBLIC_ID,
      "high",
    );
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "text-only-image",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
    });
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "text-only-image",
    );
    expect(session.promptImages.at(-1)).toEqual([]);
    const materialized = session.prompts
      .at(-1)
      ?.match(/^\[Image available at: (?<path>.*[\\/][0-9a-f]{64}\.png)\]$/u)?.groups?.path;
    if (!materialized) throw new Error("Expected materialized image path");
    expect(existsSync(materialized)).toBe(true);
    await finishTurn(events, session, turnIdFrom(result));
    expect(existsSync(materialized)).toBe(false);
    await connection.close();
  });
  test("cleans materialized images after prompt failure and connection close", async () => {
    const failed = await createHarness();
    await openSession(
      failed.connection,
      failed.events,
      "failed-image-open",
      "session-1",
      {},
      ALTERNATE_MODEL_PUBLIC_ID,
      "high",
    );
    const failedSession = sessionAt(failed.runtime);
    failedSession.promptError = new Error("native prompt failed");
    await failed.connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "failed-image",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
    });
    await failed.events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "failed-image",
    );
    const failedPath = failedSession.prompts
      .at(-1)
      ?.match(/^\[Image available at: (?<path>.*[\\/][0-9a-f]{64}\.png)\]$/u)?.groups?.path;
    if (!failedPath) throw new Error("Expected failed prompt image path");
    expect(existsSync(failedPath)).toBe(false);
    await failed.connection.close();

    const closing = await createHarness();
    await openSession(
      closing.connection,
      closing.events,
      "closing-image-open",
      "session-1",
      {},
      ALTERNATE_MODEL_PUBLIC_ID,
      "high",
    );
    const closingSession = sessionAt(closing.runtime);
    turnIdFrom(
      await startPrompt(closing.connection, closing.events, "closing-image", "show image"),
    );
    const imagePayload = {
      type: "session.prompt" as const,
      sessionId: "session-1",
      prompt: {
        clientMessageId: "closing-image-steer",
        delivery: "steer" as const,
        input: {
          type: "message" as const,
          content: [{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
    };
    await closing.connection.send(imagePayload);
    await closing.events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "closing-image-steer",
    );
    const closingPath = closingSession.steers
      .at(-1)
      ?.match(/^\[Image available at: (?<path>.*[\\/][0-9a-f]{64}\.png)\]$/u)?.groups?.path;
    if (!closingPath) throw new Error("Expected closing prompt image path");
    expect(existsSync(closingPath)).toBe(true);
    await closing.connection.close();
    expect(existsSync(closingPath)).toBe(false);
  });

  test("commits an actual model and thinking change", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const baseline = events.length;

    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID, thinkingOption: "high" },
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "configure-1",
    );

    const session = sessionAt(runtime);
    expect(session.modelChanges).toEqual([{ provider: "openai", modelId: "gpt-5.4" }]);
    expect(session.thinkingChanges).toEqual(["high"]);
    expect(events.slice(baseline)).toEqual([
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
      { type: "request.completed", requestId: "configure-1" },
    ]);
    await connection.close();
  });
  test("publishes native fallback and revert state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const fallbackTimelineBaseline = events.length;

    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    const fallback = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === ALTERNATE_MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "high",
    );
    session.emit({
      type: "retry_fallback_applied",
      from: "anthropic/claude-sonnet-4-5:medium",
      to: "openai/gpt-5.4:high",
      role: "default",
    });
    session.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    const fallbackConfig = await fallback;
    const fallbackItems = events
      .slice(fallbackTimelineBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "omp_retry_fallback"
          ? [event.item]
          : [],
      );
    expect(fallbackItems.map((item) => item.status)).toEqual(["running", "completed"]);
    expect(new Set(fallbackItems.map((item) => item.callId)).size).toBe(1);
    expect(fallbackItems.map((item) => item.detail)).toEqual([
      expect.objectContaining({
        type: "plain_text",
        label: "OMP fallback applied for default",
        text: "anthropic/claude-sonnet-4-5:medium -> openai/gpt-5.4:high",
      }),
      expect.objectContaining({
        type: "plain_text",
        label: "OMP fallback succeeded for default",
        text: "Using openai/gpt-5.4:high",
      }),
    ]);
    if (fallbackConfig.type !== "session.config") throw new Error("Expected config event");
    expect(fallbackConfig.config.thinkingOptions.map((option) => option.id)).toEqual([
      "low",
      "high",
    ]);

    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const reverted = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.emit({ type: "model_changed" });
    const revertedConfig = await reverted;
    if (revertedConfig.type !== "session.config") throw new Error("Expected config event");
    expect(revertedConfig.config.thinkingOptions.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    session.thinkingLevel = "high";
    const thinkingChanged = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "high",
    );
    session.emit({ type: "thinking_level_changed", thinkingLevel: "future-thinking" });
    await thinkingChanged;

    const latest = events.findLast((event) => event.type === "session.config");
    expect(latest).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          thinkingOption: "high",
          thinkingOptions: expect.arrayContaining([expect.objectContaining({ id: "low" })]),
        }),
      }),
    );
    await connection.close();
  });
  test("renders goal and retry events and routes subagent events", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;

    session.emit({
      type: "goal_updated",
      goal: { id: "goal-1", objective: "Ship", status: "active", tokenBudget: 10_000 },
      state: { enabled: true, mode: "focused" },
    });
    session.emit({
      type: "goal_updated",
      goal: {
        id: "goal-1",
        objective: "Ship",
        status: "completed",
        tokenBudget: 10_000,
        tokensUsed: 8_000,
      },
      state: { enabled: true, mode: "focused" },
    });
    session.emit({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 1_500,
      errorMessage: "rate limited",
      errorId: 429,
    });
    session.emit({
      type: "auto_retry_end",
      success: false,
      attempt: 2,
      finalError: "still rate limited",
      recoveredErrors: [{ id: 429 }],
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "scout", status: "started", index: 0 },
    });
    session.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "scout",
        task: "Inspect protocol",
        progress: { id: "child-1", status: "running" },
      },
    });
    session.emit({
      type: "subagent_event",
      payload: { id: "child-1", event: { type: "agent_start" } },
    });
    session.emit({ type: "notice", level: "info", message: "subagent events routed" });

    const statusItems = events
      .slice(baseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
      );
    const goalItems = statusItems.filter((item) => item.name === "omp_goal_updated");
    expect(goalItems).toHaveLength(2);
    expect(new Set(goalItems.map((item) => item.callId)).size).toBe(1);
    expect(goalItems.at(-1)).toEqual(
      expect.objectContaining({
        status: "completed",
        detail: expect.objectContaining({
          label: "OMP goal completed",
          text: "Ship\nStatus: completed\nTokens used: 8000\nToken budget: 10000\nMode: focused",
        }),
      }),
    );
    const retryItems = statusItems.filter((item) => item.name === "omp_auto_retry");
    expect(retryItems.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(new Set(retryItems.map((item) => item.callId)).size).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          message: "subagent events routed",
        }),
      }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("coalesces a runtime config event flood and publishes only changed state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    const baselineConfigs = events.filter((event) => event.type === "session.config").length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({ type: "model_changed" });
    await observed.promise;
    for (let index = 0; index < 100; index += 1) {
      session.emit({ type: "model_changed" });
    }
    expect(session.stateLookups).toBe(baselineLookups + 1);

    const committed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.stateGate = null;
    gate.resolve();
    await committed;
    await Promise.resolve();
    await Promise.resolve();

    expect(session.stateLookups).toBe(baselineLookups + 2);
    expect(events.filter((event) => event.type === "session.config").length - baselineConfigs).toBe(
      1,
    );
    await connection.close();
  });
  test("clears a detached refresh after scheduler cleanup throws", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    scheduler.clearError = new Error("timer cleanup failed");
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    const fallback = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    await scheduler.flush();
    await fallback;
    expect(session.stateLookups).toBe(baselineLookups + 2);

    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const reverted = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.emit({ type: "model_changed" });
    await reverted;
    await connection.close();
  });
  test("preserves a deferred native refresh across rejected configure validation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({ type: "model_changed" });
    await observed.promise;
    await connection.send({
      type: "session.configure",
      requestId: "invalid-during-refresh",
      sessionId: "session-1",
      changes: { mode: "write" },
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "invalid-during-refresh",
    );

    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.stateGate = null;
    gate.resolve();
    await refreshed;
    await Promise.resolve();
    await Promise.resolve();

    session.emit({ type: "process_exit", error: "restart after native change" });
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "refresh-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ model: "openai/gpt-5.4", thinkingOption: "high" }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("recovers from native state after fallback immediately precedes process exit", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    await observed.promise;
    session.emit({ type: "process_exit", error: "fallback runtime exited" });
    session.stateGate = null;
    gate.resolve();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";

    const turnId = turnIdFrom(await startPrompt(connection, events, "fallback-exit", "continue"));
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: undefined,
        thinkingOption: undefined,
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("recovers native state when setModel commits immediately before process exit", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const responseGate = Promise.withResolvers<void>();
    const responseObserved = Promise.withResolvers<void>();
    session.modelResponseGate = responseGate.promise;
    session.modelResponseObserved = responseObserved.resolve;

    await connection.send({
      type: "session.configure",
      requestId: "configure-exit-after-model-commit",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await responseObserved.promise;
    const failed = events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-exit-after-model-commit",
    );
    session.emit({ type: "process_exit", error: "exit before set_model response" });
    session.modelResponseGate = null;
    responseGate.resolve();
    await failed;

    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "configure-exit-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: undefined,
        thinkingOption: undefined,
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("omits unsupported thinking when refreshing runtime state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "medium";

    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.emit({ type: "model_changed" });
    const config = await refreshed;

    if (config.type !== "session.config") throw new Error("Expected session config");
    expect(config.config.thinkingOption).toBeUndefined();
    expect(session.closes).toBe(0);
    expect(events).toContainEqual({
      type: "session.notice",
      sessionId: "session-1",
      notice: expect.objectContaining({ id: "omp:unsupported-thinking-level" }),
    });
    await connection.close();
  });

  test("retries failed and timed-out config refreshes without killing an active turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "refresh-timeout", "work"));

    session.stateError = new Error("transient state failure");
    session.emit({ type: "model_changed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.closes).toBe(0);

    session.stateError = null;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.filter((delay) => delay === 250)).toHaveLength(1);
    const afterRejection = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    await scheduler.flush();
    await afterRejection;

    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();
    const timedOutLookups = session.stateLookups;
    for (let index = 0; index < 100; index += 1) {
      session.emit({ type: "model_changed" });
    }
    expect(session.stateLookups).toBe(timedOutLookups);

    expect(session.closes).toBe(0);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);

    const afterTimeout = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.stateGate = null;
    gate.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.filter((delay) => delay === 250)).toHaveLength(2);
    await scheduler.flush();
    await afterTimeout;
    expect(scheduler.delays.filter((delay) => delay === 250)).toEqual([250, 250]);

    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("retries after a never-settling refresh request times out", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const neverSettles = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = neverSettles.promise;
    session.stateObserved = observed.resolve;

    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();
    expect(scheduler.pendingCount).toBe(1);

    session.stateGate = null;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    await scheduler.flush();
    await refreshed;

    expect(session.stateLookups).toBe(4);
    await connection.close();
  });

  test("ignores a late timed-out state result after a newer refresh commits", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineConfigs = events.filter((event) => event.type === "session.config").length;
    const late = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    session.stateGate = late.promise;
    session.stateObserved = observed.resolve;

    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();

    session.stateGate = null;
    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    await scheduler.flush();
    await refreshed;
    const committedConfigs = events.filter((event) => event.type === "session.config").length;

    late.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((event) => event.type === "session.config")).toHaveLength(
      committedConfigs,
    );
    expect(committedConfigs).toBe(baselineConfigs + 1);
    await connection.close();
  });

  test("invalidates after bounded persistent config refresh failures", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    const closed = Promise.withResolvers<void>();
    session.closeObserved = closed.resolve;
    session.stateError = new Error("persistent state failure");

    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.filter((delay) => delay < 2_000)).toEqual([250]);
    await scheduler.flush();
    expect(scheduler.delays.filter((delay) => delay < 2_000)).toEqual([250, 500]);
    await scheduler.flush();
    await closed.promise;

    expect(session.stateLookups).toBe(baselineLookups + 3);
    expect(session.closes).toBe(1);
    await connection.close();
  });

  test("cancels and drains a config refresh backoff on close", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("state unavailable before close");
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    const stateLookups = session.stateLookups;

    await connection.close();

    expect(scheduler.pendingCount).toBe(0);
    await scheduler.flush();
    expect(session.stateLookups).toBe(stateLookups);
  });

  test("cancels and drains a config refresh backoff on runtime invalidation", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("state unavailable before invalidation");
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    const stateLookups = session.stateLookups;

    session.emit({ type: "process_exit", error: "runtime exited during refresh backoff" });
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.pendingCount).toBe(0);
    await scheduler.flush();
    expect(session.stateLookups).toBe(stateLookups);
    expect(session.closes).toBe(1);
    await connection.close();
  });

  test("fails configure when OMP does not commit the requested selection", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.applyModelChanges = false;

    await connection.send({
      type: "session.configure",
      requestId: "configure-uncommitted",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-uncommitted",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP did not commit the requested model" } }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-uncommitted",
      ),
    ).toBe(false);
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({ config: expect.objectContaining({ model: MODEL_PUBLIC_ID }) }),
    );
    session.applyModelChanges = true;
    session.applyThinkingChanges = false;
    await connection.send({
      type: "session.configure",
      requestId: "configure-uncommitted-thinking",
      sessionId: "session-1",
      changes: { thinkingOption: "low" },
    });
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-uncommitted-thinking",
    );
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" &&
          event.requestId === "configure-uncommitted-thinking",
      ),
    ).toBe(false);
    await connection.close();
  });
  test("bounds state reconciliation after a configure mutation failure", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    session.modelChangeError = new Error("model mutation failed");
    session.stateGate = stateGate.promise;
    session.stateObserved = stateObserved.resolve;

    await connection.send({
      type: "session.configure",
      requestId: "configure-reconcile-timeout",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await stateObserved.promise;
    await Promise.resolve();
    const failure = events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-reconcile-timeout",
    );
    expect(scheduler.delays.at(-1)).toBe(2_000);
    await scheduler.flush();

    await failure;
    expect(scheduler.delays).toContain(2_000);
    expect(session.closes).toBe(0);
    stateGate.resolve();
    await connection.close();
  });

  test("rejects unsupported thinking before changing the target model", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.configure",
      requestId: "configure-unsupported-thinking",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID, thinkingOption: "medium" },
    });
    const failure = await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-unsupported-thinking",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP thinking level is unavailable for the selected model" },
      }),
    );
    expect(session.modelChanges).toEqual([]);
    expect(session.thinkingChanges).toEqual([]);
    await connection.close();
  });

  test("invalidates the runtime when configure observes a catalog escape", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateModelOverride = {
      provider: "escaped",
      id: "unadvertised",
      reasoning: false,
    };

    await connection.send({
      type: "session.configure",
      requestId: "configure-catalog-escape",
      sessionId: "session-1",
      changes: { mode: "full" },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-catalog-escape",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP runtime selected an unadvertised model" } }),
    );
    expect(session.closes).toBe(1);
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-catalog-escape",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("does not publish deferred configure success after runtime invalidation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-invalidated",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    session.emit({ type: "process_exit", error: "runtime exited" });
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-invalidated",
    );
    session.stateGate = null;
    gate.resolve();
    await failure;
    await configuring;

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-invalidated",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("fails a deferred getState configure request after close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-closed",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-closed",
    );
    const closing = connection.close();
    session.stateGate = null;
    gate.resolve();
    await failure;
    await Promise.all([configuring, closing]);

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "request.completed" && event.requestId === "configure-closed",
      ),
    ).toHaveLength(0);
  });

  test("fails a deferred setModel configure request after close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.modelChangeGate = gate.promise;
    session.modelChangeObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-model-closed",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-model-closed",
    );
    const closing = connection.close();
    session.modelChangeGate = null;
    gate.resolve();
    await failure;
    await Promise.all([configuring, closing]);

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-model-closed",
      ),
    ).toHaveLength(0);
  });

  test("rejects approval mode changes without claiming success", async () => {
    const { connection, events } = await createHarness();
    await openSession(connection, events);

    await connection.send({
      type: "session.configure",
      requestId: "configure-mode",
      sessionId: "session-1",
      changes: { mode: "write" },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-mode",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP approval mode cannot change live; create a new session instead" },
      }),
    );
    expect(
      events.some(
        (event) => event.type === "request.completed" && event.requestId === "configure-mode",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("preserves isolated environment after configure and recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    await connection.send({
      type: "session.configure",
      requestId: "configure-before-recovery",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await events.waitFor(
      (event) =>
        event.type === "request.completed" && event.requestId === "configure-before-recovery",
    );
    const recoveryBaseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "low";
    sessionAt(runtime).emit({ type: "process_exit", error: "closed" });
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "configured-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        environment: TEST_RUNTIME_ENV,
        model: "openai/gpt-5.4",
        noSession: false,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    expect(events.slice(recoveryBaseline)).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "low",
        }),
      }),
    );
    await connection.close();
  });
});
