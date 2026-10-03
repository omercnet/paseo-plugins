import { describe, expect, test, vi } from "vitest";
import {
  knowledgeProvider,
  parseScreenParams,
  resolveKnowledgeScope,
} from "../client/screen-scope";

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
  test("maps only exact RPC providers, never named/custom aliases", () => {
    for (const provider of [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "opencode",
      "pi",
      "omp",
      "omp-plugin",
    ])
      expect(knowledgeProvider(provider)).toBe(provider);
    for (const provider of ["claude-work", "omp-plugin-work", "custom", "claude/model", "Claude"])
      expect(knowledgeProvider(provider)).toBeNull();
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
    refresh.mockResolvedValue({
      agent: { provider: "codex-work", cwd: "/selected-host/project", workspaceId: "w" },
    });
    expect(
      await resolveKnowledgeScope(paseo as never, { section: "knowledge", agentId: "a" }),
    ).toMatchObject({
      provider: null,
      projectPath: "/selected-host/project",
      note: expect.stringContaining("Select one explicitly"),
    });
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
});
