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

class FakeRuntime
  implements Pick<OmpRuntimeSession, "setHostTools" | "sendHostToolResult" | "sendHostToolUpdate">
{
  catalogs: OmpHostToolDefinition[][] = [];
  results: OmpHostToolResult[] = [];
  updates: OmpHostToolUpdate[] = [];
  acceptedNames: string[] | null = null;

  setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]> {
    this.catalogs.push(structuredClone([...tools]));
    return Promise.resolve(this.acceptedNames ?? tools.map(({ name }) => name));
  }

  sendHostToolResult(result: OmpHostToolResult): void {
    this.results.push(structuredClone(result));
  }

  sendHostToolUpdate(update: OmpHostToolUpdate): void {
    this.updates.push(structuredClone(update));
  }
}
class FakeConnection implements OmpMcpConnection {
  readonly calls: Array<{ name: string; input: Record<string, unknown>; signal: AbortSignal }> = [];
  closes = 0;

  constructor(
    private readonly tools: readonly OmpMcpTool[],
    private readonly result: unknown,
  ) {}

  listTools() {
    return Promise.resolve(this.tools);
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; onProgress: (progress: unknown) => void },
  ) {
    this.calls.push({ name, input, signal: options.signal });
    options.onProgress({ progress: 1, total: 2 });
    return this.result;
  }

  async close() {
    this.closes += 1;
  }
}

describe("OMP host tool bridge", () => {
  test("maps caller-scoped Paseo and configured MCP tools through set_host_tools", async () => {
    const paseo = new FakeConnection(
      [
        {
          name: "read",
          title: "Read workspace file",
          description: "Read from the caller workspace",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      { content: [{ type: "text", text: "workspace result" }], structuredContent: { ok: true } },
    );
    const repo = new FakeConnection(
      [
        {
          name: "repo-search",
          description: "Search repository",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      { content: [{ type: "text", text: "match" }] },
    );
    const observed: Array<{ name: string; cwd: string; config: unknown }> = [];
    const connector: OmpMcpConnector = async (name, config, cwd) => {
      observed.push({ name, config, cwd });
      return name === "paseo" ? paseo : repo;
    };
    const config = sessionConfig({
      env: { PASEO_AGENT_ID: "agent-1", PASEO_WORKSPACE_ID: "workspace-1" },
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:4567/mcp/agents?callerAgentId=agent-1",
          headers: { Authorization: "Bearer capability" },
        },
        repo: { type: "stdio", command: "repo-mcp", args: ["serve"], alwaysLoad: false },
      },
    });

    const bridge = await OmpHostToolsBridge.open(config, connector);
    const runtime = new FakeRuntime();
    await bridge.bind(runtime as unknown as OmpRuntimeSession);

    expect(observed).toEqual([
      { name: "paseo", config: config.mcpServers.paseo, cwd: "/workspace" },
      { name: "repo", config: config.mcpServers.repo, cwd: "/workspace" },
    ]);
    expect(runtime.catalogs[0]).toEqual([
      expect.objectContaining({ name: "mcp__paseo_read", loadMode: "essential" }),
      expect.objectContaining({ name: "mcp__repo_search", loadMode: "discoverable" }),
    ]);

    bridge.handle({
      type: "host_tool_call",
      id: "call-1",
      toolCallId: "tool-call-1",
      toolName: "mcp__paseo_read",
      arguments: { path: "README.md" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(paseo.calls).toHaveLength(1);
    expect(paseo.calls[0]).toEqual(
      expect.objectContaining({ name: "read", input: { path: "README.md" } }),
    );
    expect(runtime.updates).toEqual([
      expect.objectContaining({
        type: "host_tool_update",
        id: "call-1",
        partialResult: expect.objectContaining({ details: { progress: 1, total: 2 } }),
      }),
    ]);
    expect(runtime.results).toEqual([
      {
        type: "host_tool_result",
        id: "call-1",
        result: {
          content: [{ type: "text", text: "workspace result" }],
          details: { ok: true },
        },
      },
    ]);

    await bridge.close();
    expect(paseo.closes).toBe(1);
    expect(repo.closes).toBe(1);
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
        connector,
      ),
    ).rejects.toThrow("cannot preserve exact MCP preapproval");
    expect(connections).toBe(0);
  });

  test("fails closed on missing or mismatched caller workspace identity", async () => {
    const connector: OmpMcpConnector = async () => new FakeConnection([], { content: [] });
    const paseoServer = {
      paseo: {
        type: "http" as const,
        url: "http://127.0.0.1:4567/mcp/agents?callerAgentId=agent-1",
      },
    };
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({ env: { PASEO_AGENT_ID: "agent-1" }, mcpServers: paseoServer }),
        connector,
      ),
    ).rejects.toThrow("caller agent and workspace identity");
    await expect(
      OmpHostToolsBridge.open(
        sessionConfig({
          env: { PASEO_AGENT_ID: "agent-2", PASEO_WORKSPACE_ID: "workspace-1" },
          mcpServers: paseoServer,
        }),
        connector,
      ),
    ).rejects.toThrow("caller identity does not match");
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
    ).toEqual({ PASEO_WORKSPACE_ID: "workspace-1" });
    expect(
      withOmpWorkspaceIdentity({ workspaceId: null, env: { PASEO_WORKSPACE_ID: "spoofed" } }).env,
    ).toEqual({});
  });

  test("closes MCP ownership when OMP rejects the host catalog", async () => {
    const connection = new FakeConnection(
      [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      { content: [] },
    );
    const bridge = await OmpHostToolsBridge.open(
      sessionConfig({ mcpServers: { repo: { type: "stdio", command: "repo-mcp" } } }),
      async () => connection,
    );
    const runtime = new FakeRuntime();
    runtime.acceptedNames = [];
    await expect(bridge.bind(runtime as unknown as OmpRuntimeSession)).rejects.toThrow(
      "rejected the configured host tool catalog",
    );
    await bridge.close();
    expect(connection.closes).toBe(1);
  });
});
