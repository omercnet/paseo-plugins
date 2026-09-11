import { describe, expect, test } from "bun:test";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import {
  OmpHostToolsBridge,
  type OmpMcpConnection,
  type OmpMcpConnector,
  type OmpMcpTool,
  withOmpWorkspaceIdentity,
} from "../server/provider/host-tools";
import type {
  OmpHostToolDefinition,
  OmpHostToolResult,
  OmpHostToolUpdate,
  OmpRuntimeSession,
} from "../server/provider/omp-rpc";

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd: "/workspace",
    env: {},
    mcpServers: {},
    settings: {},
    persist: false,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeRuntime
  implements Pick<OmpRuntimeSession, "setHostTools" | "sendHostToolResult" | "sendHostToolUpdate">
{
  catalogs: OmpHostToolDefinition[][] = [];
  results: OmpHostToolResult[] = [];
  updates: OmpHostToolUpdate[] = [];
  acceptedNames: string[] | null = null;
  throwUpdates = false;
  throwResults = false;

  setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]> {
    this.catalogs.push(structuredClone([...tools]));
    return Promise.resolve(this.acceptedNames ?? tools.map(({ name }) => name));
  }

  sendHostToolResult(result: OmpHostToolResult): void {
    if (this.throwResults) throw new Error("OMP RPC has too many pending writes");
    this.results.push(structuredClone(result));
  }

  sendHostToolUpdate(update: OmpHostToolUpdate): void {
    if (this.throwUpdates) throw new Error("closed progress channel");
    this.updates.push(structuredClone(update));
  }
}

type CallImplementation = (
  name: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; onProgress: (progress: unknown) => void },
) => Promise<unknown>;

class FakeConnection implements OmpMcpConnection {
  readonly calls: Array<{ name: string; input: Record<string, unknown>; signal: AbortSignal }> = [];
  readonly listSignals: AbortSignal[] = [];
  closes = 0;
  closeError: Error | null = null;

  constructor(
    private readonly tools: readonly OmpMcpTool[],
    private readonly result: unknown,
    private readonly callImplementation?: CallImplementation,
  ) {}

  listTools(options: { signal: AbortSignal }) {
    this.listSignals.push(options.signal);
    return Promise.resolve({ tools: this.tools });
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; onProgress: (progress: unknown) => void },
  ) {
    this.calls.push({ name, input, signal: options.signal });
    if (this.callImplementation) return await this.callImplementation(name, input, options);
    options.onProgress({ progress: 1, total: 2 });
    return this.result;
  }

  async close() {
    this.closes += 1;
    if (this.closeError) throw this.closeError;
  }
}

describe("OMP host tool bridge", () => {
  test("maps verified caller-scoped tools and propagates MCP errors through set_host_tools", async () => {
    const paseo = new FakeConnection(
      [
        {
          name: "read",
          title: "Read workspace file",
          description: "Read from the caller workspace",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      {
        content: [{ type: "text", text: "workspace denied" }],
        structuredContent: { denied: true },
        isError: true,
      },
    );
    const sibling = new FakeConnection(
      [{ name: "status", description: "Status", inputSchema: { type: "object" } }],
      { content: [] },
    );
    const repo = new FakeConnection(
      [{ name: "repo-search", description: "Search", inputSchema: { type: "object" } }],
      { content: [{ type: "text", text: "match" }] },
    );
    const observed: Array<{ name: string; cwd: string; config: unknown; signal: AbortSignal }> = [];
    const connector: OmpMcpConnector = async (name, config, cwd, signal) => {
      observed.push({ name, config, cwd, signal });
      if (name === "paseo") return paseo;
      if (name === "daemon-sibling") return sibling;
      return repo;
    };
    const config = sessionConfig({
      env: { PASEO_AGENT_ID: "agent-1", PASEO_WORKSPACE_ID: "workspace-1" },
      mcpServers: {
        repo: { type: "stdio", command: "repo-mcp", alwaysLoad: false },
        "daemon-sibling": {
          type: "sse",
          url: "HTTP://127.0.0.1:4567/events?callerAgentId=agent-1",
        },
        paseo: {
          type: "http",
          url: "http://127.0.0.1:4567/mcp/agents/?callerAgentId=agent-1",
        },
      },
    });

    const bridge = await OmpHostToolsBridge.open(config, { connectMcp: connector });
    const runtime = new FakeRuntime();
    runtime.throwUpdates = true;
    await bridge.bind(runtime as unknown as OmpRuntimeSession);

    expect(observed.map(({ name }) => name)).toEqual(["paseo", "daemon-sibling", "repo"]);
    expect(observed.every(({ cwd, signal }) => cwd === "/workspace" && !signal.aborted)).toBe(true);
    expect(runtime.catalogs[0]).toEqual([
      expect.objectContaining({ name: "mcp__paseo_read", loadMode: "essential" }),
      expect.objectContaining({ name: "mcp__daemon_sibling_status", loadMode: "essential" }),
      expect.objectContaining({ name: "mcp__repo_search", loadMode: "discoverable" }),
    ]);

    bridge.handle({
      type: "host_tool_call",
      id: "call-1",
      toolCallId: "tool-call-1",
      toolName: "mcp__paseo_read",
      arguments: { path: "README.md" },
    });
    await flushMicrotasks();

    expect(paseo.calls).toHaveLength(1);
    expect(runtime.results).toEqual([
      {
        type: "host_tool_result",
        id: "call-1",
        result: {
          content: [{ type: "text", text: "workspace denied" }],
          details: { denied: true },
          isError: true,
        },
        isError: true,
      },
    ]);
    await bridge.close();
  });

  test("classifies every same-origin daemon endpoint and rejects identity mismatches", async () => {
    let connections = 0;
    const connector: OmpMcpConnector = async () => {
      connections += 1;
      return new FakeConnection([], { content: [] });
    };
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({
          env: { PASEO_AGENT_ID: "agent-1", PASEO_WORKSPACE_ID: "workspace-1" },
          mcpServers: {
            renamed: {
              type: "http",
              url: "http://LOCALHOST:80/mcp/agents?callerAgentId=agent-1",
            },
            sibling: {
              type: "sse",
              url: "http://localhost/events?callerAgentId=agent-2",
            },
          },
        }),
        { connectMcp: connector },
      ),
    ).rejects.toThrow("caller identity does not match");
    expect(connections).toBe(0);
  });

  test("reserves the canonical Paseo namespace and hashes external collisions", async () => {
    const observed: string[] = [];
    const connector: OmpMcpConnector = async (name) => {
      observed.push(name);
      return new FakeConnection(
        [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
        { content: [] },
      );
    };
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({
        env: { PASEO_AGENT_ID: "agent-1", PASEO_WORKSPACE_ID: "workspace-1" },
        mcpServers: {
          PASEO: { type: "stdio", command: "external-paseo" },
          "paseo!": { type: "stdio", command: "external-paseo-2" },
          paseo: {
            type: "http",
            url: "http://127.0.0.1:4567/mcp/agents?callerAgentId=agent-1",
          },
        },
      }),
      { connectMcp: connector },
    );
    const runtime = new FakeRuntime();
    await bridge.bind(runtime as unknown as OmpRuntimeSession);
    const names = runtime.catalogs[0]?.map(({ name }) => name) ?? [];

    expect(observed[0]).toBe("paseo");
    expect(names.filter((name) => name.startsWith("mcp__paseo_"))).toEqual(["mcp__paseo_read"]);
    expect(new Set(names).size).toBe(3);
    expect(names.slice(1).every((name) => name.startsWith("mcp__external_paseo_"))).toBe(true);
    await bridge.close();
  });

  test("bounds MCP titles and generated fallback labels to the OMP schema", async () => {
    const connection = new FakeConnection(
      [
        { name: "titled", title: "😀".repeat(200), inputSchema: { type: "object" } },
        { name: "fallback", inputSchema: { type: "object" } },
      ],
      { content: [] },
    );
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({
        mcpServers: { ["server".repeat(80)]: { type: "stdio", command: "server" } },
      }),
      { connectMcp: async () => connection },
    );
    const runtime = new FakeRuntime();
    await bridge.bind(runtime as unknown as OmpRuntimeSession);

    for (const definition of runtime.catalogs[0] ?? []) {
      expect(Buffer.byteLength(definition.label ?? "", "utf8")).toBeLessThanOrEqual(256);
      expect(definition.label?.length).toBeGreaterThan(0);
    }
    await bridge.close();
  });

  test("fails closed when exact MCP preapproval cannot be represented", async () => {
    let connections = 0;
    const connector: OmpMcpConnector = async () => {
      connections += 1;
      return new FakeConnection([], { content: [] });
    };
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({
          mcpServers: { repo: { type: "stdio", command: "repo-mcp" } },
          toolPolicy: { preapproved: [{ kind: "mcp", server: "repo", tool: "read" }] },
        }),
        { connectMcp: connector },
      ),
    ).rejects.toThrow("cannot preserve exact MCP preapproval");
    expect(connections).toBe(0);
  });

  test("fails closed on missing caller workspace identity", async () => {
    const connector: OmpMcpConnector = async () => new FakeConnection([], { content: [] });
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({
          env: { PASEO_AGENT_ID: "agent-1" },
          mcpServers: {
            paseo: {
              type: "http",
              url: "http://127.0.0.1:4567/mcp/agents?callerAgentId=agent-1",
            },
          },
        }),
        { connectMcp: connector },
      ),
    ).rejects.toThrow("caller agent and workspace identity");
  });

  test("aborts bounded initialization and cleans admitted and late connections", async () => {
    const first = new FakeConnection([], { content: [] });
    const late = new FakeConnection([], { content: [] });
    const lateConnection = Promise.withResolvers<OmpMcpConnection>();
    const signals: AbortSignal[] = [];
    const connector: OmpMcpConnector = async (name, _config, _cwd, signal) => {
      signals.push(signal);
      if (name === "first") return first;
      return await lateConnection.promise;
    };
    const opening = OmpHostToolsBridge.open(
      sessionConfig({
        mcpServers: {
          first: { type: "stdio", command: "first" },
          second: { type: "stdio", command: "second" },
        },
      }),
      { connectMcp: connector, initializationTimeoutMs: 5 },
    );

    await expect(opening).rejects.toThrow("initialization cleanup pending");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(first.closes).toBe(1);
    lateConnection.resolve(late);
    await flushMicrotasks();
    expect(late.closes).toBe(1);
  });

  test("caps admitted calls and bytes, releases canceled slots, and ignores stale settlement", async () => {
    const connection = new FakeConnection(
      [{ name: "read", inputSchema: { type: "object" } }],
      { content: [] },
      async (_name, _input, options) => {
        const deferred = Promise.withResolvers<unknown>();
        options.signal.addEventListener("abort", () => deferred.reject(new Error("cancelled")), {
          once: true,
        });
        return await deferred.promise;
      },
    );
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({ mcpServers: { repo: { type: "stdio", command: "repo" } } }),
      { connectMcp: async () => connection },
    );
    const runtime = new FakeRuntime();
    await bridge.bind(runtime as unknown as OmpRuntimeSession);

    for (let index = 0; index < 64; index += 1) {
      bridge.handle({
        type: "host_tool_call",
        id: `call-${index}`,
        toolCallId: `tool-${index}`,
        toolName: "mcp__repo_read",
        arguments: { key: `first-${index}` },
      });
    }
    bridge.handle({
      type: "host_tool_call",
      id: "saturated",
      toolCallId: "tool-saturated",
      toolName: "mcp__repo_read",
      arguments: { key: "saturated" },
    });
    expect(connection.calls).toHaveLength(64);
    expect(runtime.results.at(-1)).toEqual(
      expect.objectContaining({ id: "saturated", isError: true }),
    );

    bridge.handle({ type: "host_tool_cancel", id: "cancel-1", targetId: "call-0" });
    bridge.handle({
      type: "host_tool_call",
      id: "call-0",
      toolCallId: "tool-reused",
      toolName: "mcp__repo_read",
      arguments: { key: "replacement" },
    });
    await flushMicrotasks();
    const replacement = connection.calls.at(-1);
    expect(replacement?.input).toEqual({ key: "replacement" });
    expect(replacement?.signal.aborted).toBe(false);
    bridge.handle({ type: "host_tool_cancel", id: "cancel-2", targetId: "call-0" });
    expect(replacement?.signal.aborted).toBe(true);
    expect(runtime.results.some(({ id }) => id === "call-0")).toBe(false);

    bridge.handle({
      type: "host_tool_call",
      id: "oversized",
      toolCallId: "tool-oversized",
      toolName: "mcp__repo_read",
      arguments: { payload: "x".repeat(8 * 1024 * 1024) },
    });
    expect(runtime.results.at(-1)).toEqual(
      expect.objectContaining({ id: "oversized", isError: true }),
    );
    await bridge.close();
  });

  test("rejects excessive server counts before classification or connection", async () => {
    let connections = 0;
    const mcpServers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        `server-${index}`,
        { type: "stdio" as const, command: "server" },
      ]),
    );
    await expect(
      OmpHostToolsBridge.open(sessionConfig({ mcpServers }), {
        connectMcp: async () => {
          connections += 1;
          return new FakeConnection([], { content: [] });
        },
      }),
    ).rejects.toThrow("server count exceeds");
    expect(connections).toBe(0);
  });

  test("follows bounded tool pages and rejects repeated cursors", async () => {
    const cursors: Array<string | undefined> = [];
    const connection: OmpMcpConnection = {
      async listTools({ cursor }) {
        cursors.push(cursor);
        if (!cursor) {
          return {
            tools: [{ name: "one", inputSchema: { type: "object" } }],
            nextCursor: "page-2",
          };
        }
        return { tools: [{ name: "two", inputSchema: { type: "object" } }] };
      },
      async callTool() {
        return { content: [] };
      },
      async close() {},
    };
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({ mcpServers: { repo: { type: "stdio", command: "repo" } } }),
      { connectMcp: async () => connection },
    );
    const runtime = new FakeRuntime();
    await bridge.bind(runtime as unknown as OmpRuntimeSession);
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(runtime.catalogs[0]?.map(({ name }) => name)).toEqual([
      "mcp__repo_one",
      "mcp__repo_two",
    ]);
    await bridge.close();

    const repeated = new FakeConnection([], { content: [] });
    repeated.listTools = async () => ({ tools: [], nextCursor: "same" });
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({ mcpServers: { repeated: { type: "stdio", command: "repeat" } } }),
        { connectMcp: async () => repeated },
      ),
    ).rejects.toThrow("repeated a tool-list cursor");
    expect(repeated.closes).toBe(1);
  });

  test("rejects per-server tool overflow and aggregate catalogs before OMP transport", async () => {
    const overflow = new FakeConnection([], { content: [] });
    let page = 0;
    overflow.listTools = async () => {
      page += 1;
      return {
        tools: Array.from({ length: page === 1 ? 256 : 1 }, (_, index) => ({
          name: `tool-${page}-${index}`,
          inputSchema: { type: "object" },
        })),
        ...(page === 1 ? { nextCursor: "overflow" } : {}),
      };
    };
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({ mcpServers: { overflow: { type: "stdio", command: "overflow" } } }),
        { connectMcp: async () => overflow },
      ),
    ).rejects.toThrow("tool count exceeds");
    expect(overflow.closes).toBe(1);

    const largeCatalog = new FakeConnection(
      Array.from({ length: 14 }, (_, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(60 * 1024),
        inputSchema: { type: "object" },
      })),
      { content: [] },
    );
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({ mcpServers: { large: { type: "stdio", command: "large" } } }),
        { connectMcp: async () => largeCatalog },
      ),
    ).rejects.toThrow("catalog exceeds the RPC frame limit");
    expect(largeCatalog.closes).toBe(1);
  });

  test("preserves Windows and WSL workspace paths at the host connector boundary", async () => {
    const observed: string[] = [];
    const connector: OmpMcpConnector = async (_name, _config, cwd) => {
      observed.push(cwd);
      return new FakeConnection([], { content: [] });
    };
    for (const cwd of ["C:\\Users\\agent\\repo", "/mnt/c/Users/agent/repo"]) {
      const bridge = await OmpHostToolsBridge.open(
        sessionConfig({ cwd, mcpServers: { local: { type: "stdio", command: "server" } } }),
        { connectMcp: connector },
      );
      await bridge.close();
    }
    expect(observed).toEqual(["C:\\Users\\agent\\repo", "/mnt/c/Users/agent/repo"]);
  });

  test("invalidates and drains when terminal result delivery saturates the RPC writer", async () => {
    const connection = new FakeConnection([{ name: "read", inputSchema: { type: "object" } }], {
      content: [{ type: "text", text: "done" }],
    });
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({ mcpServers: { repo: { type: "stdio", command: "repo" } } }),
      { connectMcp: async () => connection },
    );
    const saturated = new FakeRuntime();
    saturated.throwResults = true;
    const failed = Promise.withResolvers<Error>();
    bridge.onFatal(failed.resolve);
    await bridge.bind(saturated as unknown as OmpRuntimeSession);
    bridge.handle({
      type: "host_tool_call",
      id: "saturated-result",
      toolCallId: "tool-saturated-result",
      toolName: "mcp__repo_read",
      arguments: {},
    });
    await expect(failed.promise).resolves.toEqual(
      expect.objectContaining({ message: "OMP RPC has too many pending writes" }),
    );

    const recovered = new FakeRuntime();
    bridge.onFatal(() => {});
    await bridge.bind(recovered as unknown as OmpRuntimeSession);
    bridge.handle({
      type: "host_tool_call",
      id: "after-drain",
      toolCallId: "tool-after-drain",
      toolName: "mcp__repo_read",
      arguments: {},
    });
    await flushMicrotasks();
    expect(recovered.results).toEqual([
      expect.objectContaining({ type: "host_tool_result", id: "after-drain" }),
    ]);
    await bridge.close();
  });

  test("keeps failed close ownership and rejects a mismatched OMP catalog", async () => {
    const connection = new FakeConnection(
      [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      { content: [] },
    );
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({ mcpServers: { repo: { type: "stdio", command: "repo-mcp" } } }),
      { connectMcp: async () => connection },
    );
    const runtime = new FakeRuntime();
    runtime.acceptedNames = [];
    await expect(bridge.bind(runtime as unknown as OmpRuntimeSession)).rejects.toThrow(
      "rejected the configured host tool catalog",
    );
    connection.closeError = new Error("close failed");
    await expect(bridge.close()).rejects.toThrow("cleanup failed");
    await expect(bridge.close()).rejects.toThrow("cleanup failed");
    expect(connection.closes).toBe(1);
  });

  test("stamps workspace ownership without trusting caller environment", () => {
    expect(
      withOmpWorkspaceIdentity({
        agentId: "agent-1",
        workspaceId: "workspace-1",
        provider: "omp-plugin",
        cwd: "/workspace",
        reason: "create" as const,
        purpose: "interactive" as const,
        env: { PASEO_WORKSPACE_ID: "spoofed" },
      }).env,
    ).toEqual({ PASEO_AGENT_ID: "agent-1", PASEO_WORKSPACE_ID: "workspace-1" });
    expect(
      withOmpWorkspaceIdentity({
        agentId: "agent-legacy",
        workspaceId: null,
        env: { PASEO_AGENT_ID: "spoofed", PASEO_WORKSPACE_ID: "spoofed" },
      }).env,
    ).toEqual({ PASEO_AGENT_ID: "agent-legacy" });
  });
});
