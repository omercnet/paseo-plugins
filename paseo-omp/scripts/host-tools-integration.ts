import { join } from "node:path";

export const pluginRoot = join(import.meta.dirname, "..");

export interface HostMcpServer {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
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
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<{ pid: number; port: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
      ]);
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });
      const match = /MCP_HOST_READY\s+(\d+)\s+(\d+)/u.exec(buffered);
      if (match) return { port: Number(match[1]), pid: Number(match[2]) };
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Host MCP server did not become ready: ${buffered}`);
}

export async function startHostMcpServer(ownerMarker: string): Promise<HostMcpServer> {
  const child = Bun.spawn(["bun", "tests/fixtures/mcp-host-server.ts"], {
    cwd: pluginRoot,
    env: { ...process.env, MCP_HOST_PORT: "0", OWNER_MARKER: ownerMarker },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const ready = await readReady(child.stdout, 10_000);
    return { child, ...ready };
  } catch (error) {
    child.kill("SIGKILL");
    const stderr = await new Response(child.stderr).text();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
}

export async function stopHostMcpServer(server: HostMcpServer): Promise<void> {
  server.child.kill("SIGTERM");
  const exited = await Promise.race([
    server.child.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited) {
    server.child.kill("SIGKILL");
    await server.child.exited;
  }
}

export async function runCaptured(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? pluginRoot,
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
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
  expectedCallerAgentId: string;
  expectedWorkspaceId: string;
  expectedOwnerMarker: string;
  wslBun: string;
}): string {
  if (!/^[A-Za-z0-9_./~$-]+$/u.test(input.wslBun)) {
    throw new Error("WSL Bun path contains unsupported shell characters");
  }
  const environment = [
    `MCP_HOST_URL=${shellQuote(input.hostUrl)}`,
    `EXPECTED_HOST_CWD=${shellQuote(input.expectedHostCwd)}`,
    `EXPECTED_HOST_PID=${input.expectedHostPid}`,
    `EXPECTED_CALLER_AGENT_ID=${shellQuote(input.expectedCallerAgentId)}`,
    `EXPECTED_WORKSPACE_ID=${shellQuote(input.expectedWorkspaceId)}`,
    `EXPECTED_OWNER_MARKER=${shellQuote(input.expectedOwnerMarker)}`,
  ].join(" ");
  return `cd ${shellQuote(input.wslPluginRoot)} && env ${environment} ${input.wslBun} tests/fixtures/mcp-container-client.ts`;
}
