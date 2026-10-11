import { describe, expect, test, vi } from "vitest";
import { parseScreenParams, resolveKnowledgeScope } from "../client/screen-scope";

describe("screen scope", () => {
  test("accepts sections and IDs, ignoring URL paths and search text", () => {
    expect(
      parseScreenParams({
        section: "knowledge",
        agentId: "a",
        workspaceId: "w",
        projectPath: "/wrong",
        query: "private",
      }),
    ).toEqual({ section: "knowledge", agentId: "a", workspaceId: "w" });
    expect(parseScreenParams({ section: "unknown", agentId: "" }).section).toBe("savings");
    expect(parseScreenParams({ section: "setup" }).section).toBe("setup");
  });
  test("passes the agent's Paseo provider id through, including configured providers", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ agent: { provider: "claude-work", cwd: "/p", workspaceId: "w" } });
    const paseo = { agents: { ref: vi.fn(() => ({ refresh })) } };
    expect(
      await resolveKnowledgeScope(paseo as never, { section: "knowledge", agentId: "a" }),
    ).toEqual({ provider: "claude-work", projectPath: "/p" });
  });
  test("resolves from the selected host, not caller supplied paths", async () => {
    const refresh = vi.fn().mockResolvedValue({
      agent: { provider: "codex", cwd: "/selected-host/project", workspaceId: "w" },
    });
    const paseo = { agents: { ref: vi.fn(() => ({ refresh })) } };
    expect(
      await resolveKnowledgeScope(paseo as never, {
        section: "knowledge",
        agentId: "a",
        workspaceId: "w",
      }),
    ).toEqual({ provider: "codex", projectPath: "/selected-host/project" });
    refresh.mockResolvedValue(null);
    await expect(
      resolveKnowledgeScope(paseo as never, { section: "knowledge", agentId: "missing" }),
    ).rejects.toThrow("not found on this host");
  });
  test("rejects mismatched workspace and requires provider selection for workspace-only links", async () => {
    const paseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: { workspaceId: "other", provider: "claude", cwd: "/other" },
          }),
        }),
      },
      workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: "/workspace" }) }) },
    };
    await expect(
      resolveKnowledgeScope(paseo as never, {
        section: "knowledge",
        agentId: "a",
        workspaceId: "w",
      }),
    ).rejects.toThrow("no longer belongs");
    expect(
      await resolveKnowledgeScope(paseo as never, { section: "knowledge", workspaceId: "w" }),
    ).toMatchObject({ provider: null, projectPath: "/workspace" });
  });
  test("a workspace-only link to a missing workspace requires explicit selection", async () => {
    const paseo = { workspaces: { ref: () => ({ refresh: async () => null }) } };
    await expect(
      resolveKnowledgeScope(paseo as never, { section: "knowledge", workspaceId: "gone" }),
    ).rejects.toThrow("Workspace not found");
  });
});
