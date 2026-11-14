import type { usePaseo } from "@getpaseo/plugin/client";
import { z } from "zod";
import type { CwdMode } from "../shared/settings";
import { type GitHubInboxItem, type GitHubIssueItem, HttpsUrlSchema } from "../shared/viewer-scope";

export type PaseoApi = ReturnType<typeof usePaseo>;
export type PaseoWorkspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
export type AgentEntry = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number];
export type RadarBucket = "needs-you" | "being-handled" | "waiting" | "ready";

export const BUCKETS: readonly RadarBucket[] = ["needs-you", "ready", "being-handled", "waiting"];

export const BUCKET_TITLES: Record<RadarBucket, string> = {
  "needs-you": "Needs you",
  ready: "Ready",
  "being-handled": "Being handled",
  waiting: "Waiting externally",
};

const BUCKET_ORDER: Record<RadarBucket, number> = {
  "needs-you": 0,
  ready: 1,
  "being-handled": 2,
  waiting: 3,
};

const GitHubFactsSchema = z.object({
  mergeStateStatus: z.string().nullable().optional(),
  isInMergeQueue: z.boolean().optional(),
});
const PullRequestFactsSchema = z.object({
  github: GitHubFactsSchema.optional(),
  forgeSpecific: GitHubFactsSchema.extend({ forge: z.literal("github") }).optional(),
});

export interface RadarAgent {
  id: string;
  title: string;
  status: AgentEntry["agent"]["status"];
  requiresAttention: boolean;
  attentionReason: string | null;
  pendingPermissions: number;
  updatedAt: string;
}

export interface RadarCheck {
  name: string;
  status: "success" | "pending" | "failure" | "skipped" | "cancelled";
  url: string | null;
}

export type ViewerOwnership = "mine" | "external" | "unknown";
export type CwdTag = "CWD-BASE" | "CWD-WORKTREE" | "CWD-TBD";

export interface RadarRow {
  itemKind?: "pr" | "issue";
  issueRole?: GitHubIssueItem["role"];
  id: string;
  number: number | null;
  url: string;
  title: string;
  repository: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  author: string | null;
  authorKind: "human" | "bot";
  isSecurity: boolean;
  comments: number;
  labels: string[];
  changes: string[];
  linkedIssues: string[];
  cwdTag: CwdTag;
  hasLocalPlace: boolean;
  mergeable: "UNKNOWN" | "MERGEABLE" | "CONFLICTING";
  mergeStateStatus: string | null;
  checksStatus: "success" | "pending" | "none" | "failure";
  reviewDecision: "pending" | "approved" | "changes_requested" | null;
  checks: RadarCheck[];
  workspaceIds: string[];
  workspaceNames: string[];
  localProjectRoot: string | null;
  agents: RadarAgent[];
  ownership: ViewerOwnership;
  reviewRequestedFromMe: boolean;
  bucket: RadarBucket;
  reason: string;
  activityAt: string | null;
  refreshedAt: string | null;
}

export interface RadarWarning {
  workspaceId: string;
  workspaceName: string;
  message: string;
}

export interface RadarIssueMatch {
  workspaceIds: string[];
  workspaceNames: string[];
  agents: RadarAgent[];
  cwdTag: CwdTag;
}

export interface RadarSnapshot {
  rows: RadarRow[];
  warnings: RadarWarning[];
  workspaceCount: number;
  refreshedAt: string;
  repositoryRoots: Record<string, string>;
  issueMatches?: Record<string, RadarIssueMatch>;
}

export interface ViewerScopeData {
  authoredUrls: readonly string[];
  reviewRequestedUrls: readonly string[];
  error: string | null;
  inboxItems: readonly GitHubInboxItem[];
}

export type RadarAgentAction =
  | { kind: "ask"; agentId: string }
  | { kind: "start"; workspaceId: string }
  | { kind: "checkout"; cwd: string; number: number; repository: string }
  | null;

function isOpenPullRequest(state: string, isMerged: boolean): boolean {
  return !isMerged && state.toLowerCase() === "open";
}

function agentTitle(entry: AgentEntry): string {
  return entry.agent.title?.trim() || entry.agent.id.slice(0, 7);
}

/**
 * Helpers are background agents (fixed at creation) or legacy internal agents. Paseo hides them
 * from tabs, lists and attention. `includeBackground` still admits them, because it also admits
 * user agents in background workspaces, so callers filter on the agent's own flags. The flags are
 * read structurally: SDK lines before 0.16 do not declare `background`.
 */
export function isHelperAgent(agent: object): boolean {
  return (
    ("background" in agent && agent.background === true) ||
    ("internal" in agent && agent.internal === true)
  );
}

/** A PR row's view of an agent, or null for a helper, which never belongs on a row. */
export function toRadarAgent(entry: AgentEntry): RadarAgent | null {
  if (isHelperAgent(entry.agent)) return null;
  return {
    id: entry.agent.id,
    title: agentTitle(entry),
    status: entry.agent.status,
    requiresAttention: entry.agent.requiresAttention ?? false,
    attentionReason: entry.agent.attentionReason ?? null,
    pendingPermissions: entry.agent.pendingPermissions.length,
    updatedAt: entry.agent.updatedAt,
  };
}

function agentPriority(agent: RadarAgent): number {
  if (agent.pendingPermissions > 0 || agent.requiresAttention || agent.status === "error") return 0;
  if (agent.status === "running" || agent.status === "initializing") return 1;
  if (agent.status === "idle") return 2;
  return 3;
}

export function sortAgents(agents: RadarAgent[]): void {
  agents.sort((left, right) => {
    const byPriority = agentPriority(left) - agentPriority(right);
    if (byPriority !== 0) return byPriority;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function parseRepository(url: string): string {
  try {
    const parsed = new URL(url);
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : parsed.hostname;
  } catch {
    return "Unknown repository";
  }
}

function parseRemoteRepository(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function hasActiveAgent(agents: readonly RadarAgent[]): boolean {
  return agents.some((agent) => agent.status === "running" || agent.status === "initializing");
}

function attentionReason(agents: readonly RadarAgent[]): string | null {
  const permission = agents.find((agent) => agent.pendingPermissions > 0);
  if (permission) {
    return permission.pendingPermissions === 1
      ? "Agent needs permission"
      : `Agent needs ${permission.pendingPermissions} permissions`;
  }
  if (
    agents.some(
      (agent) =>
        agent.requiresAttention &&
        agent.attentionReason !== "finished" &&
        agent.attentionReason !== "error",
    )
  ) {
    return "Agent needs input";
  }
  return null;
}

function actionableBlocker(row: RadarRow): string | null {
  if (row.mergeable === "CONFLICTING" || row.mergeStateStatus === "DIRTY") {
    return "Merge conflict";
  }
  if (row.checksStatus === "failure") return "Checks failing";
  if (row.reviewDecision === "changes_requested") return "Changes requested";
  return null;
}

function externalWaitingReason(row: RadarRow): string {
  if (row.reviewDecision === "changes_requested") return "Waiting on author changes";
  if (row.mergeable === "CONFLICTING" || row.mergeStateStatus === "DIRTY") {
    return "Waiting on author to resolve conflicts";
  }
  if (row.checksStatus === "failure") return "Waiting on author to fix checks";
  if (row.reviewDecision === "pending") return "Waiting on reviewers";
  return "External pull request";
}

function hasFailedAgent(agents: readonly RadarAgent[]): boolean {
  return agents.some((agent) => agent.status === "error" || agent.attentionReason === "error");
}

export function classifyRow(row: RadarRow): Pick<RadarRow, "bucket" | "reason"> {
  const humanBlocker = attentionReason(row.agents);
  if (humanBlocker) return { bucket: "needs-you", reason: humanBlocker };

  const activeAgent = hasActiveAgent(row.agents);
  if (!activeAgent && hasFailedAgent(row.agents)) {
    return { bucket: "needs-you", reason: "Agent failed" };
  }
  if (activeAgent && row.ownership !== "mine") {
    return { bucket: "being-handled", reason: "Agent working" };
  }

  if (row.checksStatus === "pending") return { bucket: "waiting", reason: "Checks running" };

  if (row.ownership === "external") {
    const waitingReason = externalWaitingReason(row);
    if (row.reviewRequestedFromMe && waitingReason === "Waiting on reviewers") {
      return { bucket: "needs-you", reason: "Review requested" };
    }
    return { bucket: "waiting", reason: waitingReason };
  }

  if (row.ownership === "unknown") {
    return { bucket: "waiting", reason: "Viewer relationship unavailable" };
  }

  const blocker = actionableBlocker(row);
  if (blocker) {
    return activeAgent
      ? { bucket: "being-handled", reason: `${blocker}; agent working` }
      : { bucket: "needs-you", reason: blocker };
  }

  if (row.isDraft) {
    return activeAgent
      ? { bucket: "being-handled", reason: "Draft; agent working" }
      : { bucket: "waiting", reason: "Draft with no active agent" };
  }

  if (activeAgent) return { bucket: "being-handled", reason: "Agent working" };
  if (row.reviewDecision === "pending")
    return { bucket: "waiting", reason: "Waiting on reviewers" };
  if (row.mergeable === "UNKNOWN") {
    return { bucket: "waiting", reason: "Mergeability pending" };
  }
  if (row.mergeStateStatus === "BLOCKED") {
    return { bucket: "waiting", reason: "Waiting on repository requirements" };
  }
  if (row.mergeStateStatus === "BEHIND") {
    return { bucket: "needs-you", reason: "Branch behind base" };
  }
  if (row.mergeStateStatus === "UNSTABLE") {
    return { bucket: "needs-you", reason: "Checks unstable" };
  }
  if (row.mergeStateStatus && !["CLEAN", "HAS_HOOKS"].includes(row.mergeStateStatus)) {
    return { bucket: "waiting", reason: "Waiting on GitHub" };
  }

  if (row.mergeable === "MERGEABLE" && ["success", "none"].includes(row.checksStatus)) {
    return {
      bucket: "ready",
      reason: row.checksStatus === "none" ? "Mergeable; no checks" : "Checks passed; mergeable",
    };
  }

  return { bucket: "waiting", reason: "Waiting on repository status" };
}

export function agentActionFor(row: RadarRow): RadarAgentAction {
  if (row.bucket !== "needs-you") return null;
  if (
    row.agents.some(
      (agent) =>
        agent.pendingPermissions > 0 ||
        agent.status === "error" ||
        (agent.requiresAttention && agent.attentionReason !== "finished"),
    )
  ) {
    return null;
  }
  const promptable = row.agents.find(
    (agent) =>
      ["idle", "running", "initializing"].includes(agent.status) &&
      agent.pendingPermissions === 0 &&
      agent.attentionReason !== "permission",
  );
  if (promptable) return { kind: "ask", agentId: promptable.id };
  const workspaceId = row.workspaceIds[0];
  if (workspaceId) return { kind: "start", workspaceId };
  if (row.localProjectRoot && row.number) {
    return {
      kind: "checkout",
      cwd: row.localProjectRoot,
      number: row.number,
      repository: row.repository,
    };
  }
  return null;
}

export function buildAgentPrompt(row: RadarRow): string {
  if (row.itemKind === "issue") {
    return `Investigate and address GitHub issue ${row.url} (${row.title}). Inspect the repository, implement a fix or plan, run relevant validation, and report the result.`;
  }
  if (row.reviewRequestedFromMe) {
    return `Review ${row.url}. CI is complete and GitHub is requesting your review. Inspect the changes, follow the repository review workflow, submit the review when justified, and report the result.`;
  }
  return `Continue work on ${row.url}. Current state: ${row.reason}. Inspect the pull request and workspace, resolve the actionable blocker, run relevant validation, push the fix, and report the result. Do not merge the pull request.`;
}

type UrlOpener = (url: string) => Promise<unknown>;

export async function openPullRequestUrl(url: string, open: UrlOpener): Promise<void> {
  const parsed = HttpsUrlSchema.safeParse(url);
  if (!parsed.success) throw new Error("Only HTTPS pull request URLs are supported.");
  await open(parsed.data);
}

export function buildRadarSnapshot(
  workspaces: readonly PaseoWorkspace[],
  entries: readonly AgentEntry[],
  now = new Date(),
): RadarSnapshot {
  const agentsByWorkspace = new Map<string, RadarAgent[]>();
  for (const entry of entries) {
    const workspaceId = entry.agent.workspaceId;
    if (!workspaceId) continue;
    const agent = toRadarAgent(entry);
    if (!agent) continue;
    const agents = agentsByWorkspace.get(workspaceId) ?? [];
    agents.push(agent);
    agentsByWorkspace.set(workspaceId, agents);
  }
  for (const agents of agentsByWorkspace.values()) sortAgents(agents);

  const rows = new Map<string, RadarRow>();
  const warnings: RadarWarning[] = [];
  const repositoryRoots: Record<string, string> = {};
  const issueMatches: Record<string, RadarIssueMatch> = {};

  for (const workspace of workspaces) {
    const remoteRepository = workspace.gitRuntime?.remoteUrl
      ? parseRemoteRepository(workspace.gitRuntime.remoteUrl)
      : null;
    if (remoteRepository) {
      repositoryRoots[remoteRepository.toLowerCase()] ??= workspace.projectRootPath;
      const issueBranchMatch =
        workspace.gitRuntime?.currentBranch?.match(/^pr-radar\/issue-(\d+)$/);
      if (issueBranchMatch) {
        const issueKey = `${remoteRepository.toLowerCase()}#issue-${issueBranchMatch[1]}`;
        const wsAgents = agentsByWorkspace.get(workspace.id) ?? [];
        const wsLabels = (workspace as { labels?: readonly string[] }).labels;
        const wsCwdTag: CwdTag = wsLabels?.includes("CWD-BASE")
          ? "CWD-BASE"
          : wsLabels?.includes("CWD-WORKTREE")
            ? "CWD-WORKTREE"
            : "CWD-TBD";
        const current = issueMatches[issueKey] ?? {
          workspaceIds: [],
          workspaceNames: [],
          agents: [],
          cwdTag: "CWD-TBD" as CwdTag,
        };
        if (!current.workspaceIds.includes(workspace.id)) {
          current.workspaceIds.push(workspace.id);
          current.workspaceNames.push(workspace.name);
        }
        const knownIds = new Set(current.agents.map((a) => a.id));
        for (const a of wsAgents) {
          if (!knownIds.has(a.id)) current.agents.push(a);
        }
        sortAgents(current.agents);
        if (current.cwdTag === "CWD-TBD" && wsCwdTag !== "CWD-TBD") {
          current.cwdTag = wsCwdTag;
        }
        issueMatches[issueKey] = current;
      }
    }
    const runtime = workspace.githubRuntime;
    if (runtime?.error?.message) {
      warnings.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        message: runtime.error.message,
      });
    }

    const pullRequest = runtime?.pullRequest;
    if (!pullRequest || !isOpenPullRequest(pullRequest.state, pullRequest.isMerged)) continue;
    const parsedUrl = HttpsUrlSchema.safeParse(pullRequest.url);
    if (!parsedUrl.success) continue;
    const url = parsedUrl.data;

    const repository =
      pullRequest.repoOwner && pullRequest.repoName
        ? `${pullRequest.repoOwner}/${pullRequest.repoName}`
        : parseRepository(url);
    const id = pullRequest.number ? `${repository.toLowerCase()}#${pullRequest.number}` : url;
    const parsedFacts = PullRequestFactsSchema.safeParse(pullRequest);
    const facts = parsedFacts.success
      ? (parsedFacts.data.forgeSpecific ?? parsedFacts.data.github ?? null)
      : null;
    const agents = agentsByWorkspace.get(workspace.id) ?? [];
    const existing = rows.get(id);

    if (existing) {
      if (!existing.workspaceIds.includes(workspace.id)) {
        existing.workspaceIds.push(workspace.id);
        existing.workspaceNames.push(workspace.name);
      }
      const knownAgentIds = new Set(existing.agents.map((agent) => agent.id));
      for (const agent of agents) {
        if (!knownAgentIds.has(agent.id)) existing.agents.push(agent);
      }
      sortAgents(existing.agents);
      if (Date.parse(workspace.activityAt ?? "") > Date.parse(existing.activityAt ?? "")) {
        existing.activityAt = workspace.activityAt;
      }
      const classification = classifyRow(existing);
      existing.bucket = classification.bucket;
      existing.reason = classification.reason;
      continue;
    }

    const workspaceCwdTag: CwdTag = workspace.labels?.includes("CWD-BASE")
      ? "CWD-BASE"
      : workspace.labels?.includes("CWD-WORKTREE")
        ? "CWD-WORKTREE"
        : workspace.workspaceKind === "worktree"
          ? "CWD-WORKTREE"
          : "CWD-BASE";

    const row: RadarRow = {
      id,
      number: pullRequest.number ?? null,
      url,
      title: pullRequest.title,
      repository,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      isDraft: pullRequest.isDraft ?? false,
      author: null,
      authorKind: "human",
      isSecurity: false,
      comments: 0,
      labels: [],
      changes: [],
      linkedIssues: [],
      cwdTag: workspaceCwdTag,
      hasLocalPlace: true,
      mergeable: pullRequest.mergeable ?? "UNKNOWN",
      mergeStateStatus: facts?.mergeStateStatus ?? null,
      checksStatus: pullRequest.checksStatus ?? "none",
      reviewDecision: pullRequest.reviewDecision ?? null,
      checks: pullRequest.checks ?? [],
      workspaceIds: [workspace.id],
      workspaceNames: [workspace.name],
      localProjectRoot: repositoryRoots[repository.toLowerCase()] ?? workspace.projectRootPath,
      agents: [...agents],
      ownership: "unknown",
      reviewRequestedFromMe: false,
      bucket: "waiting",
      reason: "Waiting on repository status",
      activityAt: workspace.activityAt,
      refreshedAt: runtime?.refreshedAt ?? null,
    };
    const classification = classifyRow(row);
    row.bucket = classification.bucket;
    row.reason = classification.reason;
    rows.set(id, row);
  }

  const sorted = [...rows.values()].sort((left, right) => {
    const byBucket = BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket];
    if (byBucket !== 0) return byBucket;
    const byActivity = Date.parse(left.activityAt ?? "") - Date.parse(right.activityAt ?? "");
    if (byActivity !== 0) return byActivity;
    return left.title.localeCompare(right.title);
  });

  return {
    rows: sorted,
    warnings,
    workspaceCount: workspaces.length,
    refreshedAt: now.toISOString(),
    repositoryRoots,
    issueMatches,
  };
}

export function mergeInboxRows(
  snapshot: RadarSnapshot,
  inboxItems: readonly GitHubInboxItem[],
): RadarRow[] {
  const rows = new Map(snapshot.rows.map((row) => [row.id, { ...row }]));
  for (const item of inboxItems) {
    const id = `${item.repository.toLowerCase()}#${item.number}`;
    const existing = rows.get(id);
    if (existing) {
      existing.title = item.title;
      existing.url = item.url;
      existing.author = item.author;
      existing.authorKind = item.authorKind;
      existing.isSecurity = item.isSecurity;
      existing.comments = item.comments;
      existing.labels = [...item.labels];
      existing.changes = [...item.changes];
      existing.linkedIssues = [...item.linkedIssues];
      existing.isDraft = item.isDraft;
      existing.baseRefName = item.baseRefName || existing.baseRefName;
      existing.headRefName = item.headRefName || existing.headRefName;
      existing.mergeable = item.mergeable;
      existing.mergeStateStatus = item.mergeStateStatus;
      existing.checksStatus = item.checksStatus;
      existing.reviewDecision = item.reviewDecision;
      existing.ownership = item.role === "author" ? "mine" : "external";
      existing.reviewRequestedFromMe = item.role === "reviewer";
      existing.localProjectRoot ??= snapshot.repositoryRoots[item.repository.toLowerCase()] ?? null;
      existing.hasLocalPlace =
        existing.workspaceIds.length > 0 || Boolean(existing.localProjectRoot);
      if (Date.parse(item.updatedAt) > Date.parse(existing.activityAt ?? "")) {
        existing.activityAt = item.updatedAt;
      }
      const classification = classifyRow(existing);
      existing.bucket = classification.bucket;
      existing.reason = classification.reason;
      continue;
    }

    const row: RadarRow = {
      id,
      number: item.number,
      url: item.url,
      title: item.title,
      repository: item.repository,
      baseRefName: item.baseRefName,
      headRefName: item.headRefName,
      isDraft: item.isDraft,
      author: item.author,
      authorKind: item.authorKind,
      isSecurity: item.isSecurity,
      comments: item.comments,
      labels: [...item.labels],
      changes: [...item.changes],
      linkedIssues: [...item.linkedIssues],
      cwdTag: "CWD-TBD",
      hasLocalPlace: Boolean(snapshot.repositoryRoots[item.repository.toLowerCase()]),
      mergeable: item.mergeable,
      mergeStateStatus: item.mergeStateStatus,
      checksStatus: item.checksStatus,
      reviewDecision: item.reviewDecision,
      checks: [],
      workspaceIds: [],
      workspaceNames: [],
      localProjectRoot: snapshot.repositoryRoots[item.repository.toLowerCase()] ?? null,
      agents: [],
      ownership: item.role === "author" ? "mine" : "external",
      reviewRequestedFromMe: item.role === "reviewer",
      bucket: "waiting",
      reason: "Waiting on repository status",
      activityAt: item.updatedAt,
      refreshedAt: item.updatedAt,
    };
    const classification = classifyRow(row);
    row.bucket = classification.bucket;
    row.reason = classification.reason;
    rows.set(id, row);
  }

  return [...rows.values()].sort((left, right) => {
    const byBucket = BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket];
    if (byBucket !== 0) return byBucket;
    const byActivity = Date.parse(right.activityAt ?? "") - Date.parse(left.activityAt ?? "");
    if (byActivity !== 0) return byActivity;
    return left.title.localeCompare(right.title);
  });
}

export function applyViewerScope(
  rows: readonly RadarRow[],
  scope: ViewerScopeData | null,
): RadarRow[] {
  const authored = new Set(scope?.error ? [] : scope?.authoredUrls.map((url) => url.toLowerCase()));
  const reviewRequested = new Set(
    scope?.error ? [] : scope?.reviewRequestedUrls.map((url) => url.toLowerCase()),
  );
  const ownershipAvailable = scope !== null && scope.error === null;
  const result = rows.map((row) => {
    const url = row.url.toLowerCase();
    const updated: RadarRow = {
      ...row,
      ownership: ownershipAvailable ? (authored.has(url) ? "mine" : "external") : "unknown",
      reviewRequestedFromMe: ownershipAvailable && reviewRequested.has(url),
    };
    const classification = classifyRow(updated);
    updated.bucket = classification.bucket;
    updated.reason = classification.reason;
    return updated;
  });
  result.sort((left, right) => {
    const byBucket = BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket];
    if (byBucket !== 0) return byBucket;
    const byActivity = Date.parse(left.activityAt ?? "") - Date.parse(right.activityAt ?? "");
    if (byActivity !== 0) return byActivity;
    return left.title.localeCompare(right.title);
  });
  return result;
}

export const SORT_KEYS = ["attention", "mergeable", "recent", "oldest", "repository"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_TITLES: Record<SortKey, string> = {
  mergeable: "Mergeable first",
  attention: "Needs attention first",
  recent: "Recently updated",
  oldest: "Oldest first",
  repository: "Repository",
};

// Unknown or unparsable activity counts as the epoch (the oldest), which keeps the order total.
const activityOf = (row: RadarRow) => Date.parse(row.activityAt ?? "") || 0;
const oldestFirst = (left: RadarRow, right: RadarRow) =>
  activityOf(left) - activityOf(right) || left.title.localeCompare(right.title);
const newestFirst = (left: RadarRow, right: RadarRow) =>
  activityOf(right) - activityOf(left) || left.title.localeCompare(right.title);

/** Orders rows for display. Returns a new array; the input order is the bucket order. */
export function sortRows(rows: readonly RadarRow[], key: SortKey): RadarRow[] {
  const sorted = [...rows];
  switch (key) {
    case "mergeable":
      // classifyRow only yields "ready" for the viewer's own, non-draft, mergeable PRs.
      return sorted.sort(
        (left, right) =>
          Number(right.bucket === "ready") - Number(left.bucket === "ready") ||
          BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket] ||
          newestFirst(left, right),
      );
    case "attention":
      // The default: the order applyViewerScope produces, longest waiting first within a bucket.
      return sorted.sort(
        (left, right) =>
          BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket] || oldestFirst(left, right),
      );
    case "recent":
      return sorted.sort(newestFirst);
    case "oldest":
      return sorted.sort(oldestFirst);
    case "repository":
      return sorted.sort(
        (left, right) =>
          left.repository.localeCompare(right.repository) ||
          (left.number ?? 0) - (right.number ?? 0),
      );
  }
}

export function matchesRow(row: RadarRow, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return [
    row.repository,
    row.number?.toString() ?? "",
    row.title,
    row.headRefName,
    row.baseRefName,
    row.reason,
    ...row.workspaceNames,
    ...row.agents.map((agent) => agent.title),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function formatAge(value: string | null, now: number): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function checkSummary(row: RadarRow): string {
  if (row.checks.length === 0) {
    if (row.checksStatus === "none") return "No checks";
    return row.checksStatus === "success"
      ? "Checks passed"
      : row.checksStatus === "failure"
        ? "Checks failing"
        : "Checks running";
  }
  const passed = row.checks.filter(
    (check) => check.status === "success" || check.status === "skipped",
  ).length;
  const failed = row.checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  ).length;
  if (failed > 0) return `${failed} of ${row.checks.length} checks failing`;
  if (passed < row.checks.length) return `${passed} of ${row.checks.length} checks passed`;
  return passed === 1 ? "1 check passed" : `${passed} checks passed`;
}

type AgentProfileLike = {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  // A host older than 0.16 hands over profiles that keep their options here. Its client sends this
  // field as is, and its daemon reads feature values from nowhere else.
  featureValues?: Record<string, unknown>;
  // Paseo 0.16 profiles store provider options here.
  options?: Record<string, unknown>;
};

// Each field goes out as the profile holds it. The 0.16 SDK merges them on send (an explicit
// `options` key wins); an older host's client does no merging, so folding them here would move a
// pre-0.16 profile's values to a field its daemon does not read for features.
export function profileAgentConfig(profile: AgentProfileLike) {
  return {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.options && Object.keys(profile.options).length > 0
      ? { options: profile.options }
      : {}),
    ...(profile.featureValues && Object.keys(profile.featureValues).length > 0
      ? { featureValues: profile.featureValues }
      : {}),
  };
}

/**
 * The provider and model a routing result sets. A routed provider that differs from the current
 * one without a routed model drops the model, which belonged to the old provider (it would
 * otherwise build an id such as `codex/<claude model>`). If the caller refuses a routed provider
 * because the user edited it, a routed model is applied only when it belongs to the current
 * provider.
 */
export function routedProviderModel(
  current: { provider?: string },
  routed: { provider?: string; model?: string },
  options: { applyProvider?: boolean } = {},
): { provider?: string; model?: string } {
  const result: { provider?: string; model?: string } = {};
  const applyProvider = options.applyProvider ?? true;
  const providerApplied = Boolean(routed.provider && applyProvider);
  if (providerApplied) result.provider = routed.provider;
  if (routed.model) {
    const modelMatchesCurrentProvider = !routed.provider || routed.provider === current.provider;
    if (providerApplied || modelMatchesCurrentProvider) result.model = routed.model;
  } else if (providerApplied && routed.provider !== current.provider) result.model = "";
  return result;
}

/** Cloning is never preselected: the user has to pick the clone row to allow it. */
export function initialLaunchTarget(row: Pick<RadarRow, "localProjectRoot">) {
  return { selectedDir: row.localProjectRoot ?? null, allowClone: false };
}

export interface RoutingLaunchState {
  selectedDir: string | null;
  cwdMode: CwdMode;
  provider: string;
}

export function automaticRoutingLaunchState(
  row: Pick<RadarRow, "localProjectRoot">,
  current: RoutingLaunchState,
  defaults: Pick<RoutingLaunchState, "cwdMode" | "provider">,
  isNewRow: boolean,
): RoutingLaunchState {
  if (!isNewRow) return current;
  const target = initialLaunchTarget(row);
  return {
    selectedDir: target.selectedDir,
    cwdMode: defaults.cwdMode,
    provider: defaults.provider,
  };
}

export function autoLaunchRequiresModal(
  settings: {
    autoLaunchMode: "disabled" | "prompt" | "existing_only" | "existing_or_clone";
    defaultCwdMode: CwdTag;
  },
  row: Pick<RadarRow, "hasLocalPlace">,
): boolean {
  const shouldAutoLaunch =
    settings.autoLaunchMode === "existing_or_clone" ||
    (settings.autoLaunchMode === "existing_only" && row.hasLocalPlace);
  return !shouldAutoLaunch || settings.defaultCwdMode === "CWD-BASE";
}

const CWD_TAGS: readonly CwdTag[] = ["CWD-BASE", "CWD-WORKTREE", "CWD-TBD"];

interface LabelableWorkspace {
  // Workspaces before Paseo 0.16.0-beta.1 have no setLabel.
  setLabel?(label: string, options: { assigned: boolean }): unknown;
}

/** Marks exactly one CWD tag on the workspace; a host without label support is left unlabelled. */
export async function labelWorkspaceCwd(
  workspace: LabelableWorkspace,
  cwdTag: CwdTag,
): Promise<void> {
  if (typeof workspace.setLabel !== "function") return;
  await Promise.all(CWD_TAGS.map((tag) => workspace.setLabel?.(tag, { assigned: tag === cwdTag })));
}

// A routing script is user-supplied code, so what it may set on a launch is limited to these lists.
// Permission modes that skip approvals (bypassPermissions, dontAsk, full access) stay out, so only
// a person can pick them. Provider `options` keys outside the list are dropped the same way.
export const ROUTED_MODE_IDS: readonly string[] = ["default", "plan", "acceptEdits", "read-only"];
export const ROUTED_OPTION_KEYS: readonly string[] = ["contextMode"];

export interface RestrictedRouting {
  modeId?: string;
  options?: Record<string, unknown>;
  ignored: string[];
}

export function restrictRoutedLaunch(routed: {
  modeId?: string;
  options?: Record<string, unknown>;
}): RestrictedRouting {
  const ignored: string[] = [];
  const result: RestrictedRouting = { ignored };
  const modeId = routed.modeId?.trim();
  if (modeId) {
    if (ROUTED_MODE_IDS.includes(modeId)) result.modeId = modeId;
    else ignored.push(`modeId ${modeId}`);
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(routed.options ?? {})) {
    if (ROUTED_OPTION_KEYS.includes(key)) kept[key] = value;
    else ignored.push(`options.${key}`);
  }
  if (Object.keys(kept).length > 0) result.options = kept;
  return result;
}

/**
 * A profile a routing script names is routed input too: its modeId, options and featureValues
 * reach the agent config. It is accepted only when the profile asks for nothing a script may not
 * set itself; otherwise the caller keeps the profile the user chose and reports it as ignored.
 */
export function vetRoutedProfile(
  profiles: readonly (AgentProfileLike & { name: string })[],
  routedName: string | undefined,
): { profileName?: string; ignored: string[] } {
  const wanted = routedName?.trim();
  if (!wanted) return { ignored: [] };
  const profile = profiles.find(
    (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase(),
  );
  const modeOk = !profile?.modeId?.trim() || ROUTED_MODE_IDS.includes(profile.modeId.trim());
  const keysOk = [profile?.options, profile?.featureValues].every((bag) =>
    Object.keys(bag ?? {}).every((key) => ROUTED_OPTION_KEYS.includes(key)),
  );
  if (!profile || !modeOk || !keysOk) return { ignored: [`profile ${wanted}`] };
  return { profileName: profile.name, ignored: [] };
}

export interface AgentLaunchOverrides {
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  contextMode?: string;
  options?: Record<string, unknown>;
  labels?: Record<string, string>;
}

const MAX_LABELS = 16;
const MAX_LABEL_LEN = 128;

// Labels for a launched agent: the routing script's extra labels plus PR Radar's own `pr-radar.cwd`.
// The `pr-radar.` prefix is reserved (the script cannot set or shadow it), keys and values are trimmed
// non-empty strings of bounded length, and at most MAX_LABELS survive, so a script cannot flood the agent.
export function buildAgentLabels(
  cwdTag: string,
  overrides: AgentLaunchOverrides = {},
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(overrides.labels ?? {})) {
    if (Object.keys(extra).length >= MAX_LABELS) break;
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value || key.length > MAX_LABEL_LEN || value.length > MAX_LABEL_LEN) continue;
    if (key.startsWith("pr-radar.")) continue;
    extra[key] = value;
  }
  return { ...extra, "pr-radar.cwd": cwdTag };
}

export function buildAgentConfig(
  profile: AgentProfileLike | undefined,
  overrides: AgentLaunchOverrides = {},
) {
  const baseProvider = overrides.provider?.trim() || profile?.provider || "claude";
  const baseModel = overrides.model?.trim() || (overrides.provider?.trim() ? "" : profile?.model);
  const provider = baseModel ? `${baseProvider}/${baseModel}` : baseProvider;
  const modeId = overrides.modeId?.trim() || profile?.modeId;
  const thinkingOptionId = overrides.thinkingOptionId?.trim() || profile?.thinkingOptionId;
  const mergedOptions: Record<string, unknown> = {
    ...(profile?.options ?? {}),
    ...(overrides.options ?? {}),
    ...(overrides.contextMode?.trim() ? { contextMode: overrides.contextMode.trim() } : {}),
  };
  return {
    provider,
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(Object.keys(mergedOptions).length > 0 ? { options: mergedOptions } : {}),
    ...(profile?.featureValues && Object.keys(profile.featureValues).length > 0
      ? { featureValues: profile.featureValues }
      : {}),
  };
}

export function splitDraftRows(rows: readonly RadarRow[]): {
  pullRequests: RadarRow[];
  draftPullRequests: RadarRow[];
} {
  const pullRequests: RadarRow[] = [];
  const draftPullRequests: RadarRow[] = [];
  for (const row of rows) {
    if (row.isDraft) {
      draftPullRequests.push(row);
    } else {
      pullRequests.push(row);
    }
  }
  return { pullRequests, draftPullRequests };
}

export function buildIssueRows(
  snapshot: RadarSnapshot | undefined,
  issueItems: readonly GitHubIssueItem[],
): RadarRow[] {
  const roots = snapshot?.repositoryRoots ?? {};
  const matches = snapshot?.issueMatches ?? {};
  return issueItems.map((item) => {
    const issueKey = `${item.repository.toLowerCase()}#issue-${item.number}`;
    const matched = matches[issueKey];
    const localProjectRoot = roots[item.repository.toLowerCase()] ?? null;
    const agents = matched ? [...matched.agents] : [];
    const workspaceIds = matched ? [...matched.workspaceIds] : [];
    const workspaceNames = matched ? [...matched.workspaceNames] : [];
    const cwdTag = matched?.cwdTag ?? "CWD-TBD";
    const roleLabel =
      item.role === "author"
        ? "Authored issue"
        : item.role === "assignee"
          ? "Assigned to you"
          : "Open in your repository";
    const humanBlocker = attentionReason(agents);
    const activeAgent = hasActiveAgent(agents);
    const bucket: RadarBucket = humanBlocker
      ? "needs-you"
      : activeAgent
        ? "being-handled"
        : hasFailedAgent(agents)
          ? "needs-you"
          : item.role === "assignee"
            ? "needs-you"
            : "waiting";
    return {
      itemKind: "issue",
      issueRole: item.role,
      id: issueKey,
      number: item.number,
      url: item.url,
      title: item.title,
      repository: item.repository,
      baseRefName: "",
      headRefName: item.title,
      isDraft: false,
      author: item.author,
      authorKind: item.authorKind,
      isSecurity: item.isSecurity,
      comments: item.comments,
      labels: [...item.labels],
      changes: [],
      linkedIssues: [],
      cwdTag,
      hasLocalPlace: Boolean(localProjectRoot) || workspaceIds.length > 0,
      mergeable: "UNKNOWN",
      mergeStateStatus: null,
      checksStatus: "none",
      reviewDecision: null,
      checks: [],
      workspaceIds,
      workspaceNames,
      localProjectRoot,
      agents,
      ownership: item.role === "author" ? "mine" : "external",
      reviewRequestedFromMe: false,
      bucket,
      reason: roleLabel,
      activityAt: item.updatedAt,
      refreshedAt: item.updatedAt,
    };
  });
}
