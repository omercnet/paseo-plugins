import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { z } from "zod";
import { type ContextModePlatform, PANEL_PLATFORM } from "../shared/providers";
import { type LaunchDescriptor, readContextModeVersion } from "./binary";

export const PROCESS_OUTPUT_LIMIT = 192 * 1_024;
export const PROCESS_TIMEOUT_MS = 12_000;
export const PROCESS_TERMINATION_GRACE_MS = 500;
const MCP_PROTOCOL_VERSION = "2025-06-18";

export type ProcessFailureCode =
  | "timeout"
  | "output-limit"
  | "launch-failed"
  | "protocol-error"
  | "unsupported"
  | "command-failed";

export class ProcessFailure extends Error {
  constructor(
    readonly code: ProcessFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessFailure";
  }
}

export interface McpInspection {
  version: string | null;
  tools: string[];
}

export interface McpProcessDependencies {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  outputLimit?: number;
  terminationGraceMs?: number;
  readVersion?: (launch: LaunchDescriptor) => Promise<string | null>;
}

/** `--agent` label, project cwd (Context Mode keys its store by cwd) and optional data dir. */
export interface ContextModeProcessOptions {
  platform: ContextModePlatform;
  cwd?: string;
  dataDir?: string;
}

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpToolArguments = Readonly<Record<string, McpJsonValue>>;

export const CONTEXT_MODE_TOOL_TIMEOUT_MS = {
  ctx_index: 120_000,
  ctx_search: 20_000,
  ctx_resume: 20_000,
  ctx_doctor: 30_000,
  ctx_purge: 120_000,
} as const;

/** The tools the plugin calls; a runtime missing any of them (Context Mode 1.x) is unsupported. */
export type ContextModeToolName = keyof typeof CONTEXT_MODE_TOOL_TIMEOUT_MS;

/** Every plugin-initiated call shares this journal session, so it never shows up as agent work. */
export const PLUGIN_SESSION_ID = "paseo-context-mode";

const CORE_TOOLS = Object.keys(CONTEXT_MODE_TOOL_TIMEOUT_MS);

const DEFAULT_OPTIONS: ContextModeProcessOptions = { platform: PANEL_PLATFORM };

/** Command line that runs the stdio MCP server for one agent. */
export function serverArgs(
  launch: LaunchDescriptor,
  platform: ContextModePlatform,
): { command: string; args: string[] } {
  return { command: launch.program, args: [...launch.args, "server", "--agent", platform] };
}

const JsonRpcResponseSchema = z.looseObject({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

interface McpRequest {
  method: "tools/list" | "tools/call";
  params: Record<string, McpJsonValue>;
}

function safeMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  return String(value);
}

const ToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string().optional(), text: z.unknown() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

function extractToolOutput(result: unknown): string {
  const parsed = ToolResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new ProcessFailure("protocol-error", "Context Mode returned an invalid tool result.");
  }
  const { content = [], structuredContent, isError } = parsed.data;
  const text = content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
  let output = text;
  if (text.trim().length === 0) {
    output = structuredContent === undefined ? "" : JSON.stringify(structuredContent, null, 2);
  }
  if (isError) {
    throw new ProcessFailure("command-failed", output || "Context Mode reported a tool error.");
  }
  return output;
}

/** One MCP session: initialize, send `request`, and parse its result. */
async function exchange<T>(
  launch: LaunchDescriptor,
  request: McpRequest,
  parseResult: (result: unknown) => T,
  defaultTimeoutMs: number,
  dependencies: McpProcessDependencies,
  options: ContextModeProcessOptions,
): Promise<T> {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  const terminationGraceMs = dependencies.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
  const outputLimit = dependencies.outputLimit ?? PROCESS_OUTPUT_LIMIT;

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const { command, args } = serverArgs(launch, options.platform);
  const env = {
    ...launch.env,
    ...(options.dataDir ? { CONTEXT_MODE_DATA_DIR: options.dataDir } : {}),
    // Claude Code resolves its project from this variable before cwd.
    ...(options.platform === "claude-code" && options.cwd
      ? { CLAUDE_PROJECT_DIR: options.cwd }
      : {}),
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: options.cwd,
      env: Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined,
    });
  } catch (error) {
    throw new ProcessFailure(
      "launch-failed",
      `Could not launch Context Mode: ${safeMessage(error)}`,
    );
  }

  let settled = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lineBuffer = "";
  let stderr = "";

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    child.stdin.removeAllListeners("error");
    child.stdin.on("error", () => {});

    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      clearTimeout(graceTimer);
      child.stdin.destroy();
      callback();
    };
    const graceTimer = setTimeout(() => {
      child.kill("SIGKILL");
      complete();
    }, terminationGraceMs);
    child.once("exit", complete);

    if (child.exitCode != null || child.signalCode != null) {
      complete();
      return;
    }
    try {
      if (!child.stdin.destroyed) child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      child.kill("SIGKILL");
      complete();
    }
  };
  const fail = (failure: ProcessFailure) => finish(() => reject(failure));
  const writeMessage = (message: unknown) => {
    if (settled) return;
    if (child.stdin.destroyed || !child.stdin.writable) {
      fail(new ProcessFailure("protocol-error", "Context Mode closed its protocol input."));
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          fail(
            new ProcessFailure(
              "protocol-error",
              `Context Mode protocol write failed: ${safeMessage(error)}`,
            ),
          );
        }
      });
    } catch (error) {
      fail(
        new ProcessFailure(
          "protocol-error",
          `Context Mode protocol write failed: ${safeMessage(error)}`,
        ),
      );
    }
  };
  const timer = setTimeout(
    () =>
      fail(new ProcessFailure("timeout", `Context Mode did not respond within ${timeoutMs} ms.`)),
    timeoutMs,
  );

  child.stdin.on("error", (error) => {
    fail(
      new ProcessFailure(
        "protocol-error",
        `Context Mode protocol input failed: ${safeMessage(error)}`,
      ),
    );
  });

  child.once("error", (error) => {
    fail(
      new ProcessFailure("launch-failed", `Could not launch Context Mode: ${safeMessage(error)}`),
    );
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    const detail = stderr.trim() || `exit ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
    fail(new ProcessFailure("command-failed", `Context Mode stopped before replying: ${detail}`));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > outputLimit) {
      fail(
        new ProcessFailure(
          "output-limit",
          `Context Mode exceeded the ${outputLimit}-byte output limit.`,
        ),
      );
      return;
    }
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > outputLimit) {
      fail(
        new ProcessFailure(
          "output-limit",
          `Context Mode exceeded the ${outputLimit}-byte output limit.`,
        ),
      );
      return;
    }
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse;
      try {
        response = JsonRpcResponseSchema.parse(JSON.parse(line));
      } catch {
        fail(
          new ProcessFailure("protocol-error", "Context Mode emitted invalid MCP protocol output."),
        );
        return;
      }
      if (response.id === 1) {
        if (response.error) {
          fail(
            new ProcessFailure(
              "protocol-error",
              response.error.message ?? "Context Mode initialization failed.",
            ),
          );
          return;
        }
        writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
        writeMessage({ jsonrpc: "2.0", id: 2, ...request });
        continue;
      }
      if (response.id !== 2) continue;
      if (response.error) {
        const message = response.error.message ?? "Context Mode rejected the request.";
        const unsupported =
          response.error.code === -32601 || /unknown|not found|unsupported/i.test(message);
        fail(new ProcessFailure(unsupported ? "unsupported" : "command-failed", message));
        return;
      }
      try {
        const value = parseResult(response.result);
        finish(() => resolve(value));
      } catch (error) {
        fail(
          error instanceof ProcessFailure
            ? error
            : new ProcessFailure("protocol-error", safeMessage(error)),
        );
      }
      return;
    }
  });

  writeMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "paseo-context-mode", version: "0.0.0" },
    },
  });
  return await promise;
}

const ToolListSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })).default([]),
});

function extractToolNames(result: unknown): string[] {
  const parsed = ToolListSchema.safeParse(result ?? {});
  if (!parsed.success) {
    throw new ProcessFailure("protocol-error", "Context Mode returned an invalid tool list.");
  }
  return parsed.data.tools.map(({ name }) => name);
}

export async function inspectContextMode(
  launch: LaunchDescriptor,
  dependencies: McpProcessDependencies = {},
  options: ContextModeProcessOptions = DEFAULT_OPTIONS,
): Promise<McpInspection> {
  const [tools, version] = await Promise.all([
    exchange(
      launch,
      { method: "tools/list", params: {} },
      extractToolNames,
      PROCESS_TIMEOUT_MS,
      dependencies,
      options,
    ),
    (dependencies.readVersion ?? readContextModeVersion)(launch),
  ]);
  const missing = CORE_TOOLS.filter((tool) => !tools.includes(tool));
  if (missing.length > 0) {
    const doctorOnly = tools.length === 1 && tools[0] === "ctx_doctor";
    const reason = doctorOnly
      ? "Context Mode needs Node.js 24.15 or later with node:sqlite; run ctx_doctor for details."
      : "Context Mode 2.x is required; clear the configured binary path to use the bundled runtime.";
    throw new ProcessFailure(
      "unsupported",
      `Context Mode ${version ?? "(unknown version)"} lacks ${missing.join(", ")}. ${reason}`,
    );
  }
  return { version, tools };
}

export async function callContextModeTool(
  launch: LaunchDescriptor,
  name: ContextModeToolName,
  arguments_: McpToolArguments,
  dependencies: McpProcessDependencies,
  options: ContextModeProcessOptions,
): Promise<string> {
  return exchange(
    launch,
    {
      method: "tools/call",
      params: { name, arguments: arguments_, _meta: { sessionId: PLUGIN_SESSION_ID } },
    },
    extractToolOutput,
    CONTEXT_MODE_TOOL_TIMEOUT_MS[name],
    dependencies,
    options,
  );
}
