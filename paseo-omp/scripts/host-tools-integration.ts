import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const pluginRoot = join(import.meta.dirname, "..");

export interface HostMcpServer {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  port: number;
}

export interface OwnershipEvidence {
  callerAgentId: string;
  workspaceId: string;
  ownerMarker: string;
  ownerPid: number;
  ownerCwd: string;
}

async function readReady(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<{ pid: number; port: number }> {
  let buffered = "";
  const reading = (async () => {
    for await (const chunk of stream) {
      buffered += Buffer.from(chunk).toString("utf8");
      const match = /MCP_HOST_READY\s+(\d+)\s+(\d+)/u.exec(buffered);
      if (match) return { port: Number(match[1]), pid: Number(match[2]) };
    }
    throw new Error(`Host MCP server exited before readiness: ${buffered}`);
  })();
  return Promise.race([
    reading,
    sleep(timeoutMs).then(() => {
      throw new Error(`Host MCP server did not become ready: ${buffered}`);
    }),
  ]);
}

export async function startHostMcpServer(ownerMarker: string): Promise<HostMcpServer> {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/mcp-host-server.ts"], {
    cwd: pluginRoot,
    env: { ...process.env, MCP_HOST_PORT: "0", OWNER_MARKER: ownerMarker },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const ready = await readReady(child.stdout, 10_000);
    return { child, ...ready };
  } catch (error) {
    child.kill("SIGKILL");
    let stderr = "";
    for await (const chunk of child.stderr) stderr += Buffer.from(chunk).toString("utf8");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
}

export async function stopHostMcpServer(server: HostMcpServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const exited = await Promise.race([
    once(server.child, "exit").then(() => true),
    sleep(5_000, false),
  ]);
  if (!exited) {
    server.child.kill("SIGKILL");
    await once(server.child, "exit");
  }
}

export async function runCaptured(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const [file, ...args] = command;
  if (!file) throw new Error("Command must not be empty");
  try {
    const { stdout } = await executeFile(file, args, {
      cwd: options.cwd ?? pluginRoot,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    throw new Error(
      `${command.join(" ")} failed (${String(failure.code ?? "unknown")})\n${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`,
    );
  }
}

export function parseEvidence(output: string): OwnershipEvidence {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate.startsWith("{"));
  if (!line) throw new Error(`Ownership evidence was not emitted: ${output}`);
  const evidence = JSON.parse(line) as Partial<OwnershipEvidence>;
  if (
    typeof evidence.callerAgentId !== "string" ||
    typeof evidence.workspaceId !== "string" ||
    typeof evidence.ownerMarker !== "string" ||
    typeof evidence.ownerPid !== "number" ||
    typeof evidence.ownerCwd !== "string"
  ) {
    throw new Error(`Ownership evidence is malformed: ${line}`);
  }
  return evidence as OwnershipEvidence;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildWslClientCommand(input: {
  wslPluginRoot: string;
  hostUrl: string;
  expectedHostCwd: string;
  expectedHostPid: number;
  callerAgentId: string;
  workspaceId: string;
  expectedOwnerMarker: string;
  wslNode: string;
}): string {
  if (!/^[A-Za-z0-9_./~$-]+$/u.test(input.wslNode)) {
    throw new Error("WSL Node path contains unsupported shell characters");
  }
  const environment = [
    `MCP_HOST_URL=${shellQuote(input.hostUrl)}`,
    `EXPECTED_HOST_CWD=${shellQuote(input.expectedHostCwd)}`,
    `EXPECTED_HOST_PID=${input.expectedHostPid}`,
    `PASEO_AGENT_ID=${shellQuote(input.callerAgentId)}`,
    `PASEO_WORKSPACE_ID=${shellQuote(input.workspaceId)}`,
    `EXPECTED_OWNER_MARKER=${shellQuote(input.expectedOwnerMarker)}`,
  ].join(" ");
  return `cd ${shellQuote(input.wslPluginRoot)} && env ${environment} ${input.wslNode} --import tsx tests/fixtures/mcp-container-client.ts`;
}
