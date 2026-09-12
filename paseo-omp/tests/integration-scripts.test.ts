import { describe, expect, test } from "vitest";
import {
  buildWslClientCommand,
  parseEvidence,
  runCaptured,
  startHostMcpServer,
  stopHostMcpServer,
} from "../scripts/host-tools-integration";

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
      wslNode: "node",
      wslClientEntry: "dist/mcp-wsl-client.mjs",
    });

    expect(command.startsWith("cd '/mnt/c/repo path/paseo-omp' && env ")).toBe(true);
    expect(command).toContain("PASEO_AGENT_ID='wsl-agent'");
    expect(command).toContain("PASEO_WORKSPACE_ID='wsl-workspace'");
    expect(command).not.toContain("EXPECTED_WORKSPACE_ID");
    expect(command.endsWith("node 'dist/mcp-wsl-client.mjs'")).toBe(true);
  });

  test("starts and stops the host MCP process with observable ownership", async () => {
    const server = await startHostMcpServer("coverage-host");
    try {
      expect(server.pid).toBeGreaterThan(0);
      expect(server.port).toBeGreaterThan(0);
      const response = await fetch(
        `http://127.0.0.1:${server.port}/mcp/agents?callerAgentId=docker-agent`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
        },
      );
      const payload = (await response.json()) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(payload.result.content[0]?.text ?? "{}")).toEqual(
        expect.objectContaining({ ownerMarker: "coverage-host", ownerPid: server.pid }),
      );
    } finally {
      await stopHostMcpServer(server);
    }
    expect(server.child.signalCode).toBe("SIGTERM");
  });

  test("captures successful commands and reports failed commands", async () => {
    await expect(
      runCaptured([process.execPath, "-e", "console.log('captured-output')"]),
    ).resolves.toBe("captured-output");
    await expect(
      runCaptured([process.execPath, "-e", "console.error('captured-error'); process.exit(7)"]),
    ).rejects.toThrow(/failed \(7\).*captured-error/su);
  });

  test("parses the final ownership evidence and rejects malformed output", () => {
    expect(
      parseEvidence(
        `noise\n${JSON.stringify({
          callerAgentId: "agent-1",
          workspaceId: "workspace-1",
          ownerMarker: "host",
          ownerPid: 42,
          ownerCwd: "/workspace",
        })}`,
      ),
    ).toEqual({
      callerAgentId: "agent-1",
      workspaceId: "workspace-1",
      ownerMarker: "host",
      ownerPid: 42,
      ownerCwd: "/workspace",
    });
    expect(() => parseEvidence("no json here")).toThrow("Ownership evidence was not emitted");
    expect(() => parseEvidence('{"callerAgentId":1}')).toThrow("Ownership evidence is malformed");
    expect(() =>
      buildWslClientCommand({
        wslPluginRoot: "/repo",
        hostUrl: "http://host/mcp",
        expectedHostCwd: "/repo",
        expectedHostPid: 1,
        callerAgentId: "agent",
        workspaceId: "workspace",
        expectedOwnerMarker: "host",
        wslNode: "node;rm",
        wslClientEntry: "dist/mcp-wsl-client.mjs",
      }),
    ).toThrow("WSL Node path contains unsupported shell characters");
  });
});
