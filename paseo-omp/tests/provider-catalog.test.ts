import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { mapOmpModels, ompModelId } from "../server/provider/catalog";
import { type OmpModel, OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  ALTERNATE_MODEL,
  ALTERNATE_MODEL_PUBLIC_ID,
  createHarness,
  EventLog,
  FakeOmpRuntime,
  finishTurn,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  ProviderRpcChild,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("discovers real models and all approval modes", async () => {
    const { connection, events, runtime } = await createHarness();
    await connection.send({ type: "catalog", requestId: "catalog-1", cwd: "/repo" });
    const event = await events.waitFor((candidate) => candidate.type === "catalog");

    expect(event).toEqual({
      type: "catalog",
      requestId: "catalog-1",
      catalog: expect.objectContaining({
        defaultModel: MODEL_PUBLIC_ID,
        defaultMode: "full",
        models: expect.arrayContaining([
          expect.objectContaining({ id: MODEL_PUBLIC_ID }),
          expect.objectContaining({ id: ALTERNATE_MODEL_PUBLIC_ID }),
        ]),
        modes: expect.arrayContaining([
          expect.objectContaining({ id: "full" }),
          expect.objectContaining({ id: "write" }),
          expect.objectContaining({ id: "ask" }),
        ]),
      }),
    });
    if (event.type !== "catalog") throw new Error("Expected catalog event");
    const alternate = event.catalog.models.find((model) => model.id === ALTERNATE_MODEL_PUBLIC_ID);
    expect(alternate?.contextWindowMaxTokens).toBeUndefined();
    expect(alternate?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);

    expect(event.catalog.modes.map((mode) => mode.id)).toEqual(["full", "write", "ask"]);
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({ cwd: "/repo", noSession: true, environment: TEST_RUNTIME_ENV }),
    );
    expect(sessionAt(runtime).closes).toBe(1);
    await connection.close();
  });
  test("uses strict profile-aware options for availability and catalog cache identity", async () => {
    const observed: Array<{ options: unknown; timeoutMs: number | undefined }> = [];
    const runtime = new FakeOmpRuntime();
    const provider = createOmpProvider({
      environment: TEST_RUNTIME_ENV,
      runtime,
      availabilityProbe: async (options, timeoutMs) => {
        observed.push({ options, timeoutMs });
        return { status: "available" };
      },
    });
    const base = {
      scope: "workspace" as const,
      cwd: "/repo",
      providerOptions: { command: ["/opt/omp-work"], params: { sessionDir: "/sessions/work" } },
      settings: {},
    };
    await expect(provider.checkAvailability?.(base, { timeoutMs: 321 })).resolves.toEqual({
      status: "available",
    });
    const baseKey = await provider.getCatalogCacheKey?.(base);
    const changedOptionsKey = await provider.getCatalogCacheKey?.({
      ...base,
      providerOptions: { command: ["/opt/omp-home"] },
    });
    const changedSettingsKey = await provider.getCatalogCacheKey?.({
      ...base,
      settings: { profile: "work" },
    });
    expect(observed).toEqual([{ options: base, timeoutMs: 321 }]);
    expect(baseKey).toBeDefined();
    expect(changedOptionsKey).not.toBe(baseKey);
    expect(changedSettingsKey).not.toBe(baseKey);
    await expect(
      provider.getCatalogCacheKey?.({ ...base, providerOptions: { unknown: true } }),
    ).rejects.toThrow("Invalid OMP provider options");
    expect(() => provider.providerOptionsSchema?.parse({ unknown: true })).toThrow();
    const connection = await provider.connect({ versions: [1], capabilities: ["permission"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "catalog", requestId: "profile-catalog", ...base } as never);
    await events.waitFor(
      (event) => event.type === "catalog" && event.requestId === "profile-catalog",
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        command: ["/opt/omp-work"],
        sessionDir: "/sessions/work",
        noSession: true,
      }),
    );
    await connection.close();
  });

  test("preserves the complete profile through refresh and repeated recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await connection.send({
      type: "session.open",
      requestId: "profile-open",
      sessionId: "profile-session",
      config: {
        cwd: "/repo",
        env: { SESSION_VALUE: "session" },
        mcpServers: {},
        mode: "full",
        settings: {},
        providerOptions: {
          command: ["/opt/omp-wrapper", "omp"],
          env: { PROFILE_VALUE: "profile", PROFILE_API_KEY: "profile-secret" },
          outputRedaction: "configured-values",
          params: {
            sessionDir: "/sessions/custom",
            rpcTimeoutMs: 8_000,
            smolModel: "openai/gpt-5-mini",
          },
        },
        systemPrompt: "profile system prompt",
        persist: true,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "profile-open",
    );
    const expectedTemplate = {
      command: ["/opt/omp-wrapper", "omp"],
      env: {
        PROFILE_VALUE: "profile",
        PROFILE_API_KEY: "profile-secret",
        SESSION_VALUE: "session",
      },
      mode: "full",
      noSession: false,
      readyTimeoutMs: 8_000,
      requestTimeoutMs: 8_000,
      roleModels: { smol: "openai/gpt-5-mini" },
      sessionDir: "/sessions/custom",
      systemPrompt: "profile system prompt",
      outputRedaction: "configured-values",
    } as const;
    expect(runtime.starts[0]).toEqual(expect.objectContaining(expectedTemplate));

    const initial = sessionAt(runtime);
    initial.currentModel = ALTERNATE_MODEL;
    initial.thinkingLevel = "high";
    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.sessionId === "profile-session" &&
        event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    initial.emit({ type: "model_changed" });
    await refreshed;
    await Promise.resolve();
    await Promise.resolve();

    for (let recovery = 1; recovery <= 2; recovery += 1) {
      runtime.nextModel = ALTERNATE_MODEL;
      runtime.nextThinkingLevel = "high";
      sessionAt(runtime, recovery - 1).emit({ type: "process_exit", error: "restart profile" });
      const turnId = turnIdFrom(
        await startPrompt(
          connection,
          events,
          `profile-recovery-${recovery}`,
          "continue",
          "profile-session",
        ),
      );
      expect(runtime.starts[recovery]).toEqual(
        expect.objectContaining({
          ...expectedTemplate,
          model: "openai/gpt-5.4",
          thinkingOption: "high",
          resumeSessionId: NATIVE_SESSION_ID,
        }),
      );
      sessionAt(runtime, recovery).emit({
        type: "notice",
        level: "info",
        message: "profile-secret",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          sessionId: "profile-session",
          item: expect.objectContaining({ type: "notification", message: "<redacted>" }),
        }),
      );
      await finishTurn(events, sessionAt(runtime, recovery), turnId);
    }
    await connection.close();
  });

  test("fails recovery without resuming an ephemeral native session", async () => {
    const { connection, events, runtime } = await createHarness();
    await connection.send({
      type: "session.open",
      requestId: "ephemeral-open",
      sessionId: "ephemeral-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        providerOptions: { command: ["/opt/ephemeral-omp"] },
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "ephemeral-open",
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({ command: ["/opt/ephemeral-omp"], noSession: true }),
    );

    sessionAt(runtime).emit({ type: "process_exit", error: "ephemeral runtime stopped" });
    const result = await startPrompt(
      connection,
      events,
      "ephemeral-recovery",
      "continue",
      "ephemeral-session",
    );
    expect(result).toEqual(
      expect.objectContaining({
        result: {
          type: "failed",
          error: {
            message: "OMP cannot recover a non-persisted session; create a new session instead",
          },
        },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("validates model selection against the configured session runtime catalog", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextAvailableModels = [ALTERNATE_MODEL];
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "custom-runtime-model",
      sessionId: "custom-runtime-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        providerOptions: {
          command: ["/opt/custom-omp"],
          env: { PROFILE_NAME: "custom" },
          params: { sessionDir: "/sessions/custom" },
        },
        persist: true,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "custom-runtime-model",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP model is not advertised by the configured session runtime" },
      }),
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        command: ["/opt/custom-omp"],
        env: { PROFILE_NAME: "custom" },
        sessionDir: "/sessions/custom",
      }),
    );
    expect(sessionAt(runtime).modelChanges).toHaveLength(0);
    expect(sessionAt(runtime).closes).toBe(1);
    await connection.close();
  });

  test("opens every advertised approval mode with permission bridging", async () => {
    const { connection, events, runtime } = await createHarness();
    for (const mode of ["write", "ask"] as const) {
      const requestId = `${mode}-mode`;
      const sessionId = `${mode}-session`;
      await connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode,
          settings: {},
          persist: true,
        },
        history: "skip",
      });
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === requestId,
      );
      const openedSession = sessionAt(runtime, runtime.starts.length - 1);
      openedSession.emit({
        type: "extension_ui_request",
        id: `approval-${mode}`,
        method: "select",
        title: "Allow tool: bash\nCommand: git status",
        options: ["Approve", "Deny"],
      });
      const permission = events.findLast(
        (event) =>
          event.type === "session.permission" && event.request.title?.startsWith("Allow tool:"),
      );
      if (permission?.type !== "session.permission") throw new Error("Expected permission");
      expect(permission.request).toMatchObject({
        kind: "question",
        title: "Allow tool: bash\nCommand: git status",
      });
      const approve = permission.request.actions?.find((action) => action.label === "Approve");
      if (!approve) throw new Error("Expected approve action");
      await connection.send({
        type: "session.permission",
        sessionId,
        permissionId: permission.request.id,
        response: { behavior: "allow", selectedActionId: approve.id },
      });
      expect(openedSession.extensionUiResponses.at(-1)).toEqual({
        type: "extension_ui_response",
        id: `approval-${mode}`,
        value: "Approve",
      });
      expect(runtime.starts.at(-1)?.mode).toBe(mode);
      await connection.send({ type: "session.close", requestId: `close-${mode}`, sessionId });
      await events.waitFor(
        (event) => event.type === "request.completed" && event.requestId === `close-${mode}`,
      );
    }
    await connection.close();
  });

  test("cancels a turn waiting for generic permission after native abort acknowledgement", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "extension_ui_request",
      id: "interrupt-permission",
      method: "select",
      title: "Allow tool: bash",
      options: ["Approve", "Deny"],
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission event");

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-permission-turn",
      sessionId: "session-1",
    });

    await events.waitFor(
      (event) =>
        event.type === "request.completed" && event.requestId === "interrupt-permission-turn",
    );
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "canceled",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    expect(session.aborts).toBe(1);
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "interrupt-permission",
      cancelled: true,
    });
    await connection.close();
  });

  test("hides and rejects interactive modes without negotiated permissions", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "catalog", requestId: "limited-catalog", cwd: "/repo" });
    const catalog = await events.waitFor(
      (event) => event.type === "catalog" && event.requestId === "limited-catalog",
    );
    if (catalog.type !== "catalog") throw new Error("Expected limited catalog");
    expect(catalog.catalog.modes.map((mode) => mode.id)).toEqual(["full"]);

    await connection.send({
      type: "session.open",
      requestId: "limited-open",
      sessionId: "limited-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "ask",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await expect(
      events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "limited-open",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        error: { message: "OMP mode 'ask' requires negotiated permission support" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });
  test("keeps text-shaped tool approvals generic and bounds their public input", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events, "spoofed-approval-open", "session-1", {
      API_TOKEN: "credential-secret",
    });
    const session = sessionAt(runtime);
    session.supportsTypedToolApprovals = false;
    session.emit({
      type: "extension_ui_request",
      id: "spoofed-tool-approval",
      method: "select",
      title: "Allow tool: bash\nCommand: cat /home/private/file credential-secret\u0007",
      options: ["Approve", "Deny"],
    });
    const permission = events.findLast(
      (event) =>
        event.type === "session.permission" && event.request.title?.startsWith("Allow tool:"),
    );
    if (permission?.type !== "session.permission") throw new Error("Expected generic permission");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.detail).toBeUndefined();
    const visible = JSON.stringify(permission.request);
    expect(visible).toContain("credential-secret");
    expect(visible).toContain("/home/private/file");
    expect(visible).toContain("\\u0007");
    expect(Buffer.byteLength(visible, "utf8")).toBeLessThan(128 * 1024);
    await connection.close();
  });

  test("publishes trusted typed tool permissions and correlates each response once", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(
      connection,
      events,
      "typed-approval-open",
      "session-1",
      { API_TOKEN: "credential-secret" },
      MODEL_PUBLIC_ID,
      "medium",
      true,
      { providerOptions: { outputRedaction: "configured-values" } },
    );
    const session = sessionAt(runtime);
    session.emit({
      type: "tool_approval_request",
      id: "native-shell",
      toolCallId: "call-shell",
      toolKind: "shell",
      toolName: "bash",
      tier: "exec",
      identity: { kind: "shell", command: "echo credential-secret" },
      input: { token: "credential-secret", command: "echo credential-secret" },
      detail: {
        lines: ["Review credential-secret"],
        truncated: false,
        truncatedFields: [],
        redacted: true,
        redactedFields: ["input.token"],
      },
    });
    session.emit({
      type: "tool_approval_request",
      id: "native-edit",
      toolCallId: "call-edit",
      toolKind: "edit",
      toolName: "edit",
      tier: "write",
      identity: { kind: "edit", paths: ["src/a.ts", "src/b.ts"], content: "replacement" },
      input: { paths: ["src/a.ts", "src/b.ts"] },
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    });
    const editPermission = events.findLast(
      (event) => event.type === "session.permission" && event.request.name === "omp.edit",
    );
    if (editPermission?.type !== "session.permission") throw new Error("Expected edit permission");
    expect(editPermission.request.detail).toEqual({
      type: "edit",
      filePath: "src/a.ts",
      newString: "replacement",
    });
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: editPermission.request.id,
      response: { behavior: "deny", selectedActionId: "deny" },
    });
    const permission = events.findLast(
      (event) => event.type === "session.permission" && event.request.name === "omp.bash",
    );
    if (permission?.type !== "session.permission") throw new Error("Expected tool permission");
    expect(permission.request).toMatchObject({
      kind: "tool",
      description: "Review <redacted>",
      input: {
        token: "<redacted>",
        command: "echo <redacted>",
        identity: { kind: "shell", command: "echo <redacted>" },
      },
      detail: { type: "shell", command: "echo <redacted>" },
      actions: [
        expect.objectContaining({ id: "allow", behavior: "allow" }),
        expect.objectContaining({ id: "deny", behavior: "deny" }),
      ],
    });
    expect(JSON.stringify(permission.request)).not.toContain("credential-secret");
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "allow" },
    });
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "allow", selectedActionId: "allow" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    expect(session.toolApprovalResponses).toEqual([
      {
        type: "tool_approval_response",
        id: "native-edit",
        toolCallId: "call-edit",
        approved: false,
      },
      {
        type: "tool_approval_response",
        id: "native-shell",
        toolCallId: "call-shell",
        approved: true,
      },
    ]);

    session.emit({
      type: "tool_approval_request",
      id: "native-cancel",
      toolCallId: "call-cancel",
      toolKind: "write",
      toolName: "write",
      tier: "write",
      identity: { kind: "write", path: "out.txt", content: "safe" },
      input: { path: "out.txt", content: "safe" },
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    });
    const canceled = events.findLast(
      (event) => event.type === "session.permission" && event.request.name === "omp.write",
    );
    if (canceled?.type !== "session.permission") throw new Error("Expected cancellable permission");
    session.emit({
      type: "tool_approval_cancel",
      id: "cancel-frame",
      targetId: "native-cancel",
      toolCallId: "call-cancel",
    });
    session.emit({
      type: "tool_approval_cancel",
      id: "duplicate-cancel-frame",
      targetId: "native-cancel",
      toolCallId: "call-cancel",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === canceled.request.id,
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("forwards and enforces denied tools before launching OMP", async () => {
    const { connection, events, runtime } = await createHarness();
    type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;
    const request: Omit<SessionOpenInput, "config"> & {
      config: SessionOpenInput["config"] & { deniedTools: readonly string[] };
    } = {
      type: "session.open",
      requestId: "denied-tools",
      sessionId: "denied-tools-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        deniedTools: ["bash", "write"],
        persist: false,
      },
      history: "skip",
    };
    await connection.send(request);
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "denied-tools",
    );
    expect(runtime.starts[0]?.tools).not.toContain("bash");
    expect(runtime.starts[0]?.tools).not.toContain("write");
    expect(runtime.starts[0]?.tools).toContain("read");
    await connection.close();
  });

  test("omits thinking options without recognized effort metadata", () => {
    const variants: OmpModel[] = [
      { provider: "test", id: "absent", reasoning: true },
      { provider: "test", id: "empty", reasoning: true, thinking: { efforts: [] } },
      {
        provider: "test",
        id: "unknown",
        reasoning: true,
        thinking: { efforts: ["ultra", "extreme"] },
      },
    ];

    for (const model of mapOmpModels(variants)) {
      expect(model.thinkingOptions).toBeUndefined();
      expect(model.defaultThinkingOptionId).toBeUndefined();
    }
  });

  test("accepts catalog state without a thinking level", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.omitNextThinkingLevel = true;
    const { connection, events } = await createHarness(runtime);

    await connection.send({ type: "catalog", requestId: "catalog-no-thinking", cwd: "/repo" });
    const event = await events.waitFor(
      (candidate) => candidate.type === "catalog" && candidate.requestId === "catalog-no-thinking",
    );

    expect(event).toEqual(
      expect.objectContaining({
        catalog: expect.not.objectContaining({ defaultThinkingOption: expect.anything() }),
      }),
    );
    await connection.close();
  });

  test("omits an unsupported active thinking level from catalog defaults", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "medium";
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "catalog",
      requestId: "catalog-unsupported-default",
      cwd: "/repo",
    });
    const event = await events.waitFor(
      (candidate) =>
        candidate.type === "catalog" && candidate.requestId === "catalog-unsupported-default",
    );
    if (event.type !== "catalog") throw new Error("Expected catalog event");

    expect(event.catalog.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);
    expect("defaultThinkingOption" in event.catalog).toBe(false);
    await connection.close();
  });
  test("accepts bounded future model and state metadata from RPC", async () => {
    const futureModel = {
      provider: "future-provider",
      id: "future-model",
      name: 42,
      reasoning: true,
      thinking: {
        efforts: ["low", 42, "x".repeat(33), "high", ...Array(20).fill("medium")],
        defaultLevel: { future: true },
      },
      input: ["text", 42, "x".repeat(257), "image", ...Array(20).fill("audio")],
      contextWindow: "large",
    };
    const futureCatalog = [
      ...Array.from({ length: 600 }, (_, index) => ({
        provider: "provider",
        id: `model-${index}`,
      })),
      futureModel,
    ];
    let child: ProviderRpcChild;
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        child = new ProviderRpcChild((command) => {
          child.write({
            type: "response",
            id: command.id,
            success: true,
            data:
              command.type === "negotiate_protocol"
                ? { protocolVersion: 2 }
                : command.type === "get_available_models"
                  ? { models: futureCatalog }
                  : {
                      model: futureModel,
                      thinkingLevel: "future-thinking",
                      isStreaming: false,
                      isCompacting: false,
                      sessionId: NATIVE_SESSION_ID,
                    },
          });
        });
        queueMicrotask(() =>
          child.write({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
        );
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
    });
    const session = await runtime.startSession({
      cwd: "/repo",
      environment: TEST_RUNTIME_ENV,
      noSession: true,
    });
    const [models, state] = await Promise.all([session.getAvailableModels(), session.getState()]);

    expect(models).toHaveLength(601);
    expect(models.at(-1)).toEqual({
      provider: "future-provider",
      id: "future-model",
      reasoning: true,
      thinking: {
        efforts: ["low", "high", ...Array(14).fill("medium")],
      },
      input: ["text", "image", ...Array(14).fill("audio")],
    });
    expect(state).toMatchObject({
      model: models.at(-1),
      thinkingLevel: "future-thinking",
      isStreaming: false,
      isCompacting: false,
      sessionId: NATIVE_SESSION_ID,
    });
    await session.close();
  });

  test("rejects model 257 during initial session open", async () => {
    const hiddenModel: OmpModel = { provider: "future-provider", id: "hidden-model" };
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [
      MODEL,
      ...Array.from(
        { length: 255 },
        (_, index): OmpModel => ({ provider: "provider", id: `model-${index}` }),
      ),
      hiddenModel,
    ];
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "hidden-model-open",
      sessionId: "hidden-model-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: ompModelId(hiddenModel),
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "hidden-model-open",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP model is not advertised by the configured session runtime" },
      }),
    );
    expect(sessionAt(runtime).modelChanges).toEqual([]);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    await connection.close();
  });

  test("rebuilds a bounded public catalog when fallback selects model 257", async () => {
    const runtime = new FakeOmpRuntime();
    const fallbackModel: OmpModel = {
      provider: "future-provider",
      id: "fallback-model",
      reasoning: true,
      thinking: { efforts: ["low", "high"], defaultLevel: "high" },
    };
    runtime.availableModels = [
      MODEL,
      ...Array.from(
        { length: 255 },
        (_, index): OmpModel => ({ provider: "provider", id: `model-${index}` }),
      ),
      fallbackModel,
    ];
    const { connection, events } = await createHarness(runtime);
    await openSession(
      connection,
      events,
      "oversized-catalog-open",
      "oversized-catalog-session",
      {},
      MODEL_PUBLIC_ID,
      null,
      true,
    );

    const initialConfig = events.findLast((event) => event.type === "session.config");
    if (initialConfig?.type !== "session.config") throw new Error("Expected session config");
    expect(initialConfig.config.models).toHaveLength(256);
    expect(
      initialConfig.config.models.some((model) => model.id === ompModelId(fallbackModel)),
    ).toBe(false);

    await connection.send({
      type: "session.configure",
      requestId: "select-hidden-model",
      sessionId: "oversized-catalog-session",
      changes: { model: ompModelId(fallbackModel) },
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "select-hidden-model",
    );
    expect(sessionAt(runtime).modelChanges).toEqual([]);

    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ompModelId(fallbackModel),
    );
    const session = sessionAt(runtime);
    session.currentModel = fallbackModel;
    session.thinkingLevel = "high";
    session.emit({ type: "retry_fallback_succeeded", model: "future", role: "default" });
    const fallbackConfig = await refreshed;
    if (fallbackConfig.type !== "session.config") throw new Error("Expected fallback config");
    expect(fallbackConfig.config.models).toHaveLength(256);
    expect(
      fallbackConfig.config.models.some((model) => model.id === ompModelId(fallbackModel)),
    ).toBe(true);
    expect(session.closes).toBe(0);
    session.emit({ type: "process_exit", error: "fallback runtime exited" });
    runtime.nextModel = fallbackModel;
    runtime.nextThinkingLevel = "high";
    const turnId = turnIdFrom(
      await startPrompt(
        connection,
        events,
        "fallback-257-recovery",
        "continue",
        "oversized-catalog-session",
      ),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: undefined,
        thinkingOption: undefined,
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    const recoveredConfig = events.findLast((event) => event.type === "session.config");
    if (recoveredConfig?.type !== "session.config") throw new Error("Expected recovered config");
    expect(recoveredConfig.config.models).toHaveLength(256);
    expect(
      recoveredConfig.config.models.some((model) => model.id === ompModelId(fallbackModel)),
    ).toBe(true);
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("rejects a duplicate model identity at catalog entry 257", async () => {
    const runtime = new FakeOmpRuntime();
    const first: OmpModel = { provider: "provider", id: "model-0" };
    runtime.availableModels = [
      first,
      ...Array.from(
        { length: 255 },
        (_, index): OmpModel => ({ provider: "provider", id: `model-${index + 1}` }),
      ),
      { ...first },
    ];
    const { connection, events } = await createHarness(runtime);

    await connection.send({ type: "catalog", requestId: "duplicate-257", cwd: "/repo" });
    await expect(
      events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "duplicate-257",
      ),
    ).resolves.toEqual(
      expect.objectContaining({ error: { message: expect.stringContaining("diagnostic") } }),
    );
    await connection.close();
  });

  test("blocks repeated catalog discovery after unverified cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    const failures: OmpOperationalFailure[] = [];
    runtime.nextCloseError = new Error("catalog cleanup failed");
    const { connection, events } = await createHarness(
      runtime,
      new ManualScheduler(),
      undefined,
      undefined,
      (failure) => failures.push(failure),
    );
    for (const requestId of ["catalog-cleanup-failure", "catalog-cleanup-retry"]) {
      await connection.send({ type: "catalog", requestId, cwd: "/repo" });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(runtime.starts).toHaveLength(1);
    expect(failures).toEqual([{ category: "session-open", stage: "catalog" }]);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("rejects unadvertised catalog and session state models", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [MODEL];
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);
    await connection.send({ type: "catalog", requestId: "unadvertised-catalog", cwd: "/repo" });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unadvertised-catalog",
    );
    runtime.nextModel = ALTERNATE_MODEL;
    await connection.send({
      type: "session.open",
      requestId: "unadvertised-open",
      sessionId: "unadvertised-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unadvertised-open",
    );
    await connection.close();
  });

  test("preserves model display fields while retaining native runtime identity", async () => {
    const maliciousModel: OmpModel = {
      provider: "API_KEY=provider-secret",
      id: "/home/private/model",
      name: "Authorization: Basic model-secret",
      reasoning: false,
    };
    const slashIdModel: OmpModel = { provider: "a", id: "b/c", name: "B\u0007name" };
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [maliciousModel, slashIdModel];
    runtime.nextModel = maliciousModel;
    const { connection, events } = await createHarness(runtime);
    await connection.send({ type: "catalog", requestId: "malicious-catalog", cwd: "/repo" });
    const catalog = await events.waitFor(
      (event) => event.type === "catalog" && event.requestId === "malicious-catalog",
    );
    if (catalog.type !== "catalog") throw new Error("Expected catalog event");
    const publicModelId = catalog.catalog.models[0]?.id;
    if (!publicModelId) throw new Error("Expected projected model");
    runtime.nextModel = maliciousModel;
    runtime.omitNextThinkingLevel = true;
    await openSession(
      connection,
      events,
      "malicious-open",
      "session-1",
      { TEST_ENV: "test-value" },
      publicModelId,
      null,
    );
    const config = events.find(
      (event) => event.type === "session.config" && event.sessionId === "session-1",
    );
    const visible = JSON.stringify([catalog, config]);
    await connection.send({
      type: "session.configure",
      requestId: "malicious-model-select",
      sessionId: "session-1",
      changes: { model: publicModelId },
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "malicious-model-select",
    );
    expect(catalog.catalog.models[0]).toMatchObject({
      label: "API_KEY=provider-secret/Authorization: Basic model-secret",
      description: "API_KEY=provider-secret//home/private/model",
      metadata: {
        provider: "API_KEY=provider-secret",
        modelId: "/home/private/model",
      },
    });
    expect(catalog.catalog.models[1]).toMatchObject({
      label: "a/B\u0007name",
      description: "a/b/c",
      metadata: { provider: "a", modelId: "b/c" },
    });
    expect(visible).toContain("omp:model:");
    if (catalog.type !== "catalog") throw new Error("Expected catalog event");
    expect(new Set(catalog.catalog.models.map((model) => model.id)).size).toBe(2);
    expect(catalog.catalog.models.every((model) => model.id.startsWith("omp:model:"))).toBe(true);
    expect(runtime.starts[1]?.model).toBeUndefined();
    expect(sessionAt(runtime, 1).modelChanges).toContainEqual({
      provider: maliciousModel.provider,
      modelId: maliciousModel.id,
    });
    await connection.close();
  });

  test("applies configured exact replacement to catalog text", async () => {
    const model: OmpModel = {
      provider: "provider",
      id: "model",
      name: "catalog-secret",
      reasoning: false,
    };
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [model];
    runtime.nextModel = model;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "catalog",
      requestId: "configured-redaction-catalog",
      cwd: "/repo",
      providerOptions: {
        outputRedaction: "configured-values",
        env: { MODEL_API_KEY: "catalog-secret" },
      },
    } as never);
    const catalog = await events.waitFor(
      (event) => event.type === "catalog" && event.requestId === "configured-redaction-catalog",
    );

    expect(catalog).toEqual(
      expect.objectContaining({
        catalog: expect.objectContaining({
          models: [expect.objectContaining({ label: "provider/<redacted>" })],
        }),
      }),
    );
    expect(runtime.starts[0]?.outputRedaction).toBe("configured-values");
    await connection.close();
  });
  test("rejects slash-containing native model providers", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [{ provider: "ambiguous/provider", id: "model/id" }];
    runtime.nextModel = runtime.availableModels[0] ?? null;
    const { connection, events } = await createHarness(runtime);

    await connection.send({ type: "catalog", requestId: "slash-provider", cwd: "/repo" });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "slash-provider",
    );
    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP reported an invalid model provider" } }),
    );
    await connection.close();
  });

  test("publishes the launch mode as immutable session status", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);

    expect(events.map((event) => event.type)).toEqual([
      "session.opened",
      "session.config",
      "session.commands",
      "session.ready",
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          mode: "full",
          modes: [
            expect.objectContaining({
              id: "full",
              label: "Full Access (fixed for session)",
              description:
                "Runs all tools without approval prompts. Approval mode is fixed for this session; create a new session to choose another mode.",
            }),
          ],
          thinkingOption: "medium",
        }),
      }),
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        mode: "full",
        thinkingOption: undefined,
        systemPrompt: "Be precise",
      }),
    );
    expect(runtime.starts[0]?.model).toBeUndefined();
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "prompt.steer",
      "session.configure",
      "permission",
    ]);
    await connection.close();
  });
});
