import {
  parseEvidence,
  pluginRoot,
  runCaptured,
  startHostMcpServer,
  stopHostMcpServer,
} from "./host-tools-integration";

const image = process.env.PASEO_OMP_DOCKER_IMAGE ?? "node:22.22.1-bookworm-slim";
const callerAgentId = "docker-agent";
const workspaceId = "docker-workspace";
const ownerMarker = "host-daemon";
const server = await startHostMcpServer(ownerMarker);
try {
  const output = await runCaptured([
    "docker",
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${pluginRoot}:/work`,
    "-w",
    "/work",
    "-e",
    `MCP_HOST_URL=http://host.docker.internal:${server.port}/mcp/agents?callerAgentId=${callerAgentId}`,
    "-e",
    `EXPECTED_HOST_CWD=${pluginRoot}`,
    "-e",
    `EXPECTED_HOST_PID=${server.pid}`,
    "-e",
    `PASEO_AGENT_ID=${callerAgentId}`,
    "-e",
    `PASEO_WORKSPACE_ID=${workspaceId}`,
    "-e",
    `EXPECTED_OWNER_MARKER=${ownerMarker}`,
    image,
    "node",
    "--import",
    "tsx",
    "tests/fixtures/mcp-container-client.ts",
  ]);
  const evidence = parseEvidence(output);
  if (
    evidence.ownerPid !== server.pid ||
    evidence.ownerCwd !== pluginRoot ||
    evidence.callerAgentId !== callerAgentId ||
    evidence.workspaceId !== workspaceId ||
    evidence.ownerMarker !== ownerMarker
  ) {
    throw new Error(`Docker ownership evidence mismatch: ${JSON.stringify(evidence)}`);
  }
  console.log(`Docker host-tool boundary verified: ${JSON.stringify(evidence)}`);
} finally {
  await stopHostMcpServer(server);
}
