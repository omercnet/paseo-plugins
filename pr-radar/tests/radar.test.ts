import { describe, expect, test } from "bun:test";
import {
  type AgentEntry,
  agentActionFor,
  applyViewerScope,
  buildAgentPrompt,
  buildRadarSnapshot,
  checkSummary,
  classifyRow,
  formatAge,
  hasActiveAgent,
  matchesRow,
  mergeInboxRows,
  type PaseoWorkspace,
  type RadarAgent,
  type RadarRow,
} from "../client/radar";
import type { GitHubInboxItem } from "../shared/viewer-scope";

function agent(overrides: Partial<RadarAgent> = {}): RadarAgent {
  return {
    id: "agent-1",
    title: "Fix checkout",
    status: "idle",
    requiresAttention: false,
    attentionReason: null,
    pendingPermissions: 0,
    updatedAt: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<RadarRow> = {}): RadarRow {
  return {
    id: "getpaseo/paseo#42",
    number: 42,
    url: "https://github.com/getpaseo/paseo/pull/42",
    title: "Fix checkout",
    repository: "getpaseo/paseo",
    baseRefName: "main",
    headRefName: "fix/checkout",
    isDraft: false,
    author: "omercnet",
    authorKind: "human",
    isSecurity: false,
    comments: 0,
    labels: [],
    changes: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksStatus: "success",
    reviewDecision: "approved",
    checks: [{ name: "test", status: "success", url: null }],
    workspaceIds: ["workspace-1"],
    localProjectRoot: "/work/paseo",
    workspaceNames: ["Fix checkout"],
    agents: [agent()],
    ownership: "mine",
    reviewRequestedFromMe: false,
    bucket: "waiting",
    reason: "",
    activityAt: "2026-08-30T09:00:00.000Z",
    refreshedAt: "2026-08-30T09:01:00.000Z",
    ...overrides,
  };
}

function workspace(
  id: string,
  overrides: Partial<PaseoWorkspace["githubRuntime"]> = {},
): PaseoWorkspace {
  return {
    id,
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/work/paseo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: `Workspace ${id}`,
    archivingAt: null,
    status: "done",
    statusEnteredAt: "2026-08-30T09:00:00.000Z",
    activityAt: "2026-08-30T09:00:00.000Z",
    scripts: [],
    githubRuntime: {
      featuresEnabled: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/getpaseo/paseo/pull/42",
        title: "Fix checkout",
        state: "open",
        baseRefName: "main",
        headRefName: "fix/checkout",
        isMerged: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        checksStatus: "success",
        reviewDecision: "approved",
        github: { mergeStateStatus: "CLEAN", isInMergeQueue: false },
      },
      refreshedAt: "2026-08-30T09:01:00.000Z",
      ...overrides,
    },
  } as unknown as PaseoWorkspace;
}

function entry(workspaceId: string, overrides: Record<string, unknown> = {}): AgentEntry {
  return {
    agent: {
      id: `agent-${workspaceId}`,
      provider: "codex",
      cwd: `/work/${workspaceId}`,
      workspaceId,
      title: `Agent ${workspaceId}`,
      status: "idle",
      createdAt: "2026-08-30T08:00:00.000Z",
      updatedAt: "2026-08-30T09:00:00.000Z",
      lastActivityAt: "2026-08-30T09:00:00.000Z",
      pendingPermissions: [],
      requiresAttention: false,
      attentionReason: null,
      labels: {},
      ...overrides,
    },
    project: {
      projectKey: "project-1",
      projectName: "Paseo",
      workspaceName: workspaceId,
      checkout: {
        cwd: `/work/${workspaceId}`,
        isGit: true,
        currentBranch: "fix/checkout",
        remoteUrl: "https://github.com/getpaseo/paseo",
        worktreeRoot: `/work/${workspaceId}`,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: "/work/paseo",
      },
    },
  } as unknown as AgentEntry;
}

describe("PR triage", () => {
  test("identifies only running and initializing agents as active", () => {
    expect(hasActiveAgent([agent({ status: "running" })])).toBe(true);
    expect(hasActiveAgent([agent({ status: "initializing" })])).toBe(true);
    expect(hasActiveAgent([agent({ status: "idle" })])).toBe(false);
    expect(hasActiveAgent([agent({ status: "error" })])).toBe(false);
  });

  test("does not interrupt a running agent for a failing PR", () => {
    expect(
      classifyRow(
        row({
          checksStatus: "failure",
          agents: [agent({ status: "running" })],
        }),
      ),
    ).toEqual({ bucket: "being-handled", reason: "Checks failing; agent working" });
  });

  test("surfaces an unattended failing PR", () => {
    expect(classifyRow(row({ checksStatus: "failure" }))).toEqual({
      bucket: "needs-you",
      reason: "Checks failing",
    });
  });

  test("agent permission requests outrank delivery state", () => {
    expect(
      classifyRow(row({ agents: [agent({ status: "idle", pendingPermissions: 2 })] })),
    ).toEqual({ bucket: "needs-you", reason: "Agent needs 2 permissions" });
  });

  test("a healthy active agent absorbs a failed sibling", () => {
    const failed = agent({ id: "failed", status: "error", attentionReason: "error" });
    const running = agent({ id: "running", status: "running" });
    expect(classifyRow(row({ agents: [failed, running] }))).toEqual({
      bucket: "being-handled",
      reason: "Agent working",
    });
    expect(classifyRow(row({ agents: [failed] }))).toEqual({
      bucket: "needs-you",
      reason: "Agent failed",
    });
  });

  test("finished agents do not override pending CI", () => {
    expect(
      classifyRow(
        row({
          checksStatus: "pending",
          mergeable: "UNKNOWN",
          reviewDecision: null,
          agents: [
            agent({
              status: "idle",
              requiresAttention: true,
              attentionReason: "finished",
            }),
          ],
        }),
      ),
    ).toEqual({ bucket: "waiting", reason: "Checks running" });
  });

  test("generic GitHub blocking without an actionable signal stays waiting", () => {
    expect(
      classifyRow(
        row({
          agents: [],
          checks: [],
          checksStatus: "none",
          mergeStateStatus: "BLOCKED",
          reviewDecision: null,
        }),
      ),
    ).toEqual({ bucket: "waiting", reason: "Waiting on repository requirements" });
  });

  test("requested changes are actionable only for the author", () => {
    expect(
      classifyRow(
        row({
          agents: [],
          ownership: "external",
          reviewDecision: "changes_requested",
        }),
      ),
    ).toEqual({ bucket: "waiting", reason: "Waiting on author changes" });

    expect(
      classifyRow(
        row({
          agents: [],
          ownership: "mine",
          reviewDecision: "changes_requested",
        }),
      ),
    ).toEqual({ bucket: "needs-you", reason: "Changes requested" });
  });

  test("marks only settled mergeable pull requests ready", () => {
    expect(classifyRow(row())).toEqual({
      bucket: "ready",
      reason: "Checks passed; mergeable",
    });
    expect(classifyRow(row({ mergeable: "UNKNOWN" }))).toEqual({
      bucket: "waiting",
      reason: "Mergeability pending",
    });
  });

  test("keeps drafts with active agents in progress", () => {
    expect(classifyRow(row({ isDraft: true, agents: [agent({ status: "running" })] }))).toEqual({
      bucket: "being-handled",
      reason: "Draft; agent working",
    });
  });

  test("external review requests wait for CI before asking for review", () => {
    const external = row({
      agents: [],
      ownership: "external",
      reviewDecision: "pending",
      reviewRequestedFromMe: true,
    });
    expect(classifyRow({ ...external, checksStatus: "pending" })).toEqual({
      bucket: "waiting",
      reason: "Checks running",
    });
    expect(classifyRow({ ...external, checksStatus: "success" })).toEqual({
      bucket: "needs-you",
      reason: "Review requested",
    });
  });

  const auditedRows: Array<{
    id: string;
    overrides: Partial<RadarRow>;
    expected: Pick<RadarRow, "bucket" | "reason">;
  }> = [
    {
      id: "descope/shuni#1184",
      overrides: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "pending" },
      expected: { bucket: "needs-you", reason: "Merge conflict" },
    },
    {
      id: "getpaseo/paseo#1829",
      overrides: {
        agents: [agent({ status: "running" })],
        checksStatus: "none",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
      },
      expected: { bucket: "being-handled", reason: "Agent working" },
    },
    {
      id: "descope-dev/deconnect#73",
      overrides: { agents: [agent({ status: "running" })], reviewDecision: null },
      expected: { bucket: "being-handled", reason: "Agent working" },
    },
    {
      id: "getpaseo/paseo#1824",
      overrides: { checksStatus: "none", mergeStateStatus: "BLOCKED", reviewDecision: null },
      expected: { bucket: "waiting", reason: "Waiting on repository requirements" },
    },
    {
      id: "project-copacetic/copacetic#1686",
      overrides: {
        ownership: "external",
        reviewRequestedFromMe: true,
        checksStatus: "success",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "needs-you", reason: "Review requested" },
    },
    {
      id: "descope/shuni#1336",
      overrides: {
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "waiting", reason: "Waiting on reviewers" },
    },
    {
      id: "descope/shuni#1337",
      overrides: {
        agents: [agent({ status: "running" })],
        checksStatus: "pending",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "waiting", reason: "Checks running" },
    },
    {
      id: "descope/shuni#1335",
      overrides: { mergeStateStatus: "BEHIND", reviewDecision: "pending" },
      expected: { bucket: "waiting", reason: "Waiting on reviewers" },
    },
    {
      id: "descope/backend#2432",
      overrides: {
        checksStatus: "pending",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "waiting", reason: "Checks running" },
    },
    {
      id: "project-copacetic/copacetic#1684",
      overrides: {
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "waiting", reason: "Waiting on reviewers" },
    },
    {
      id: "descope/shuni#1334",
      overrides: { checksStatus: "pending", mergeStateStatus: "BEHIND", reviewDecision: "pending" },
      expected: { bucket: "waiting", reason: "Checks running" },
    },
    {
      id: "descope/backend#2392",
      overrides: { ownership: "external", reviewDecision: "changes_requested" },
      expected: { bucket: "waiting", reason: "Waiting on author changes" },
    },
    {
      id: "project-copacetic/copacetic#1594",
      overrides: {
        checksStatus: "pending",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "pending",
      },
      expected: { bucket: "waiting", reason: "Checks running" },
    },
    {
      id: "tektum/verity-images#416",
      overrides: {
        agents: [agent({ status: "running" })],
        reviewDecision: "changes_requested",
      },
      expected: { bucket: "being-handled", reason: "Changes requested; agent working" },
    },
  ];

  for (const audited of auditedRows) {
    test(`classifies audited row ${audited.id}`, () => {
      expect(classifyRow(row({ agents: [], ...audited.overrides }))).toEqual(audited.expected);
    });
  }
});

describe("agent actions", () => {
  test("asks an existing idle agent for an actionable blocker", () => {
    const value = row({ bucket: "needs-you", reason: "Merge conflict" });
    expect(agentActionFor(value)).toEqual({ kind: "ask", agentId: "agent-1" });
    expect(buildAgentPrompt(value)).toContain("resolve the actionable blocker");
  });

  test("starts an agent when a requested review has no active agent", () => {
    const value = row({
      agents: [],
      bucket: "needs-you",
      ownership: "external",
      reviewRequestedFromMe: true,
      workspaceIds: ["review-workspace"],
    });
    expect(agentActionFor(value)).toEqual({ kind: "start", workspaceId: "review-workspace" });
    expect(buildAgentPrompt(value)).toContain("requesting your review");
  });

  test("creates a PR checkout action for an untracked inbox PR", () => {
    const value = row({
      agents: [],
      bucket: "needs-you",
      workspaceIds: [],
      localProjectRoot: "/work/paseo",
    });
    expect(agentActionFor(value)).toEqual({
      kind: "checkout",
      cwd: "/work/paseo",
      number: 42,
      repository: "getpaseo/paseo",
    });
  });

  test("does not automate non-actionable or permission-wait rows", () => {
    expect(agentActionFor(row({ bucket: "waiting" }))).toBeNull();
    expect(
      agentActionFor(
        row({
          bucket: "needs-you",
          agents: [agent({ pendingPermissions: 1, requiresAttention: true })],
        }),
      ),
    ).toBeNull();
  });
});

describe("GitHub inbox merge", () => {
  test("adds an authored inbox PR without a linked workspace", () => {
    const snapshot = buildRadarSnapshot([], []);
    snapshot.repositoryRoots["example/project"] = "/work/project";
    const item: GitHubInboxItem = {
      id: "PR_9",
      number: 9,
      url: "https://github.com/example/project/pull/9",
      title: "Fix production rollout",
      repository: "example/project",
      author: "omercnet",
      authorKind: "human",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-02T08:00:00.000Z",
      baseRefName: "main",
      headRefName: "fix/rollout",
      isDraft: false,
      isSecurity: false,
      comments: 2,
      labels: [],
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      checksStatus: "failure",
      reviewDecision: "changes_requested",
      role: "author",
      changes: ["Checks: success → failure"],
    };

    const [merged] = mergeInboxRows(snapshot, [item]);
    expect(merged).toMatchObject({
      id: "example/project#9",
      ownership: "mine",
      bucket: "needs-you",
      reason: "Checks failing",
      localProjectRoot: "/work/project",
      changes: ["Checks: success → failure"],
    });
  });

  test("preserves active agents when GitHub refreshes a linked PR", () => {
    const snapshot = buildRadarSnapshot(
      [workspace("workspace-1")],
      [entry("workspace-1", { status: "running" })],
    );
    const source = snapshot.rows[0];
    if (!source) throw new Error("Expected a workspace-linked PR row");
    const inbox: GitHubInboxItem = {
      id: "PR_42",
      number: 42,
      url: source.url,
      title: source.title,
      repository: source.repository,
      author: "omercnet",
      authorKind: "human",
      createdAt: "2026-08-30T08:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      baseRefName: "main",
      headRefName: "fix/checkout",
      isDraft: false,
      isSecurity: false,
      comments: 1,
      labels: [],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksStatus: "success",
      reviewDecision: "approved",
      role: "author",
      changes: [],
    };

    const [merged] = mergeInboxRows(snapshot, [inbox]);
    expect(merged?.agents).toHaveLength(1);
    expect(merged?.bucket).toBe("being-handled");
  });
});
describe("viewer scope", () => {
  test("marks authored and requested-review rows from GitHub scope", () => {
    const mine = row();
    const review = row({
      id: "external#9",
      url: "https://github.com/example/project/pull/9",
      ownership: "unknown",
      reviewDecision: "pending",
    });
    const scoped = applyViewerScope([mine, review], {
      authoredUrls: [mine.url],
      reviewRequestedUrls: [review.url],
      error: null,
      inboxItems: [],
    });

    expect(scoped.find((item) => item.id === mine.id)?.ownership).toBe("mine");
    expect(scoped.find((item) => item.id === review.id)).toMatchObject({
      ownership: "external",
      reviewRequestedFromMe: true,
      bucket: "needs-you",
      reason: "Review requested",
    });
  });
});

describe("radar snapshot", () => {
  test("deduplicates one PR across workspaces and retains every agent", () => {
    const snapshot = buildRadarSnapshot(
      [workspace("workspace-1"), workspace("workspace-2")],
      [entry("workspace-1"), entry("workspace-2", { status: "running" })],
      new Date("2026-08-30T10:00:00.000Z"),
    );

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.workspaceIds).toEqual(["workspace-1", "workspace-2"]);
    expect(snapshot.rows[0]?.agents).toHaveLength(2);
    expect(snapshot.rows[0]?.bucket).toBe("being-handled");
  });

  test("ignores closed and merged pull requests", () => {
    const closed = workspace("closed", {
      pullRequest: {
        ...workspace("template").githubRuntime?.pullRequest,
        state: "closed",
      } as NonNullable<PaseoWorkspace["githubRuntime"]>["pullRequest"],
    });
    const merged = workspace("merged", {
      pullRequest: {
        ...workspace("template").githubRuntime?.pullRequest,
        isMerged: true,
      } as NonNullable<PaseoWorkspace["githubRuntime"]>["pullRequest"],
    });

    expect(buildRadarSnapshot([closed, merged], []).rows).toEqual([]);
  });

  test("preserves per-workspace forge errors", () => {
    const snapshot = buildRadarSnapshot(
      [workspace("broken", { pullRequest: null, error: { message: "gh timed out" } })],
      [],
    );

    expect(snapshot.warnings).toEqual([
      { workspaceId: "broken", workspaceName: "Workspace broken", message: "gh timed out" },
    ]);
  });
});

describe("display helpers", () => {
  test("searches delivery and ownership fields", () => {
    const value = row();
    expect(matchesRow(value, "checkout")).toBe(true);
    expect(matchesRow(value, "agent")).toBe(false);
    expect(matchesRow(value, "getpaseo")).toBe(true);
  });

  test("summarizes check progress", () => {
    expect(
      checkSummary(
        row({
          checksStatus: "pending",
          checks: [
            { name: "lint", status: "success", url: null },
            { name: "test", status: "pending", url: null },
          ],
        }),
      ),
    ).toBe("1 of 2 checks passed");
  });

  test("formats activity age", () => {
    expect(formatAge("2026-08-30T09:00:00.000Z", Date.parse("2026-08-30T10:30:00.000Z"))).toBe(
      "1h",
    );
  });
});
