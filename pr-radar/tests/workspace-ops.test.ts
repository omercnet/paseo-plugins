import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildAgentConfig,
  buildAgentLabels,
  buildAgentPrompt,
  buildIssueRows,
  splitDraftRows,
} from "../client/radar";
import {
  defaultWorktreeName,
  expandUserPath,
  isAbsoluteOrHomePath,
  isValidRepositorySlug,
  isValidWorktreeName,
  parseGitHubRepoFromRemote,
  prepareWorkspaceCwdHandler,
  slugifyBranch,
} from "../server/workspace-ops";
import { DEFAULT_PR_RADAR_SETTINGS, PrRadarSettingsSchema } from "../shared/settings";
import { RoutingScriptResultSchema } from "../shared/viewer-scope";

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
    expect(defaultWorktreeName("owner/repo", 42, "", "issue")).toBe("repo-issue-42");
    expect(slugifyBranch("Fix/Weird__Branch!!Name")).toBe("fix-weird-branch-name");
  });

  test("expands tilde paths", () => {
    expect(expandUserPath("~/src").endsWith("/src")).toBe(true);
  });

  test("parses owner/repo from git remotes exactly (prevents substring collisions)", () => {
    expect(parseGitHubRepoFromRemote("https://github.com/omercnet/paseo.git")).toBe(
      "omercnet/paseo",
    );
    expect(parseGitHubRepoFromRemote("git@github.com:omercnet/paseo-plugins.git")).toBe(
      "omercnet/paseo-plugins",
    );
    expect(parseGitHubRepoFromRemote("https://github.com/omercnet/paseo-plugins.git")).not.toBe(
      "omercnet/paseo",
    );
  });

  test("validates repository slugs, worktree names, and target paths", () => {
    expect(isValidRepositorySlug("omercnet/paseo-plugins")).toBe(true);
    expect(isValidRepositorySlug("bad/../repo")).toBe(false);
    expect(isValidRepositorySlug("-flag/repo")).toBe(false);
    expect(isValidRepositorySlug("owner/-repo")).toBe(false);
    expect(isValidWorktreeName("paseo-pr-123-fix")).toBe(true);
    expect(isValidWorktreeName("../../escape")).toBe(false);
    expect(isValidWorktreeName("-branch")).toBe(false);
    expect(isAbsoluteOrHomePath("~/src/repo")).toBe(true);
    expect(isAbsoluteOrHomePath("/tmp/repo")).toBe(true);
    expect(isAbsoluteOrHomePath("pas")).toBe(false);
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

  test("buildAgentLabels adds accepted labels and keeps pr-radar.cwd authoritative", () => {
    expect(buildAgentLabels("CWD-BASE")).toEqual({ "pr-radar.cwd": "CWD-BASE" });
    expect(
      buildAgentLabels("CWD-WORKTREE", {
        "ade.kind": "external-review",
        "pr-radar.cwd": "CWD-BASE",
      }),
    ).toEqual({ "ade.kind": "external-review", "pr-radar.cwd": "CWD-WORKTREE" });
  });

  test("a malformed routed labels value survives parsing so launch validation can block it", () => {
    const parsed = RoutingScriptResultSchema.parse({ model: "m", labels: { a: 1 } });
    expect(parsed.model).toBe("m");
    expect(parsed.labels).toEqual({ a: 1 });
    expect(RoutingScriptResultSchema.parse({ labels: { a: "b" } }).labels).toEqual({ a: "b" });
    expect(RoutingScriptResultSchema.parse({ labels: "x" }).labels).toBe("x");
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

describe("issues support", () => {
  test("buildIssueRows maps GitHubIssueItem and detects local checkout", () => {
    const rows = buildIssueRows(
      {
        rows: [],
        warnings: [],
        workspaceCount: 1,
        refreshedAt: "2026-11-10T00:00:00Z",
        repositoryRoots: { "owner/my-repo": "/tmp/my-repo" },
      },
      [
        {
          id: "owner/my-repo#12",
          repository: "owner/my-repo",
          number: 12,
          url: "https://github.com/owner/my-repo/issues/12",
          title: "Fix crash",
          author: "alice",
          authorKind: "human",
          comments: 3,
          labels: ["bug"],
          isSecurity: false,
          createdAt: "2026-11-10T00:00:00Z",
          updatedAt: "2026-11-10T00:00:00Z",
          role: "assignee",
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].itemKind).toBe("issue");
    expect(rows[0].issueRole).toBe("assignee");
    expect(rows[0].hasLocalPlace).toBe(true);
    expect(rows[0].localProjectRoot).toBe("/tmp/my-repo");
    expect(rows[0].cwdTag).toBe("CWD-TBD");
    expect(buildAgentPrompt(rows[0])).toContain(
      "GitHub issue https://github.com/owner/my-repo/issues/12",
    );
  });

  test("puts an issue with only a failed agent in needs-you", () => {
    const rows = buildIssueRows(
      {
        rows: [],
        warnings: [],
        workspaceCount: 1,
        refreshedAt: "2026-11-10T00:00:00Z",
        repositoryRoots: {},
        issueMatches: {
          "owner/my-repo#issue-12": {
            agents: [
              {
                id: "agent-1",
                title: "Fix crash",
                status: "error",
                requiresAttention: false,
                attentionReason: null,
                pendingPermissions: 0,
                updatedAt: "2026-11-10T00:00:00Z",
              },
            ],
            workspaceIds: ["workspace-1"],
            workspaceNames: ["Fix crash"],
            cwdTag: "CWD-TBD",
          },
        },
      },
      [
        {
          id: "owner/my-repo#12",
          repository: "owner/my-repo",
          number: 12,
          url: "https://github.com/owner/my-repo/issues/12",
          title: "Fix crash",
          author: "alice",
          authorKind: "human",
          comments: 3,
          labels: ["bug"],
          isSecurity: false,
          createdAt: "2026-11-10T00:00:00Z",
          updatedAt: "2026-11-10T00:00:00Z",
          role: "owner",
        },
      ],
    );
    expect(rows[0].bucket).toBe("needs-you");
    expect(rows[0].reason).toBe("Open in your repository");
  });
});

function settingsFor(sourceCodeDir: string) {
  return async () => ({ sourceCodeDir, routingScriptPath: "" });
}

describe("prepareWorkspaceCwdHandler git safety", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeGitRepo(root: string, remoteUrl: string): string {
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_NOSYSTEM = "1";
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe", env });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);
    git(["remote", "add", "origin", remoteUrl]);
    return repoDir;
  }

  test("rejects missing targetDir when allowClone is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-radar-ops-"));
    tempDirs.push(root);
    await expect(
      prepareWorkspaceCwdHandler(
        {
          itemKind: "pr",
          repository: "owner/repo",
          prNumber: 7,
          headRefName: "main",
          baseRefName: "main",
          targetDir: join(root, "missing"),
          allowClone: false,
          cwdMode: "CWD-WORKTREE",
          worktreeName: null,
        },
        settingsFor(root),
      ),
    ).rejects.toThrow("Directory does not exist");
  });

  test("rejects targetDir matching a different repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-radar-ops-"));
    tempDirs.push(root);
    const repoDir = makeGitRepo(root, "https://github.com/omercnet/paseo-plugins.git");
    await expect(
      prepareWorkspaceCwdHandler(
        {
          itemKind: "pr",
          repository: "omercnet/paseo",
          prNumber: 7,
          headRefName: "main",
          baseRefName: "main",
          targetDir: repoDir,
          allowClone: false,
          cwdMode: "CWD-WORKTREE",
          worktreeName: null,
        },
        settingsFor(root),
      ),
    ).rejects.toThrow("does not match repository omercnet/paseo");
  });

  test("rejects CWD-BASE when tracked working tree has uncommitted changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-radar-ops-"));
    tempDirs.push(root);
    const repoDir = makeGitRepo(root, "https://github.com/owner/repo.git");
    writeFileSync(join(repoDir, "README.md"), "dirty\n");
    await expect(
      prepareWorkspaceCwdHandler(
        {
          itemKind: "pr",
          repository: "owner/repo",
          prNumber: 7,
          headRefName: "main",
          baseRefName: "main",
          targetDir: repoDir,
          allowClone: false,
          cwdMode: "CWD-BASE",
          worktreeName: null,
        },
        settingsFor(root),
      ),
    ).rejects.toThrow("uncommitted or untracked changes");
  });

  test("rejects a picked subdirectory whose git root is outside the source directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-radar-ops-"));
    tempDirs.push(root);
    const repoDir = makeGitRepo(root, "https://github.com/owner/repo.git");
    const nestedSource = join(repoDir, "nested-source");
    const pickedDir = join(nestedSource, "picked");
    mkdirSync(pickedDir, { recursive: true });
    await expect(
      prepareWorkspaceCwdHandler(
        {
          itemKind: "issue",
          repository: "owner/repo",
          prNumber: 7,
          headRefName: "Issue title",
          baseRefName: "main",
          targetDir: pickedDir,
          allowClone: false,
          cwdMode: "CWD-BASE",
          worktreeName: null,
        },
        settingsFor(nestedSource),
      ),
    ).rejects.toThrow("Git worktree root");
  });

  test("rejects reusing an unrelated folder with the same worktree name", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-radar-ops-"));
    tempDirs.push(root);
    const repoDir = makeGitRepo(root, "https://github.com/owner/repo.git");
    const collidingFolder = join(root, "repo-pr-7-main");
    mkdirSync(collidingFolder, { recursive: true });
    await expect(
      prepareWorkspaceCwdHandler(
        {
          itemKind: "pr",
          repository: "owner/repo",
          prNumber: 7,
          headRefName: "main",
          baseRefName: "main",
          targetDir: repoDir,
          allowClone: false,
          cwdMode: "CWD-WORKTREE",
          worktreeName: "repo-pr-7-main",
        },
        settingsFor(root),
      ),
    ).rejects.toThrow("not a worktree of owner/repo on branch pr-radar/pr-7");
  });
});
