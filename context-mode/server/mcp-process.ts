import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { LaunchDescriptor } from "./binary";

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
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  terminationGraceMs?: number;
}

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpToolArguments = Readonly<Record<string, McpJsonValue>>;

export type ContextModeToolName =
  | "ctx_doctor"
  | "ctx_stats"
  | "ctx_upgrade"
  | "ctx_search"
  | "ctx_index"
  | "ctx_fetch_and_index"
  | "ctx_purge";

export const CONTEXT_MODE_TOOL_TIMEOUT_MS: Readonly<Record<ContextModeToolName, number>> = {
  ctx_doctor: 15_000,
  ctx_stats: 15_000,
  ctx_search: 20_000,
  ctx_index: 120_000,
  ctx_fetch_and_index: 45_000,
  ctx_purge: 120_000,
  ctx_upgrade: 120_000,
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function safeMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  return String(value);
}

function extractToolOutput(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new ProcessFailure("protocol-error", "Context Mode returned an invalid tool result.");
  }
  const value = result as {
    content?: Array<{ type?: string; text?: unknown }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = value.content
    ?.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const output =
    text && text.trim().length > 0
      ? text
      : value.structuredContent === undefined
        ? ""
        : JSON.stringify(value.structuredContent, null, 2);
  if (value.isError) {
    throw new ProcessFailure("command-failed", output || "Context Mode reported a tool error.");
  }
  return output;
}

async function exchange(
  launch: LaunchDescriptor,
  operation:
    | { kind: "inspect" }
    | { kind: "tool"; name: ContextModeToolName; arguments: McpToolArguments },
  dependencies: McpProcessDependencies,
): Promise<McpInspection | string> {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const timeoutMs =
    dependencies.timeoutMs ??
    (operation.kind === "tool" ? CONTEXT_MODE_TOOL_TIMEOUT_MS[operation.name] : PROCESS_TIMEOUT_MS);
  const terminationGraceMs = dependencies.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
  const outputLimit = dependencies.outputLimit ?? PROCESS_OUTPUT_LIMIT;

  const { promise, resolve, reject } = Promise.withResolvers<McpInspection | string>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(launch.program, launch.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: dependencies.cwd,
      env: dependencies.env ? { ...process.env, ...dependencies.env } : undefined,
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
  let version: string | null = null;

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
        response = JSON.parse(line) as JsonRpcResponse;
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
        const result = response.result as { serverInfo?: { version?: unknown } } | undefined;
        version =
          typeof result?.serverInfo?.version === "string" ? result.serverInfo.version : null;
        writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
        writeMessage(
          operation.kind === "inspect"
            ? { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
            : {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: operation.name, arguments: operation.arguments },
              },
        );
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
      if (operation.kind === "inspect") {
        const result = response.result as { tools?: Array<{ name?: unknown }> } | undefined;
        const tools = (result?.tools ?? [])
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === "string");
        finish(() => resolve({ version, tools }));
        return;
      }
      try {
        const output = extractToolOutput(response.result);
        finish(() => resolve(output));
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

export async function inspectContextMode(
  launch: LaunchDescriptor,
  dependencies: McpProcessDependencies = {},
): Promise<McpInspection> {
  return (await exchange(launch, { kind: "inspect" }, dependencies)) as McpInspection;
}

export async function callContextModeTool(
  launch: LaunchDescriptor,
  name: ContextModeToolName,
  arguments_: McpToolArguments = {},
  dependencies: McpProcessDependencies = {},
): Promise<string> {
  return (await exchange(
    launch,
    { kind: "tool", name, arguments: arguments_ },
    dependencies,
  )) as string;
}
