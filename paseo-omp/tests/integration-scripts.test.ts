import { describe, expect, test } from "bun:test";
import { buildWslClientCommand } from "../scripts/host-tools-integration";

describe("host-tool integration scripts", () => {
  test("builds an executable WSL cd and env command", () => {
    const command = buildWslClientCommand({
      wslPluginRoot: "/mnt/c/repo path/paseo-omp",
      hostUrl: "http://172.20.0.1:4567/mcp/agents?callerAgentId=wsl-agent",
      expectedHostCwd: "C:\\repo path\\paseo-omp",
      expectedHostPid: 1234,
      expectedCallerAgentId: "wsl-agent",
      expectedWorkspaceId: "wsl-workspace",
      expectedOwnerMarker: "windows-host",
      wslBun: "~/.bun/bin/bun",
    });

    expect(command).toStartWith("cd '/mnt/c/repo path/paseo-omp' && env ");
    expect(command).toContain("EXPECTED_CALLER_AGENT_ID='wsl-agent'");
    expect(command).toContain("EXPECTED_WORKSPACE_ID='wsl-workspace'");
    expect(command).toEndWith("~/.bun/bin/bun tests/fixtures/mcp-container-client.ts");
  });
});
