import { createHash } from "node:crypto";
import type {
  ProviderMcpServerConfig,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OmpHostToolCall,
  OmpHostToolDefinition,
  OmpHostToolResult,
  OmpRuntimeSession,
} from "./omp-rpc";
import { boundedJsonBytes, OmpCleanupFailure, OmpPublicError, utf8Bytes } from "./security";

const INTERNAL_PASEO_MCP_PATH = "/mcp/agents";
const MAX_HOST_TOOLS = 256;
const MAX_HOST_TOOL_NAME_BYTES = 256;
const MAX_HOST_TOOL_DESCRIPTION_BYTES = 64 * 1024;
const MAX_HOST_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_HOST_TOOL_RESULT_BYTES = 12 * 1024 * 1024;
export interface OmpMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface OmpMcpConnection {
  listTools(): Promise<readonly OmpMcpTool[]>;
  callTool(
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; onProgress: (progress: unknown) => void },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type OmpMcpConnector = (
  name: string,
  config: ProviderMcpServerConfig,
  cwd: string,
) => Promise<OmpMcpConnection>;

type ToolTarget = {
  toolName: string;
  connection: OmpMcpConnection;
};

type PendingCall = {
  controller: AbortController;
  runtime: OmpRuntimeSession;
};

function safeName(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || fallback;
}

function exposedToolName(serverName: string, toolName: string): string {
  const server = safeName(serverName, "server");
  const tool = safeName(toolName, "tool");
  const unprefixed = tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool;
  const base = `mcp__${server}_${unprefixed}`;
  if (utf8Bytes(base) <= MAX_HOST_TOOL_NAME_BYTES) return base;
  const digest = createHash("sha256")
    .update(`${serverName}\0${toolName}`)
    .digest("hex")
    .slice(0, 12);
  return `${base.slice(0, MAX_HOST_TOOL_NAME_BYTES - digest.length - 1)}_${digest}`;
}

function isInternalPaseoServer(config: ProviderMcpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") return false;
  try {
    return new URL(config.url).pathname === INTERNAL_PASEO_MCP_PATH;
  } catch {
    return false;
  }
}

function validateCallerIdentity(config: ProviderSessionConfig): void {
  const internalServers = Object.values(config.mcpServers).filter(isInternalPaseoServer);
  if (internalServers.length === 0) return;
  const callerAgentId = config.env.PASEO_AGENT_ID?.trim();
  const workspaceId = config.env.PASEO_WORKSPACE_ID?.trim();
  if (!callerAgentId || !workspaceId) {
    throw new OmpPublicError(
      "Paseo host tools require caller agent and workspace identity from the plugin host",
    );
  }
  for (const server of internalServers) {
    if (server.type !== "http" && server.type !== "sse") continue;
    let configuredCaller: string | null;
    try {
      configuredCaller = new URL(server.url).searchParams.get("callerAgentId");
    } catch {
      configuredCaller = null;
    }
    if (configuredCaller !== callerAgentId) {
      throw new OmpPublicError(
        "Paseo host tool caller identity does not match the provider session",
      );
    }
  }
}

function validateToolPolicy(config: ProviderSessionConfig): void {
  if ((config.toolPolicy?.preapproved.length ?? 0) === 0) return;
  throw new OmpPublicError(
    "OMP set_host_tools cannot preserve exact MCP preapproval; refusing to broaden access",
  );
}

function normalizeResult(result: unknown): OmpHostToolResult["result"] {
  if (
    !result ||
    typeof result !== "object" ||
    boundedJsonBytes(
      result,
      MAX_HOST_TOOL_RESULT_BYTES,
      1_024,
      MAX_HOST_TOOL_RESULT_BYTES,
      4_096,
    ) === Number.POSITIVE_INFINITY
  ) {
    throw new Error("MCP tool returned an invalid or oversized result");
  }
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return {
      content: record.content as OmpHostToolResult["result"]["content"],
      ...(record.structuredContent !== undefined ? { details: record.structuredContent } : {}),
      ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    };
  }
  if (Object.hasOwn(record, "toolResult")) {
    return {
      content: [{ type: "text", text: "MCP tool completed" }],
      details: record.toolResult,
    };
  }
  throw new Error("MCP tool returned an unsupported result");
}

function errorResult(id: string, error: unknown): OmpHostToolResult {
  return {
    type: "host_tool_result",
    id,
    result: {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: {},
      isError: true,
    },
    isError: true,
  };
}

// MCP transports stay in the plugin-server host. OMP receives only schemas and call frames, so
// filesystem and terminal ownership never migrates into a WSL/container OMP child by accident.
async function defaultConnectMcp(
  _name: string,
  config: ProviderMcpServerConfig,
  cwd: string,
): Promise<OmpMcpConnection> {
  const client = new Client({ name: "paseo-omp-provider", version: "1.0.0" });
  const requestInit = config.type === "stdio" ? undefined : { headers: config.headers };
  const transport =
    config.type === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd,
          stderr: "ignore",
        })
      : config.type === "http"
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit })
        : new SSEClientTransport(new URL(config.url), { requestInit });
  await client.connect(transport);
  return {
    async listTools() {
      return (await client.listTools()).tools;
    },
    async callTool(name, input, options) {
      return await client.callTool({ name, arguments: input }, undefined, {
        signal: options.signal,
        onprogress: (progress) => options.onProgress(progress),
        resetTimeoutOnProgress: true,
      });
    },
    async close() {
      await client.close();
    },
  };
}

export class OmpHostToolsBridge {
  private runtime: OmpRuntimeSession | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  private constructor(
    private readonly connections: readonly OmpMcpConnection[],
    private readonly definitions: readonly OmpHostToolDefinition[],
    private readonly targets: ReadonlyMap<string, ToolTarget>,
  ) {}

  static async open(
    config: ProviderSessionConfig,
    connectMcp: OmpMcpConnector = defaultConnectMcp,
  ): Promise<OmpHostToolsBridge> {
    validateToolPolicy(config);
    validateCallerIdentity(config);
    const connections: OmpMcpConnection[] = [];
    const definitions: OmpHostToolDefinition[] = [];
    const targets = new Map<string, ToolTarget>();
    try {
      for (const [serverName, serverConfig] of Object.entries(config.mcpServers).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const connection = await connectMcp(serverName, serverConfig, config.cwd);
        connections.push(connection);
        const tools = [...(await connection.listTools())].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const tool of tools) {
          if (
            !tool.name ||
            utf8Bytes(tool.name) > MAX_HOST_TOOL_NAME_BYTES ||
            utf8Bytes(tool.description ?? "") > MAX_HOST_TOOL_DESCRIPTION_BYTES ||
            boundedJsonBytes(tool.inputSchema, MAX_HOST_TOOL_SCHEMA_BYTES) ===
              Number.POSITIVE_INFINITY
          ) {
            throw new Error("MCP server exposed an invalid host tool definition");
          }
          if (definitions.length >= MAX_HOST_TOOLS) {
            throw new Error("MCP servers exposed too many host tools");
          }
          let name = exposedToolName(serverName, tool.name);
          if (targets.has(name)) {
            const digest = createHash("sha256")
              .update(`${serverName}\0${tool.name}`)
              .digest("hex")
              .slice(0, 12);
            name = `${name.slice(0, MAX_HOST_TOOL_NAME_BYTES - digest.length - 1)}_${digest}`;
          }
          if (targets.has(name)) throw new Error("MCP host tool names collide");
          const essential = isInternalPaseoServer(serverConfig) || serverConfig.alwaysLoad === true;
          definitions.push({
            name,
            label: tool.title ?? `${serverName}/${tool.name}`,
            description: tool.description ?? `MCP tool from ${serverName}`,
            loadMode: essential ? "essential" : "discoverable",
            parameters: tool.inputSchema,
          });
          targets.set(name, { toolName: tool.name, connection });
        }
      }
      return new OmpHostToolsBridge(connections, definitions, targets);
    } catch {
      const cleanup = Promise.all(connections.map((connection) => connection.close())).then(
        () => undefined,
      );
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure(
          "OMP MCP host tool cleanup failed",
          cleanup.catch(() => undefined),
        );
      }
      throw new OmpPublicError("OMP could not initialize configured MCP host tools");
    }
  }

  async bind(runtime: OmpRuntimeSession): Promise<void> {
    if (this.closed) throw new Error("OMP host tool bridge is closed");
    this.detach();
    const accepted = await runtime.setHostTools([...this.definitions]);
    const expected = this.definitions.map(({ name }) => name);
    const uniqueAccepted = new Set(accepted);
    if (
      accepted.length !== expected.length ||
      uniqueAccepted.size !== accepted.length ||
      expected.some((name) => !uniqueAccepted.has(name))
    ) {
      throw new OmpPublicError("OMP rejected the configured host tool catalog");
    }
    this.runtime = runtime;
  }

  handle(
    event: OmpHostToolCall | { type: "host_tool_cancel"; id: string; targetId: string },
  ): boolean {
    if (event.type === "host_tool_cancel") {
      this.pending.get(event.targetId)?.controller.abort(new Error("OMP host tool call cancelled"));
      return true;
    }
    const runtime = this.runtime;
    if (!runtime) return true;
    const target = this.targets.get(event.toolName);
    if (!target) {
      runtime.sendHostToolResult(errorResult(event.id, "Unknown OMP host tool"));
      return true;
    }
    if (this.pending.has(event.id)) {
      runtime.sendHostToolResult(errorResult(event.id, "Duplicate OMP host tool call"));
      return true;
    }
    const controller = new AbortController();
    this.pending.set(event.id, { controller, runtime });
    void target.connection
      .callTool(target.toolName, event.arguments, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (
            controller.signal.aborted ||
            this.runtime !== runtime ||
            boundedJsonBytes(progress, MAX_HOST_TOOL_RESULT_BYTES) === Number.POSITIVE_INFINITY
          ) {
            return;
          }
          runtime.sendHostToolUpdate({
            type: "host_tool_update",
            id: event.id,
            partialResult: { content: [], details: progress },
          });
        },
      })
      .then((result) => {
        if (controller.signal.aborted || this.runtime !== runtime) return;
        try {
          runtime.sendHostToolResult({
            type: "host_tool_result",
            id: event.id,
            result: normalizeResult(result),
          });
        } catch {
          runtime.sendHostToolResult(errorResult(event.id, "MCP host tool execution failed"));
        }
      })
      .catch(() => {
        if (controller.signal.aborted || this.runtime !== runtime) return;
        runtime.sendHostToolResult(errorResult(event.id, "MCP host tool execution failed"));
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(event.id));
    return true;
  }

  detach(): void {
    this.runtime = null;
    for (const pending of this.pending.values()) {
      pending.controller.abort(new Error("OMP runtime detached"));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    const results = await Promise.allSettled(
      this.connections.map((connection) => connection.close()),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("OMP MCP host tool cleanup failed");
    }
  }
}

export function withOmpWorkspaceIdentity<
  T extends { workspaceId: string | null; env: Record<string, string> },
>(request: T): Omit<T, "env"> & { env: Record<string, string> } {
  const env = { ...request.env };
  if (request.workspaceId) env.PASEO_WORKSPACE_ID = request.workspaceId;
  else delete env.PASEO_WORKSPACE_ID;
  return { ...request, env };
}
