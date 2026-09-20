import { describe, expect, test } from "vitest";
import { OmpBrowserAuthorizationRegistry } from "../server/mcp-browser";
import { withOmpWorkspaceIdentity } from "../server/provider/host-tools";
import { createOmpProvider } from "../server/provider/registration";
import { startFetchServer } from "./helpers/http-server";
import {
  createHostToolHarness,
  EventLog,
  expectBootstrapHostToolTerminal,
  FakeOmpRuntime,
  finishTurn,
  type HostAgentManagerConstructor,
  type HostRegistryConstructor,
  type HostSession,
  type HostTimelineItem,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openHostToolSession,
  pino,
  pluginProviderModulePath,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("AgentManager preserves caller workspace identity through a real host-tool execution", async () => {
    const runtime = new FakeOmpRuntime();
    const agentId = "00000000-0000-4000-8000-000000000001";
    const toolExecuted = Promise.withResolvers<{
      callerAgentId: string | null;
      authorization: string | null;
      input: unknown;
      ownerPid: number;
      ownerCwd: string;
    }>();
    const mcpServer = await startFetchServer(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const payload = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      let result: Record<string, unknown>;
      if (payload.method === "initialize") {
        const params = payload.params as { protocolVersion?: string } | undefined;
        result = {
          protocolVersion: params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "paseo-host-test", version: "1.0.0" },
        };
      } else if (payload.method === "tools/list") {
        result = {
          tools: [
            {
              name: "workspace_probe",
              description: "Return caller workspace identity",
              inputSchema: { type: "object" },
            },
          ],
        };
      } else if (payload.method === "tools/call") {
        const url = new URL(request.url);
        toolExecuted.resolve({
          callerAgentId: url.searchParams.get("callerAgentId"),
          authorization: request.headers.get("authorization"),
          input: payload.params,
          ownerPid: process.pid,
          ownerCwd: process.cwd(),
        });
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ownerPid: process.pid, ownerCwd: process.cwd() }),
            },
          ],
        };
      } else {
        return Response.json(
          { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "Not found" } },
          { status: 404 },
        );
      }
      return Response.json({ jsonrpc: "2.0", id: payload.id, result });
    });
    const registration = createOmpProvider({
      runtime,
      timelineScheduler: new ManualScheduler(),
      environment: TEST_RUNTIME_ENV,
      availabilityProbe: async () => ({ status: "available" }),
    });
    // Dynamic imports intentionally exercise the installed daemon's CJS/ESM plugin boundary.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const agentManagerModule = (await import(
      "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js"
    )) as unknown as { AgentManager: HostAgentManagerConstructor };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const lifecycle = {
      async before(name: string, request: unknown) {
        if (name !== "agent.session_open") return request;
        return withOmpWorkspaceIdentity(
          request as {
            agentId: string;
            workspaceId: string | null;
            env: Record<string, string>;
          },
        );
      },
      emit() {},
    };
    const manager = new agentManagerModule.AgentManager({
      logger: pino({ enabled: false }),
      clients: registry.clients(),
      providerDefinitions: registry.definitions(),
      pluginLifecycle: lifecycle,
      mcpBaseUrl: `http://127.0.0.1:${mcpServer.port}/mcp/agents`,
      mcpAuthToken: "host-capability-token",
      paseoToolsEnabled: true,
      idFactory: () => agentId,
    });

    let createdAgentId: string | undefined;
    try {
      const agent = await manager.createAgent(
        {
          provider: registration.id,
          cwd: process.cwd(),
          model: MODEL_PUBLIC_ID,
          modeId: "full",
          featureValues: {},
        },
        undefined,
        { workspaceId: "workspace-1", persistSession: false },
      );
      createdAgentId = agent.id;
      expect(agent.id).toBe(agentId);
      expect(runtime.starts[0]?.env).toEqual(
        expect.objectContaining({
          PASEO_AGENT_ID: agentId,
          PASEO_AGENT_CWD: process.cwd(),
          PASEO_WORKSPACE_ID: "workspace-1",
        }),
      );
      const native = sessionAt(runtime);
      expect(native.hostToolCatalogs[0]).toEqual([
        expect.objectContaining({
          name: "workspace_probe",
          loadMode: "essential",
        }),
      ]);
      const hostToolResult = Promise.withResolvers<void>();
      native.hostToolResultObserved = hostToolResult.resolve;
      native.emit({
        type: "host_tool_call",
        id: "host-call-1",
        toolCallId: "tool-call-1",
        toolName: "workspace_probe",
        arguments: { expectedWorkspaceId: "workspace-1" },
      });
      const execution = await toolExecuted.promise;
      expect(execution).toEqual(
        expect.objectContaining({
          callerAgentId: agentId,
          authorization: "Bearer host-capability-token",
          ownerPid: process.pid,
          ownerCwd: process.cwd(),
        }),
      );
      expect(execution.input).toEqual(
        expect.objectContaining({
          name: "workspace_probe",
          arguments: { expectedWorkspaceId: "workspace-1" },
        }),
      );
      await hostToolResult.promise;
      expect(native.hostToolResults).toEqual([
        expect.objectContaining({
          type: "host_tool_result",
          id: "host-call-1",
          result: expect.objectContaining({
            content: [
              {
                type: "text",
                text: JSON.stringify({ ownerPid: process.pid, ownerCwd: process.cwd() }),
              },
            ],
          }),
        }),
      ]);
      native.emit({ type: "process_exit", error: "OMP exited after host tool execution" });
    } finally {
      if (createdAgentId) await manager.closeAgent(createdAgentId);
      await registry.shutdown();
      mcpServer.stop(true);
    }
  });
  test("registers browser authorization only while the OMP session is active", async () => {
    const browserAuthorizationRegistry = new OmpBrowserAuthorizationRegistry();
    const { connection, events, runtime } = await createHostToolHarness(
      new FakeOmpRuntime(),
      browserAuthorizationRegistry,
    );
    await openHostToolSession(connection, events, "browser-registry-open");
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "browser-auth-request",
      method: "open_url",
      url: "https://auth.example.test/authorize?state=opaque",
      launchUrl: "http://127.0.0.1:4321/launch",
    });
    const card = await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "plugin" &&
        event.item.kind === "omp-mcp-authorization",
    );
    const authorizationToken =
      card.type === "timeline.item" && card.item.type === "plugin"
        ? (card.item.data as Record<string, unknown>).browserAuthorizationToken
        : undefined;
    expect(typeof authorizationToken).toBe("string");

    await expect(browserAuthorizationRegistry.open(String(authorizationToken))).rejects.toThrow(
      "Paseo browser tools are unavailable in this OMP session",
    );

    await connection.send({
      type: "session.close",
      requestId: "browser-registry-close",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "browser-registry-close",
    );
    await expect(browserAuthorizationRegistry.open(String(authorizationToken))).rejects.toThrow(
      "no longer available",
    );
    await connection.close();
  });

  test("uses registered labels for direct and routed MCP timeline calls", async () => {
    const { connection, events, runtime } = await createHostToolHarness();
    await openHostToolSession(connection, events, "host-tool-labels");
    const session = sessionAt(runtime);
    await startPrompt(connection, events, "host-tool-label-turn", "read");
    for (const [toolCallId, toolName, args] of [
      ["direct-host-tool", "mcp__repo_read", {}],
      ["routed-host-tool", "write", { path: "xd://mcp__repo_read", content: "{}" }],
    ] as const) {
      session.emit({ type: "tool_execution_start", toolCallId, toolName, args });
      session.emit({ type: "tool_execution_end", toolCallId, toolName, result: { ok: true } });
    }
    const labeledSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "Repository file lookup"
        ? [event.item]
        : [],
    );
    expect(labeledSnapshots).toHaveLength(4);
    expect(new Set(labeledSnapshots.map((item) => item.id)).size).toBe(2);
    expect(labeledSnapshots.filter((item) => item.status === "completed")).toHaveLength(2);
    await connection.close();
  });

  test("routes one host-tool result while initial host tools bind", async () => {
    const runtime = new FakeOmpRuntime();
    const bindGate = Promise.withResolvers<void>();
    const bindObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.hostToolBindGate = bindGate.promise;
      session.hostToolBindObserved = bindObserved.resolve;
    };
    const { connection, events } = await createHostToolHarness(runtime);

    const opening = openHostToolSession(connection, events, "host-tool-open-bind");
    await bindObserved.promise;
    const session = sessionAt(runtime);
    await expectBootstrapHostToolTerminal(session, "open-bind-call");
    session.emit({
      type: "host_tool_call",
      id: "open-bind-cancelled",
      toolCallId: "open-bind-cancelled-tool-call",
      toolName: "mcp__repo_read",
      arguments: {},
    });
    session.emit({
      type: "host_tool_cancel",
      id: "open-bind-cancel",
      targetId: "open-bind-cancelled",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.hostToolResults.some((result) => result.id === "open-bind-cancelled")).toBe(
      false,
    );
    session.hostToolBindGate = null;
    bindGate.resolve();
    await opening;
    await expectBootstrapHostToolTerminal(session, "open-bind-handoff-call");
    await connection.close();
  });

  test("routes one host-tool result while initial state reconciles", async () => {
    const runtime = new FakeOmpRuntime();
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      session.stateGate = stateGate.promise;
      session.stateObserved = stateObserved.resolve;
    };
    const { connection, events } = await createHostToolHarness(runtime);

    const opening = openHostToolSession(connection, events, "host-tool-open-state");
    await stateObserved.promise;
    const session = sessionAt(runtime);
    await expectBootstrapHostToolTerminal(session, "open-state-call");
    session.stateGate = null;
    stateGate.resolve();
    await opening;
    await connection.close();
  });

  test("routes one host-tool result while recovered host tools bind", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHostToolHarness(runtime);
    await openHostToolSession(connection, events, "host-tool-recovery-bind-open", true);
    const bindGate = Promise.withResolvers<void>();
    const bindObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      if (runtime.sessions.length !== 2) return;
      session.hostToolBindGate = bindGate.promise;
      session.hostToolBindObserved = bindObserved.resolve;
    };
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const prompting = startPrompt(connection, events, "host-tool-recovery-bind", "continue");
    await bindObserved.promise;
    const recovered = sessionAt(runtime, 1);
    await expectBootstrapHostToolTerminal(recovered, "recovery-bind-call");
    recovered.hostToolBindGate = null;
    bindGate.resolve();
    const turnId = turnIdFrom(await prompting);
    await finishTurn(events, recovered, turnId);
    await connection.close();
  });

  test("routes one host-tool result while recovered state reconciles", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHostToolHarness(runtime);
    await openHostToolSession(connection, events, "host-tool-recovery-state-open", true);
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      if (runtime.sessions.length !== 2) return;
      session.stateGate = stateGate.promise;
      session.stateObserved = stateObserved.resolve;
    };
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const prompting = startPrompt(connection, events, "host-tool-recovery-state", "continue");
    await stateObserved.promise;
    const recovered = sessionAt(runtime, 1);
    await expectBootstrapHostToolTerminal(recovered, "recovery-state-call");
    recovered.stateGate = null;
    stateGate.resolve();
    const turnId = turnIdFrom(await prompting);
    await finishTurn(events, recovered, turnId);
    await connection.close();
  });
  test("retires recovery after a bootstrap host-tool terminal write failure", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHostToolHarness(runtime);
    await openHostToolSession(connection, events, "host-tool-write-failure-open", true);
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    runtime.sessionCreated = (session) => {
      if (runtime.sessions.length !== 2) return;
      session.stateGate = stateGate.promise;
      session.stateObserved = stateObserved.resolve;
    };
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const prompting = startPrompt(connection, events, "host-tool-write-failure", "continue");
    await stateObserved.promise;
    const failedReplacement = sessionAt(runtime, 1);
    const writeAttempted = Promise.withResolvers<void>();
    failedReplacement.hostToolResultAttempted = writeAttempted.resolve;
    failedReplacement.hostToolResultError = new Error("OMP RPC has too many pending writes");
    failedReplacement.emit({
      type: "host_tool_call",
      id: "recovery-write-failure-call",
      toolCallId: "recovery-write-failure-tool-call",
      toolName: "mcp__repo_read",
      arguments: {},
    });
    await writeAttempted.promise;
    failedReplacement.stateGate = null;
    stateGate.resolve();

    expect(await prompting).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "OMP session recovery failed" },
        }),
      }),
    );
    expect(failedReplacement.closes).toBe(1);
    expect(failedReplacement.prompts).toHaveLength(0);

    runtime.sessionCreated = null;
    const retryTurnId = turnIdFrom(
      await startPrompt(connection, events, "host-tool-write-failure-retry", "continue"),
    );
    const replacement = sessionAt(runtime, 2);
    expect(runtime.starts).toHaveLength(3);
    await expectBootstrapHostToolTerminal(replacement, "recovery-write-retry-call");
    await finishTurn(events, replacement, retryTurnId);
    await connection.close();
  });
  test("invalidates the runtime when a terminal host-tool frame cannot be queued", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => ({
        listTools: async () => ({
          tools: [{ name: "read", inputSchema: { type: "object" } }],
        }),
        callTool: async () => ({ content: [{ type: "text", text: "done" }] }),
        close: async () => {},
      }),
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "host-result-open",
      sessionId: "host-result-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: { repo: { type: "stdio", command: "repo" } },
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: true,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "host-result-open",
    );
    const first = sessionAt(runtime);
    const closed = Promise.withResolvers<void>();
    first.closeObserved = closed.resolve;
    first.hostToolResultError = new Error("OMP RPC has too many pending writes");
    first.emit({
      type: "host_tool_call",
      id: "host-result-call",
      toolCallId: "host-result-tool-call",
      toolName: "mcp__repo_read",
      arguments: {},
    });
    await closed.promise;

    const prompt = await startPrompt(
      connection,
      events,
      "host-result-recovery",
      "continue",
      "host-result-session",
    );
    expect(runtime.starts).toHaveLength(2);
    expect(sessionAt(runtime, 1).hostToolCatalogs).toHaveLength(1);
    const turnId = turnIdFrom(prompt);
    expect(await finishTurn(events, sessionAt(runtime, 1), turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    await connection.close();
  });

  test("serializes anonymous compactions through the Paseo provider reducer", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    let session: HostSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await client.createSession(
        {
          provider: registration.id,
          cwd: "/repo",
          model: MODEL_PUBLIC_ID,
          mcpServers: {},
          modeId: "full",
          thinkingOptionId: "medium",
          featureValues: {},
        },
        { env: { TEST_ENV: "test-value" } },
        { persistSession: false },
      );
      const timeline: HostTimelineItem[] = [];
      unsubscribe = session.subscribe((event) => {
        if (event.type === "timeline" && event.item) timeline.push(event.item);
      });
      const native = sessionAt(runtime);
      native.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
      native.emit({
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      });
      native.emit({
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: false,
      });
      native.emit({
        type: "auto_compaction_end",
        action: "remote",
        aborted: false,
        willRetry: false,
      });
      native.emit({ type: "compaction_start" });
      native.emit({ type: "compaction_end", aborted: false, willRetry: false });
      await Promise.resolve();

      expect(timeline.filter((item) => item.type === "compaction")).toEqual([
        { type: "compaction", status: "loading", trigger: "auto" },
        { type: "compaction", status: "completed", trigger: "auto" },
        { type: "compaction", status: "loading", trigger: "manual" },
        { type: "compaction", status: "completed", trigger: "manual" },
      ]);
      expect(timeline).toContainEqual({
        type: "error",
        message: "OMP emitted overlapping compactions",
      });
    } finally {
      unsubscribe?.();
      await session?.close();
      await registry.shutdown();
    }
  });
  test("keeps host permission pending when native dispatch fails", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    let session: HostSession | undefined;
    try {
      session = await client.createSession(
        {
          provider: registration.id,
          cwd: "/repo",
          model: MODEL_PUBLIC_ID,
          mcpServers: {},
          modeId: "full",
          thinkingOptionId: "medium",
          featureValues: {},
        },
        { env: { TEST_ENV: "test-value" } },
        { persistSession: false },
      );
      const native = sessionAt(runtime);
      native.emit({
        type: "extension_ui_request",
        id: "host-retry",
        method: "input",
        title: "Branch",
      });
      const permission = session.getPendingPermissions()[0];
      if (!permission) throw new Error("Expected host permission");
      native.extensionUiResponseError = new Error("write failed");
      await expect(
        session.respondToPermission(permission.id, {
          behavior: "allow",
          selectedActionId: "submit",
          updatedInput: { answers: { Branch: "feature/retry" } },
        }),
      ).rejects.toThrow("write failed");
      expect(session.getPendingPermissions().map((request) => request.id)).toEqual([permission.id]);

      native.extensionUiResponseError = null;
      await session.respondToPermission(permission.id, {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { answers: { Branch: "feature/retry" } },
      });
      expect(session.getPendingPermissions()).toEqual([]);
      expect(native.extensionUiResponses).toContainEqual({
        type: "extension_ui_response",
        id: "host-retry",
        value: "feature/retry",
      });
    } finally {
      await session?.close();
      await registry.shutdown();
    }
  });
});
