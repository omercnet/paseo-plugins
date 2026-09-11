import { OmpHostToolsBridge } from "../../server/provider/host-tools";
import type {
  OmpHostToolDefinition,
  OmpHostToolResult,
  OmpHostToolUpdate,
  OmpRuntimeSession,
} from "../../server/provider/omp-rpc";

const url = process.env.MCP_HOST_URL;
const expectedHostCwd = process.env.EXPECTED_HOST_CWD;
const expectedHostPid = Number(process.env.EXPECTED_HOST_PID);
if (!url || !expectedHostCwd || !Number.isInteger(expectedHostPid)) {
  throw new Error("MCP_HOST_URL, EXPECTED_HOST_CWD, and EXPECTED_HOST_PID are required");
}

const results: OmpHostToolResult[] = [];
let definitions: readonly OmpHostToolDefinition[] = [];
const runtime = {
  async setHostTools(tools: readonly OmpHostToolDefinition[]) {
    definitions = tools;
    return tools.map(({ name }) => name);
  },
  sendHostToolResult(result: OmpHostToolResult) {
    results.push(result);
  },
  sendHostToolUpdate(_update: OmpHostToolUpdate) {},
} as Pick<OmpRuntimeSession, "setHostTools" | "sendHostToolResult" | "sendHostToolUpdate">;

const bridge = await OmpHostToolsBridge.open({
  cwd: process.cwd(),
  env: { PASEO_AGENT_ID: "docker-agent", PASEO_WORKSPACE_ID: "docker-workspace" },
  mcpServers: { bridge: { type: "http", url } },
  settings: {},
  persist: false,
});
try {
  await bridge.bind(runtime as OmpRuntimeSession);
  if (definitions[0]?.name !== "mcp__paseo_workspace_probe") {
    throw new Error(`Unexpected Docker host tool catalog: ${JSON.stringify(definitions)}`);
  }
  bridge.handle({
    type: "host_tool_call",
    id: "docker-call",
    toolCallId: "docker-tool-call",
    toolName: "mcp__paseo_workspace_probe",
    arguments: { workspaceId: "docker-workspace" },
  });
  const deadline = Date.now() + 5_000;
  while (results.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  const text = results[0]?.result.content[0]?.text;
  if (!text) throw new Error("Docker host tool did not return a result");
  const evidence = JSON.parse(text) as {
    callerAgentId?: string;
    ownerMarker?: string;
    ownerPid?: number;
    ownerCwd?: string;
  };
  if (
    evidence.callerAgentId !== "docker-agent" ||
    evidence.ownerMarker !== "host-daemon" ||
    evidence.ownerPid !== expectedHostPid ||
    evidence.ownerPid === process.pid ||
    evidence.ownerCwd !== expectedHostCwd
  ) {
    throw new Error(`Host/container ownership mismatch: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await bridge.close();
}
