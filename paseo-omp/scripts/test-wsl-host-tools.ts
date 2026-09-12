import {
  buildWslClientCommand,
  parseEvidence,
  pluginRoot,
  runCaptured,
  shellQuote,
  startHostMcpServer,
  stopHostMcpServer,
} from "./host-tools-integration";

const required = process.env.PASEO_OMP_REQUIRE_WSL === "1";
if (process.platform !== "win32") {
  if (required) throw new Error("Windows is required for the WSL host-tool integration");
  console.log("SKIP WSL host-tool integration: Windows is unavailable");
  process.exit(0);
}

try {
  await runCaptured(["where.exe", "wsl.exe"]);
} catch (error) {
  if (required) throw error;
  console.log("SKIP WSL host-tool integration: wsl.exe is unavailable");
  process.exit(0);
}

const wslNode = process.env.PASEO_OMP_WSL_NODE ?? "node";
try {
  await runCaptured(["wsl.exe", "--exec", "sh", "-lc", `command -v ${shellQuote(wslNode)}`]);
} catch (error) {
  if (required) throw error;
  console.log(`SKIP WSL host-tool integration: Node is unavailable in WSL (${String(error)})`);
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
    const command = buildWslClientCommand({
      wslPluginRoot,
      hostUrl: `http://${host}:${server.port}/mcp/agents?callerAgentId=${callerAgentId}`,
      expectedHostCwd: pluginRoot,
      expectedHostPid: server.pid,
      callerAgentId,
      workspaceId,
      expectedOwnerMarker: ownerMarker,
      wslNode,
    });
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
