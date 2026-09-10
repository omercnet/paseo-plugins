import type { usePaseo } from "@getpaseo/plugin/client";
import { z } from "zod";
import type { GitHubInboxItem } from "../shared/viewer-scope";

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

export interface RadarRow {
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

export interface RadarSnapshot {
  rows: RadarRow[];
  warnings: RadarWarning[];
  workspaceCount: number;
  refreshedAt: string;
  repositoryRoots: Record<string, string>;
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

function toRadarAgent(entry: AgentEntry): RadarAgent {
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

export function classifyRow(row: RadarRow): Pick<RadarRow, "bucket" | "reason"> {
  const humanBlocker = attentionReason(row.agents);
  if (humanBlocker) return { bucket: "needs-you", reason: humanBlocker };

  const activeAgent = hasActiveAgent(row.agents);
  if (
    !activeAgent &&
    row.agents.some((agent) => agent.status === "error" || agent.attentionReason === "error")
  ) {
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
  if (row.reviewRequestedFromMe) {
    return `Review ${row.url}. CI is complete and GitHub is requesting your review. Inspect the changes, follow the repository review workflow, submit the review when justified, and report the result.`;
  }
  return `Continue work on ${row.url}. Current state: ${row.reason}. Inspect the pull request and workspace, resolve the actionable blocker, run relevant validation, push the fix, and report the result. Do not merge the pull request.`;
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
    const agents = agentsByWorkspace.get(workspaceId) ?? [];
    agents.push(toRadarAgent(entry));
    agentsByWorkspace.set(workspaceId, agents);
  }
  for (const agents of agentsByWorkspace.values()) sortAgents(agents);

  const rows = new Map<string, RadarRow>();
  const warnings: RadarWarning[] = [];
  const repositoryRoots: Record<string, string> = {};

  for (const workspace of workspaces) {
    const remoteRepository = workspace.gitRuntime?.remoteUrl
      ? parseRemoteRepository(workspace.gitRuntime.remoteUrl)
      : null;
    if (remoteRepository) {
      repositoryRoots[remoteRepository.toLowerCase()] ??= workspace.projectRootPath;
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

    const repository =
      pullRequest.repoOwner && pullRequest.repoName
        ? `${pullRequest.repoOwner}/${pullRequest.repoName}`
        : parseRepository(pullRequest.url);
    const id = pullRequest.number
      ? `${repository.toLowerCase()}#${pullRequest.number}`
      : pullRequest.url;
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

    const row: RadarRow = {
      id,
      number: pullRequest.number ?? null,
      url: pullRequest.url,
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
