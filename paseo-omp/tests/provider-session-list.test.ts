import { describe, expect, test } from "vitest";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import {
  ALTERNATE_MODEL,
  ALTERNATE_MODEL_PUBLIC_ID,
  createHarness,
  EventLog,
  FakeOmpRuntime,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  ProviderRpcChild,
  sessionAt,
  TEST_RUNTIME_ENV,
} from "./helpers/provider-harness";

describe("OMP direct provider", () => {
  test("lists host-wide sessions while rejecting cwd relocation", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/other" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.list",
      "session.persistence",
    ]);
    await connection.send({ type: "sessions", requestId: "unscoped-list" });
    await expect(
      events.waitFor((event) => event.type === "sessions" && event.requestId === "unscoped-list"),
    ).resolves.toEqual({
      type: "sessions",
      requestId: "unscoped-list",
      sessions: [
        { persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } }, cwd: "/other" },
      ],
    });
    await connection.send({
      type: "session.open",
      requestId: "wrong-cwd",
      sessionId: "wrong-cwd-session",
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
      (event) => event.type === "request.failed" && event.requestId === "wrong-cwd",
    );
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.sessionListRequests).toEqual([
      { query: undefined, limit: undefined, sessionDir: undefined },
      { sessionId: NATIVE_SESSION_ID, cwd: "/repo", limit: 2 },
    ]);
    await connection.close();
  });

  test("makes replaying sessions closable and routes a ready-callback prompt", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const historyStarted = Promise.withResolvers<void>();
    runtime.nextHistoryObserved = historyStarted.resolve;
    runtime.nextHistoryGate = Promise.withResolvers<void>().promise;
    const stalled = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await stalled.connection.send({
      type: "session.open",
      requestId: "stalled-replay",
      sessionId: "stalled-session",
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
    await historyStarted.promise;
    await expect(stalled.connection.close()).resolves.toBeUndefined();
    expect(stalled.events.some((event) => event.type === "session.ready")).toBe(false);

    const readyRuntime = new FakeOmpRuntime();
    readyRuntime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const ready = await createHarness(readyRuntime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    ready.connection.onEvent((event) => {
      if (event.type !== "session.ready") return;
      void ready.connection.send({
        type: "session.prompt",
        sessionId: "ready-race-session",
        prompt: {
          clientMessageId: "ready-race-prompt",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "continue" }] },
        },
      });
    });
    await ready.connection.send({
      type: "session.open",
      requestId: "ready-race",
      sessionId: "ready-race-session",
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
    const result = await ready.events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "ready-race-prompt",
    );
    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
    );
    await ready.connection.close();
  });

  test("does not negotiate persistence or rewind when history replay is unavailable", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.supportsPersistence = false;
    const { connection } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });

  test("rejects RPC v1 before opening a rich provider session", async () => {
    const children: ProviderRpcChild[] = [];
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        const child = new ProviderRpcChild(() => {});
        children.push(child);
        queueMicrotask(() =>
          child.write({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
        );
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence", "session.revert.conversation"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "session.persistence",
      "session.revert.conversation",
    ]);

    await connection.send({
      type: "session.open",
      requestId: "legacy-v1-open",
      sessionId: "legacy-v1-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      history: "skip",
    });
    await expect(
      events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "legacy-v1-open",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        error: { message: "OMP provider requires OMP RPC protocol v2" },
      }),
    );
    expect(events.some((event) => event.type === "session.opened")).toBe(false);
    expect(children).toHaveLength(1);
    await connection.close();
  });
  test("tombstones an unreaped session after history replay fails", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryError = new Error("invalid chunked history");
    runtime.nextCloseError = new Error("process tree not reaped");
    const failures: OmpOperationalFailure[] = [];
    const { connection, events } = await createHarness(
      runtime,
      new ManualScheduler(),
      ["prompt.message", "session.persistence"],
      undefined,
      (failure) => failures.push(failure),
    );
    const open = (requestId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId: "replay-failure-session",
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
    await open("replay-failure");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "replay-failure",
    );
    await open("replay-reopen");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "replay-reopen",
    );
    expect(runtime.starts).toHaveLength(1);
    expect(failures).toEqual([{ category: "replay-recovery", stage: "persisted-replay" }]);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    await expect(connection.close()).rejects.toThrow("provider connection cleanup failed");
  });

  test("reconciles config events emitted after the final opening state snapshot", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionCreated = (session) => {
      session.stateObserved = () => {
        if (session.stateLookups !== 2) return;
        queueMicrotask(() => {
          session.currentModel = ALTERNATE_MODEL;
          session.thinkingLevel = "high";
          session.emit({ type: "model_changed" });
        });
      };
    };
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const reconciled = await events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );

    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      "session.opened",
      "session.config",
      "session.commands",
      "session.ready",
    ]);
    expect(reconciled).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    expect(sessionAt(runtime).stateLookups).toBeGreaterThanOrEqual(3);
    await connection.close();
  });
  test("rejects unadvertised raw model identifiers", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "raw-model-open",
      sessionId: "raw-model-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: "anthropic/claude-sonnet-4-5",
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "raw-model-open",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP model is not advertised by the configured session runtime" },
      }),
    );
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    expect(sessionAt(runtime).modelChanges).toHaveLength(0);
    await connection.close();
  });

  test("rejects unsupported thinking after resolving the committed open model", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "unsupported-thinking-open",
      sessionId: "unsupported-thinking-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: ALTERNATE_MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "medium",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unsupported-thinking-open",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP thinking level is unavailable for the selected model" },
      }),
    );
    expect(runtime.starts[0]?.thinkingOption).toBeUndefined();
    expect(sessionAt(runtime).thinkingChanges).toEqual([]);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    expect(sessionAt(runtime).closes).toBe(1);
    await connection.close();
  });
  test("rejects unknown startup thinking without sending it to OMP", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "unknown-thinking-open",
      sessionId: "unknown-thinking-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: ALTERNATE_MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "future-thinking",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unknown-thinking-open",
    );
    expect(runtime.starts[0]?.thinkingOption).toBeUndefined();
    expect(sessionAt(runtime).thinkingChanges).toEqual([]);
    await connection.close();
  });

  test.each([129, 256])(
    "accepts %i inherited and session environment entries through preflight",
    async (entryCount) => {
      const inheritedNames = Array.from({ length: entryCount }, (_, index) => `INHERITED_${index}`);
      const runtime = new FakeOmpRuntime();
      const connection = await createOmpProvider({
        runtime,
        environment: {
          ...TEST_RUNTIME_ENV,
          ...Object.fromEntries(
            inheritedNames.map((name, index) => [name, `inherited-value-${index}`]),
          ),
        },
      }).connect({ versions: [1], capabilities: ["prompt.message"] });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      const sessionEnvironment = Object.fromEntries(
        Array.from({ length: entryCount }, (_, index) => [`SESSION_${index}`, "value"]),
      );

      await connection.send({
        type: "catalog",
        requestId: `catalog-env-${entryCount}`,
        cwd: "/repo",
        providerOptions: { inheritEnv: inheritedNames },
        settings: {},
      } as never);
      await events.waitFor(
        (event) => event.type === "catalog" && event.requestId === `catalog-env-${entryCount}`,
      );
      await openSession(
        connection,
        events,
        `session-env-${entryCount}`,
        `session-${entryCount}`,
        sessionEnvironment,
        MODEL_PUBLIC_ID,
        "medium",
        false,
        { providerOptions: { inheritEnv: inheritedNames } },
      );

      expect(runtime.starts.at(-1)?.env).toHaveProperty(`SESSION_${entryCount - 1}`, "value");
      expect(runtime.starts.at(-1)?.inheritEnv).toContain(`INHERITED_${entryCount - 1}`);
      await connection.close();
    },
  );

  test("rejects 257 inherited or session environment entries", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    const names = Array.from({ length: 257 }, (_, index) => `VALUE_${index}`);
    const entries = Object.fromEntries(names.map((name) => [name, "value"]));

    await connection.send({
      type: "catalog",
      requestId: "catalog-env-257",
      cwd: "/repo",
      providerOptions: { inheritEnv: names },
      settings: {},
    } as never);
    await expect(
      events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "catalog-env-257",
      ),
    ).resolves.toEqual(
      expect.objectContaining({ error: { message: "Provider configuration is too large" } }),
    );
    await expect(
      openSession(
        connection,
        events,
        "inherit-env-257",
        "inherit-257",
        {},
        MODEL_PUBLIC_ID,
        "medium",
        false,
        { providerOptions: { inheritEnv: names } },
      ),
    ).rejects.toThrow();
    await expect(
      openSession(
        connection,
        events,
        "session-env-257",
        "session-257",
        entries,
        MODEL_PUBLIC_ID,
        "medium",
        false,
      ),
    ).rejects.toThrow();

    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });

  test("keeps default collection limits for unrelated provider options", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "catalog",
      requestId: "catalog-unexpected-options",
      cwd: "/repo",
      providerOptions: {
        unexpected: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`ENTRY_${index}`, "value"]),
        ),
      },
      settings: {},
    } as never);

    await expect(
      events.waitFor(
        (event) =>
          event.type === "request.failed" && event.requestId === "catalog-unexpected-options",
      ),
    ).resolves.toEqual(
      expect.objectContaining({ error: { message: "Provider configuration is too large" } }),
    );
    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });

  test("rejects malformed capabilities and filters unsupported capability names", async () => {
    const provider = createOmpProvider({
      runtime: new FakeOmpRuntime(),
      environment: TEST_RUNTIME_ENV,
    });
    await expect(
      provider.connect({ versions: [1], capabilities: ["prompt.message", 42] } as never),
    ).rejects.toThrow("valid provider protocol version 1 request");
    await expect(
      provider.connect({
        versions: Array.from({ length: 33 }, () => 1),
        capabilities: ["prompt.message"],
      }),
    ).rejects.toThrow("oversized connection request");

    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message", "permission.tool_policy", "provider.admin"],
    });
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });
  test("rejects malformed permission responses and advertises permission support", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "permission"],
    });

    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: "permission-1",
        response: { behavior: "allow", updatedPermissions: Array.from({ length: 65 }, () => ({})) },
      } as never),
    ).rejects.toThrow("Invalid permission response");
    expect(connection.capabilities).toContain("permission");
    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });

  test("validates the OMP spawn before opening configured MCP transports", async () => {
    const runtime = new FakeOmpRuntime();
    let connections = 0;
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => {
        connections += 1;
        throw new Error("must not connect");
      },
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "invalid-spawn-before-mcp",
      sessionId: "session-invalid-spawn",
      config: {
        cwd: "relative/workspace",
        env: {},
        mcpServers: { repo: { type: "stdio", command: "repo-mcp" } },
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "invalid-spawn-before-mcp",
    );
    expect(connections).toBe(0);
    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });

  test("rejects excessive MCP servers before connector or OMP spawn", async () => {
    const runtime = new FakeOmpRuntime();
    let connections = 0;
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => {
        connections += 1;
        throw new Error("must not connect");
      },
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "excessive-mcp-servers",
      sessionId: "session-excessive-mcp",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `server-${index}`,
            { type: "stdio" as const, command: "server" },
          ]),
        ),
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "excessive-mcp-servers",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("server count exceeds"),
        }),
      }),
    );
    expect(connections).toBe(0);
    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });
  test("tombstones timed-out MCP initialization until every owned close settles", async () => {
    const runtime = new FakeOmpRuntime();
    const lateConnection = Promise.withResolvers<{
      listTools(): Promise<{ tools: [] }>;
      callTool(): Promise<{ content: [] }>;
      close(): Promise<void>;
    }>();
    const lateCloseStarted = Promise.withResolvers<void>();
    const releaseLateClose = Promise.withResolvers<void>();
    let connectorCalls = 0;
    let firstCloses = 0;
    let lateCloses = 0;
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpInitializationTimeoutMs: 5,
      mcpConnector: async () => {
        connectorCalls += 1;
        if (connectorCalls === 1) {
          return {
            listTools: async () => ({ tools: [] }),
            callTool: async () => ({ content: [] }),
            close: async () => {
              firstCloses += 1;
              throw new Error("first close failed");
            },
          };
        }
        return await lateConnection.promise;
      },
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    const open = (requestId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId: "mcp-timeout-session",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {
            first: { type: "stdio", command: "first" },
            second: { type: "stdio", command: "second" },
          },
          model: MODEL_PUBLIC_ID,
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });

    await open("mcp-timeout-open");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "mcp-timeout-open",
    );
    await open("mcp-timeout-reopen-pending");
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "mcp-timeout-reopen-pending",
    );
    expect(connectorCalls).toBe(2);
    expect(runtime.starts).toHaveLength(0);

    lateConnection.resolve({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        lateCloses += 1;
        lateCloseStarted.resolve();
        await releaseLateClose.promise;
        throw new Error("late close failed");
      },
    });
    await lateCloseStarted.promise;
    expect(firstCloses).toBe(1);
    expect(lateCloses).toBe(1);
    await open("mcp-timeout-reopen-closing");
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "mcp-timeout-reopen-closing",
    );
    let closeSettled = false;
    const closing = connection.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseLateClose.resolve();
    await expect(closing).rejects.toThrow("provider connection cleanup failed");
    expect(closeSettled).toBe(true);
    expect(connectorCalls).toBe(2);
  });

  test("drains a cleanup tombstone created by an active open during shutdown", async () => {
    const runtime = new FakeOmpRuntime();
    const secondConnectStarted = Promise.withResolvers<void>();
    const firstCloseStarted = Promise.withResolvers<void>();
    const releaseFirstClose = Promise.withResolvers<void>();
    let connectorCalls = 0;
    const connection = await createOmpProvider({
      runtime,
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async (_name, _config, _cwd, signal) => {
        connectorCalls += 1;
        if (connectorCalls === 1) {
          return {
            listTools: async () => ({ tools: [] }),
            callTool: async () => ({ content: [] }),
            close: async () => {
              firstCloseStarted.resolve();
              await releaseFirstClose.promise;
              throw new Error("first cleanup failed");
            },
          };
        }
        secondConnectStarted.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
        });
      },
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    await connection.send({
      type: "session.open",
      requestId: "shutdown-open",
      sessionId: "shutdown-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {
          first: { type: "stdio", command: "first" },
          second: { type: "stdio", command: "second" },
        },
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await secondConnectStarted.promise;
    const closing = connection.close();
    await firstCloseStarted.promise;
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFirstClose.resolve();
    await expect(closing).rejects.toThrow("provider connection cleanup failed");
    expect(runtime.starts).toHaveLength(0);
  });

  test("rejects unsupported MCP policy and dangerous environment without serializing config", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "permission.tool_policy"],
    });
    expect(connection.capabilities).not.toContain("permission.tool_policy");
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "unsupported-policy",
      sessionId: "session-mcp",
      config: {
        cwd: "/repo",
        env: { API_TOKEN: "credential-value" },
        mcpServers: { filesystem: { type: "stdio", command: "cat", args: ["/etc/passwd"] } },
        toolPolicy: { preapproved: [] },
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const preapprovalFailure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unsupported-policy",
    );
    expect(preapprovalFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP does not support host tool policies" },
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "dangerous-env",
      sessionId: "session-env",
      config: {
        cwd: "/repo",
        env: { LD_PRELOAD: "/tmp/injected.so" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "dangerous-env",
    );

    expect(runtime.starts).toHaveLength(0);
    const visible = JSON.stringify(events);
    expect(visible).not.toContain("credential-value");
    expect(visible).not.toContain("/etc/passwd");
    expect(visible).not.toContain("/tmp/injected.so");
    await connection.close();
  });
});
