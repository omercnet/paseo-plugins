import {
  parseEvidence,
  pluginRoot,
  runCaptured,
  shellQuote,
  startHostMcpServer,
  stopHostMcpServer,
} from "./host-tools-integration";

const required = process.env.PASEO_OMP_REQUIRE_WSL === "1";
if (!Bun.which("wsl.exe")) {
  if (required) throw new Error("wsl.exe is required for the WSL host-tool integration");
  console.log("SKIP WSL host-tool integration: wsl.exe is unavailable");
  process.exit(0);
}

const wslBun = process.env.PASEO_OMP_WSL_BUN ?? "$HOME/.bun/bin/bun";
try {
  await runCaptured(["wsl.exe", "--exec", "sh", "-lc", `test -x ${wslBun}`]);
} catch (error) {
  if (required) throw error;
  console.log(`SKIP WSL host-tool integration: Bun is unavailable in WSL (${String(error)})`);
  process.exit(0);
}

const wslPluginRoot = await runCaptured([
  "wsl.exe",
  "--exec",
  "sh",
  "-lc",
  `wslpath -a ${shellQuote(pluginRoot)}`,
]);
const gateway = await runCaptured([
  "wsl.exe",
  "--exec",
  "sh",
  "-lc",
  "ip route show default 2>/dev/null | awk 'NR == 1 { print $3 }' || true",
]);
const hostCandidates = [...new Set([gateway, "127.0.0.1"].filter(Boolean))];
const callerAgentId = "wsl-agent";
const workspaceId = "wsl-workspace";
const ownerMarker = "windows-host";
const server = await startHostMcpServer(ownerMarker);
try {
  const failures: unknown[] = [];
  let verified = false;
  for (const host of hostCandidates) {
    const command = [
      `cd ${shellQuote(wslPluginRoot)}`,
      `MCP_HOST_URL=${shellQuote(`http://${host}:${server.port}/mcp/agents?callerAgentId=${callerAgentId}`)}`,
      `EXPECTED_HOST_CWD=${shellQuote(pluginRoot)}`,
      `EXPECTED_HOST_PID=${server.pid}`,
      `EXPECTED_CALLER_AGENT_ID=${callerAgentId}`,
      `EXPECTED_WORKSPACE_ID=${workspaceId}`,
      `EXPECTED_OWNER_MARKER=${ownerMarker}`,
      wslBun,
      "tests/fixtures/mcp-container-client.ts",
    ].join(" ");
    try {
      const output = await runCaptured(["wsl.exe", "--exec", "sh", "-lc", command]);
      const evidence = parseEvidence(output);
      if (
        evidence.ownerPid !== server.pid ||
        evidence.ownerCwd !== pluginRoot ||
        evidence.callerAgentId !== callerAgentId ||
        evidence.workspaceId !== workspaceId ||
        evidence.ownerMarker !== ownerMarker
      ) {
        throw new Error(`WSL ownership evidence mismatch: ${JSON.stringify(evidence)}`);
      }
      console.log(`WSL host-tool boundary verified: ${JSON.stringify(evidence)}`);
      verified = true;
      break;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!verified) throw new AggregateError(failures, "WSL could not reach the Windows MCP host");
} finally {
  await stopHostMcpServer(server);
}
