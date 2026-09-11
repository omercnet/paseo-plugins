import { describe, expect, test } from "bun:test";
import { buildWslClientCommand } from "../scripts/host-tools-integration";

describe("host-tool integration scripts", () => {
  test("builds an executable WSL cd and env command", () => {
    const command = buildWslClientCommand({
      wslPluginRoot: "/mnt/c/repo path/paseo-omp",
      hostUrl: "http://172.20.0.1:4567/mcp/agents?callerAgentId=wsl-agent",
      expectedHostCwd: "C:\\repo path\\paseo-omp",
      expectedHostPid: 1234,
      callerAgentId: "wsl-agent",
      workspaceId: "wsl-workspace",
      expectedOwnerMarker: "windows-host",
      wslBun: "~/.bun/bin/bun",
    });

    expect(command).toStartWith("cd '/mnt/c/repo path/paseo-omp' && env ");
    expect(command).toContain("PASEO_AGENT_ID='wsl-agent'");
    expect(command).toContain("PASEO_WORKSPACE_ID='wsl-workspace'");
    expect(command).not.toContain("EXPECTED_WORKSPACE_ID");
    expect(command).toEndWith("~/.bun/bin/bun tests/fixtures/mcp-container-client.ts");
  });
});
