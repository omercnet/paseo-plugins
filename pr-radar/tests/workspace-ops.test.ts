import { describe, expect, test } from "vitest";
import { buildAgentConfig, splitDraftRows } from "../client/radar";
import { defaultWorktreeName, expandUserPath, slugifyBranch } from "../server/workspace-ops";
import { DEFAULT_PR_RADAR_SETTINGS, PrRadarSettingsSchema } from "../shared/settings";

describe("settings schema", () => {
  test("provides defaults when empty object is parsed", () => {
    const parsed = PrRadarSettingsSchema.parse({});
    expect(parsed).toEqual(DEFAULT_PR_RADAR_SETTINGS);
  });

  test("accepts autoLaunchMode and defaultCwdMode options", () => {
    const parsed = PrRadarSettingsSchema.parse({
      sourceCodeDir: "~/code",
      defaultCwdMode: "CWD-BASE",
      autoLaunchMode: "existing_or_clone",
      defaultProvider: "codex",
      defaultModel: "gpt-6.1-sol",
      defaultEffort: "high",
      defaultModeId: "bypassPermissions",
      defaultContextMode: "full",
      routingScriptPath: "~/bin/route.py",
    });
    expect(parsed.defaultCwdMode).toBe("CWD-BASE");
    expect(parsed.autoLaunchMode).toBe("existing_or_clone");
    expect(parsed.defaultProvider).toBe("codex");
  });
});

describe("workspace ops helpers", () => {
  test("builds human-readable worktree names", () => {
    expect(defaultWorktreeName("firecrawl/firecrawl", 5135, "feat/ssrf-proxy-port")).toBe(
      "firecrawl-pr-5135-feat-ssrf-proxy-port",
    );
    expect(slugifyBranch("Fix/Weird__Branch!!Name")).toBe("fix-weird-branch-name");
  });

  test("expands tilde paths", () => {
    expect(expandUserPath("~/src").endsWith("/src")).toBe(true);
  });
});

describe("agent config & draft splitting", () => {
  test("buildAgentConfig merges profile and overrides", () => {
    const config = buildAgentConfig(
      { provider: "claude", model: "sonnet", modeId: "default", thinkingOptionId: "medium" },
      { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "high", contextMode: "full" },
    );
    expect(config).toEqual({
      provider: "codex/gpt-6.1-sol",
      modeId: "default",
      thinkingOptionId: "high",
      options: { contextMode: "full" },
    });
  });

  test("splitDraftRows separates regular PRs and DPRs", () => {
    const base = {
      number: 1,
      url: "https://github.com/a/b/pull/1",
      title: "T",
      repository: "a/b",
      baseRefName: "main",
      headRefName: "feat",
      author: "u",
      authorKind: "human" as const,
      isSecurity: false,
      comments: 0,
      labels: [],
      changes: [],
      linkedIssues: [],
      cwdTag: "CWD-TBD" as const,
      hasLocalPlace: false,
      mergeable: "MERGEABLE" as const,
      mergeStateStatus: "CLEAN",
      checksStatus: "success" as const,
      reviewDecision: "approved" as const,
      checks: [],
      workspaceIds: [],
      workspaceNames: [],
      localProjectRoot: null,
      agents: [],
      ownership: "mine" as const,
      reviewRequestedFromMe: false,
      bucket: "ready" as const,
      reason: "Ready",
      activityAt: null,
      refreshedAt: null,
    };
    const { pullRequests, draftPullRequests } = splitDraftRows([
      { ...base, id: "1", isDraft: true },
      { ...base, id: "2", isDraft: false },
    ]);
    expect(pullRequests.map((r) => r.id)).toEqual(["2"]);
    expect(draftPullRequests.map((r) => r.id)).toEqual(["1"]);
  });
});
