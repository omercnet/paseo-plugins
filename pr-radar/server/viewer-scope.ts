import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import type {
  acknowledgeViewerScope,
  GitHubInboxItem,
  GitHubIssueItem,
  viewerScope,
} from "../shared/viewer-scope";
import { mergeChanges } from "./changes";
import { ghEnv } from "./workspace-ops";

const execFileAsync = promisify(execFile);
const SEARCH_LIMIT = 100;
const ENRICHMENT_BATCH_SIZE = 20;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SCOPE_SEARCH_LIMIT = 1000;

function statePath(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "pr-radar", "inbox-state.json");
}

interface SearchRecord {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string; is_bot?: boolean; type?: string } | null;
  repository: { nameWithOwner: string };
  commentsCount: number;
  labels: Array<{ name: string }>;
}

interface Enrichment {
  id: string;
  baseRefName: string;
  headRefName: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "UNKNOWN" | "MERGEABLE" | "CONFLICTING";
  mergeStateStatus: string;
  statusCheckRollup: { state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" } | null;
  body?: string | null;
  closingIssuesReferences?: { nodes?: Array<{ url?: string | null } | null> } | null;
}

interface StoredItem {
  updatedAt: string;
  checksStatus: GitHubInboxItem["checksStatus"];
  reviewDecision: GitHubInboxItem["reviewDecision"];
  mergeable: GitHubInboxItem["mergeable"];
  mergeStateStatus: string | null;
}

interface StoredWindow {
  items: Record<string, StoredItem>;
  pendingChanges: Record<string, string[]>;
  acknowledgedAt: string | null;
}

interface StoredState {
  version: 2;
  windows: Record<string, StoredWindow>;
}

async function runGh(args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
    env: ghEnv(),
  });
  return stdout.trim();
}

/**
 * One refresh issues four searches (the scope searches page up to ten times each). GitHub advises
 * serial requests to avoid secondary rate limits, so searches share a small queue.
 */
const SEARCH_CONCURRENCY = 2;
let activeSearches = 0;
const searchWaiters: Array<() => void> = [];

async function runSearch(args: string[]): Promise<string> {
  while (activeSearches >= SEARCH_CONCURRENCY) {
    const { promise, resolve } = Promise.withResolvers<void>();
    searchWaiters.push(resolve);
    await promise;
  }
  activeSearches += 1;
  try {
    return await runGh(args);
  } finally {
    activeSearches -= 1;
    searchWaiters.shift()?.();
  }
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function viewerLogin(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const login = await runGh(["api", "user", "--jq", ".login"]);
      if (login) return login;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("GitHub CLI is not authenticated on this Paseo host.");
}

async function searchPullRequests(
  filter: "author" | "review-requested",
  viewer: string,
  since: string,
): Promise<SearchRecord[]> {
  const fields = [
    "id",
    "number",
    "title",
    "url",
    "isDraft",
    "createdAt",
    "updatedAt",
    "author",
    "repository",
    "commentsCount",
    "labels",
  ].join(",");
  const output = await runSearch([
    "search",
    "prs",
    `--${filter}=${viewer}`,
    "--state=open",
    "--archived=false",
    `--updated=>=${since}`,
    `--limit=${SEARCH_LIMIT}`,
    "--sort=updated",
    "--order=desc",
    `--json=${fields}`,
  ]);
  return JSON.parse(output) as SearchRecord[];
}

interface IssueSearchRecord {
  id: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string; is_bot?: boolean; type?: string } | null;
  repository: { nameWithOwner: string };
  commentsCount: number;
  labels: Array<{ name: string }>;
}

async function searchIssues(
  filter: "author" | "assignee" | "owner",
  viewer: string,
  since: string,
): Promise<{ records: IssueSearchRecord[]; failed: boolean }> {
  const fields = [
    "id",
    "number",
    "title",
    "url",
    "createdAt",
    "updatedAt",
    "author",
    "repository",
    "commentsCount",
    "labels",
  ].join(",");
  try {
    const output = await runSearch([
      "search",
      "issues",
      `--${filter}=${viewer}`,
      "--state=open",
      "--archived=false",
      `--updated=>=${since}`,
      `--limit=${SEARCH_LIMIT}`,
      "--sort=updated",
      "--order=desc",
      `--json=${fields}`,
    ]);
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return { records: [], failed: true };
    return { records: parsed as IssueSearchRecord[], failed: false };
  } catch {
    return { records: [], failed: true };
  }
}

/** When one issue matches several searches it is shown under the highest-ranked role. */
const ISSUE_ROLE_RANK: Record<GitHubIssueItem["role"], number> = {
  owner: 0,
  assignee: 1,
  author: 2,
};

function toIssueItem(record: IssueSearchRecord, role: GitHubIssueItem["role"]): GitHubIssueItem {
  const labels = record.labels.map(({ name }) => name);
  const authorKind =
    record.author?.is_bot || record.author?.type === "Bot" || record.author?.login.endsWith("[bot]")
      ? "bot"
      : "human";
  return {
    id: record.id,
    number: record.number,
    url: record.url,
    title: record.title,
    repository: record.repository.nameWithOwner,
    author: record.author?.login ?? null,
    authorKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isSecurity:
      labels.some((label) => /security|vulnerability|cve/i.test(label)) ||
      /security|vulnerabilit|\bcve\b/i.test(record.title),
    comments: record.commentsCount,
    labels,
    role,
  };
}

async function searchScopeUrls(filter: "author" | "review-requested"): Promise<string[]> {
  const output = await runSearch([
    "search",
    "prs",
    `--${filter}=@me`,
    "--state=open",
    "--archived=false",
    `--limit=${SCOPE_SEARCH_LIMIT}`,
    "--json=url",
  ]);
  return (JSON.parse(output) as Array<{ url: string }>).map(({ url }) => url);
}

const enrichmentQuery = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        baseRefName
        headRefName
        reviewDecision
        mergeable
        mergeStateStatus
        statusCheckRollup { state }
        body
        closingIssuesReferences(first: 20) {
          nodes { url }
        }
      }
    }
  }
`;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function enrich(
  ids: string[],
): Promise<{ states: Map<string, Enrichment>; failures: number }> {
  const results = await Promise.allSettled(
    chunks(ids, ENRICHMENT_BATCH_SIZE).map(async (batch) => {
      const args = ["api", "graphql", "-f", `query=${enrichmentQuery}`];
      for (const id of batch) args.push("-F", `ids[]=${id}`);
      const payload = JSON.parse(await runGh(args, 10_000)) as {
        data?: { nodes?: Array<Enrichment | null> };
        errors?: Array<{ message: string }>;
      };
      if (!payload.data?.nodes) {
        throw new Error(payload.errors?.map(({ message }) => message).join("; ") || "No data");
      }
      return payload.data.nodes.filter((item): item is Enrichment => item !== null);
    }),
  );
  const states = new Map<string, Enrichment>();
  let failures = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failures += 1;
      continue;
    }
    for (const item of result.value) states.set(item.id, item);
  }
  return { states, failures };
}

function checksStatus(state: Enrichment | undefined): GitHubInboxItem["checksStatus"] {
  switch (state?.statusCheckRollup?.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function reviewDecision(state: Enrichment | undefined): GitHubInboxItem["reviewDecision"] {
  switch (state?.reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "pending";
    default:
      return null;
  }
}

function extractLinkedIssues(state: Enrichment | undefined): string[] {
  const urls = new Set<string>();
  for (const node of state?.closingIssuesReferences?.nodes ?? []) {
    const url = node?.url?.trim();
    if (url && /^https:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/\d+$/i.test(url)) {
      urls.add(url);
    }
  }
  const body = state?.body ?? "";
  if (body) {
    const matches = body.match(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+/g,
    );
    for (const match of matches ?? []) {
      urls.add(match);
    }
  }
  return [...urls];
}

function toInboxItem(
  record: SearchRecord,
  role: GitHubInboxItem["role"],
  state: Enrichment | undefined,
): GitHubInboxItem {
  const labels = record.labels.map(({ name }) => name);
  const authorKind =
    record.author?.is_bot || record.author?.type === "Bot" || record.author?.login.endsWith("[bot]")
      ? "bot"
      : "human";
  return {
    id: record.id,
    number: record.number,
    url: record.url,
    title: record.title,
    repository: record.repository.nameWithOwner,
    author: record.author?.login ?? null,
    authorKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    baseRefName: state?.baseRefName ?? "",
    headRefName: state?.headRefName ?? "",
    isDraft: record.isDraft,
    isSecurity:
      labels.some((label) => /security|vulnerability|cve/i.test(label)) ||
      /security|vulnerabilit|\bcve\b/i.test(record.title),
    comments: record.commentsCount,
    labels,
    mergeable: state?.mergeable ?? "UNKNOWN",
    mergeStateStatus: state?.mergeStateStatus ?? null,
    checksStatus: checksStatus(state),
    reviewDecision: reviewDecision(state),
    role,
    changes: [],
    linkedIssues: extractLinkedIssues(state),
  };
}

async function readState(): Promise<StoredState> {
  try {
    const state = JSON.parse(await readFile(statePath(), "utf8")) as StoredState;
    if (state.version === 2 && state.windows && typeof state.windows === "object") return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("PR Radar ignored unreadable inbox state", error);
    }
  }
  return { version: 2, windows: {} };
}

let writeSequence = 0;

async function writeState(state: StoredState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  // Unique per write: overlapping writes must not rename each other's temp file away.
  const temporaryPath = `${path}.${process.pid}.${++writeSequence}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

let stateQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialises read-modify-write cycles on the state file. The change callback runs inside the
 * queue after a fresh read, so a slow GitHub refresh cannot overwrite an acknowledgement made
 * while it was in flight.
 */
function updateState<T>(change: (state: StoredState) => T): Promise<T> {
  const run = stateQueue.then(async () => {
    const state = await readState();
    const result = change(state);
    await writeState(state);
    return result;
  });
  stateQueue = run.catch(() => undefined);
  return run;
}

function storedItem(item: GitHubInboxItem): StoredItem {
  return {
    updatedAt: item.updatedAt,
    checksStatus: item.checksStatus,
    reviewDecision: item.reviewDecision,
    mergeable: item.mergeable,
    mergeStateStatus: item.mergeStateStatus,
  };
}

function detectChanges(previous: StoredItem | undefined, item: GitHubInboxItem): string[] {
  if (!previous) return ["New PR"];
  const changes = new Set<string>();
  if (previous.updatedAt !== item.updatedAt) changes.add("New activity");
  if (previous.checksStatus !== item.checksStatus) {
    changes.add(`Checks: ${previous.checksStatus} → ${item.checksStatus}`);
  }
  if (previous.reviewDecision !== item.reviewDecision) {
    changes.add(`Review: ${previous.reviewDecision ?? "none"} → ${item.reviewDecision ?? "none"}`);
  }
  if (previous.mergeable !== item.mergeable) {
    changes.add(`Mergeable: ${previous.mergeable.toLowerCase()} → ${item.mergeable.toLowerCase()}`);
  }
  if (previous.mergeStateStatus !== item.mergeStateStatus) {
    changes.add(
      `Merge state: ${previous.mergeStateStatus ?? "unknown"} → ${item.mergeStateStatus ?? "unknown"}`,
    );
  }
  return [...changes];
}

type ViewerScopeOutput = z.input<typeof viewerScope.output>;

/** Everything one GitHub refresh learns for a window; independent of the URLs a client asks about. */
interface Snapshot {
  viewer: string;
  authored: SearchRecord[];
  reviewRequested: SearchRecord[];
  authoredScope: string[];
  reviewRequestedScope: string[];
  inboxItems: GitHubInboxItem[];
  issueItems: GitHubIssueItem[];
  /** Every role whose search returned each issue; a row shows only the highest-ranked one. */
  issueRoles: Map<string, Set<GitHubIssueItem["role"]>>;
  issueTruncated: boolean;
  issueSearchFailures: number;
  /** When each role's issue search last succeeded (ms); a role's kept issues age from here. */
  issueFreshAt: Record<GitHubIssueItem["role"], number>;
  /** Whether each role's list hit the search cap; a kept role keeps its flag. */
  issueTruncatedBy: Record<GitHubIssueItem["role"], boolean>;
  enrichmentFailures: number;
  acknowledgedAt: string | null;
}

/**
 * The expensive part: ~5 s of gh searches and GraphQL enrichment. `previous` is the window's last
 * snapshot: a failed issue search keeps its role's share of the issues it held, since an empty
 * answer from a failed call says nothing about the issues. Only for the same viewer, and only
 * while that role's last good search is within MAX_STALE_MS, so failures cannot hide behind old
 * data forever (the coverage note keeps reporting them). A snapshot holding kept issues can still
 * be served for up to MAX_STALE_MS more if the refreshes after it throw outright.
 */
async function fetchSnapshot(windowDays: number, previous?: Snapshot): Promise<Snapshot> {
  const viewer = await viewerLogin();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const [
    authored,
    reviewRequested,
    authoredScope,
    reviewRequestedScope,
    authoredIssues,
    assignedIssues,
    ownedIssues,
  ] = await Promise.all([
    searchPullRequests("author", viewer, since),
    searchPullRequests("review-requested", viewer, since),
    searchScopeUrls("author"),
    searchScopeUrls("review-requested"),
    searchIssues("author", viewer, since),
    searchIssues("assignee", viewer, since),
    searchIssues("owner", viewer, since),
  ]);
  const issueMap = new Map<string, GitHubIssueItem>();
  const issueRoles = new Map<string, Set<GitHubIssueItem["role"]>>();
  const addRole = (id: string, role: GitHubIssueItem["role"]) => {
    const roles = issueRoles.get(id) ?? new Set<GitHubIssueItem["role"]>();
    issueRoles.set(id, roles.add(role));
  };
  for (const [role, result] of [
    ["owner", ownedIssues],
    ["assignee", assignedIssues],
    ["author", authoredIssues],
  ] as const) {
    for (const record of result.records) {
      issueMap.set(record.id, toIssueItem(record, role));
      addRole(record.id, role);
    }
  }
  const searchedAt = Date.now();
  const kept = previous?.viewer === viewer ? previous : undefined;
  const searches = [
    ["author", authoredIssues],
    ["assignee", assignedIssues],
    ["owner", ownedIssues],
  ] as const;
  const issueFreshAt = { author: 0, assignee: 0, owner: 0 };
  const issueTruncatedBy = { author: false, assignee: false, owner: false };
  const keptRoles = new Set<GitHubIssueItem["role"]>();
  for (const [role, result] of searches) {
    if (!result.failed) {
      issueFreshAt[role] = searchedAt;
      issueTruncatedBy[role] = result.records.length === SEARCH_LIMIT;
    } else if (kept) {
      issueFreshAt[role] = kept.issueFreshAt[role];
      if (searchedAt - issueFreshAt[role] <= MAX_STALE_MS) {
        keptRoles.add(role);
        issueTruncatedBy[role] = kept.issueTruncatedBy[role];
      }
    }
  }
  // A kept row keeps every role it matched whose search failed. A role whose search succeeded
  // without it has dropped it, but another failed role's search may still hold it.
  for (const item of kept?.issueItems ?? []) {
    let held = false;
    for (const role of kept?.issueRoles.get(item.id) ?? [item.role]) {
      if (!keptRoles.has(role)) continue;
      addRole(item.id, role);
      held = true;
    }
    // Fresh fields win over the kept row's.
    if (held && !issueMap.has(item.id)) issueMap.set(item.id, item);
  }
  // The row shows the highest-ranked role among all that matched.
  for (const [id, item] of issueMap) {
    const roles = [...(issueRoles.get(id) ?? [item.role])];
    const role = roles.reduce((best, next) =>
      ISSUE_ROLE_RANK[next] > ISSUE_ROLE_RANK[best] ? next : best,
    );
    issueMap.set(id, { ...item, role });
  }
  const issueTruncated = Object.values(issueTruncatedBy).some(Boolean);
  const issueSearchFailures = [authoredIssues, assignedIssues, ownedIssues].filter(
    (res) => res.failed,
  ).length;
  const issueItems = [...issueMap.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  const records = new Map<string, { record: SearchRecord; role: GitHubInboxItem["role"] }>();
  for (const record of reviewRequested) records.set(record.id, { record, role: "reviewer" });
  for (const record of authored) records.set(record.id, { record, role: "author" });
  const enrichment = await enrich([...records.keys()]);
  const inboxItems = [...records.values()].map(({ record, role }) =>
    toInboxItem(record, role, enrichment.states.get(record.id)),
  );

  // Change tracking reads the state only now, after the slow GitHub work, inside the queue.
  const key = String(windowDays);
  const acknowledgedAt = await updateState((stored) => {
    const previous = stored.windows[key] ?? { items: {}, pendingChanges: {}, acknowledgedAt: null };
    const initialized = Object.keys(previous.items).length > 0;
    const nextItems: Record<string, StoredItem> = {};
    const nextPending: Record<string, string[]> = {};
    for (const item of inboxItems) {
      const prior = previous.items[item.id];
      const state = enrichment.states.get(item.id);
      const detected =
        initialized && (!prior || enrichment.states.has(item.id)) ? detectChanges(prior, item) : [];
      item.changes = mergeChanges(previous.pendingChanges[item.id] ?? [], detected, {
        Checks:
          state?.statusCheckRollup === null || item.checksStatus !== "none"
            ? item.checksStatus
            : undefined,
        Review:
          state?.reviewDecision === null || item.reviewDecision !== null
            ? (item.reviewDecision ?? "none")
            : undefined,
        Mergeable:
          item.mergeable === "MERGEABLE" || item.mergeable === "CONFLICTING"
            ? item.mergeable.toLowerCase()
            : undefined,
        "Merge state":
          item.mergeStateStatus && item.mergeStateStatus.toUpperCase() !== "UNKNOWN"
            ? item.mergeStateStatus
            : undefined,
      });
      nextItems[item.id] = prior && !enrichment.states.has(item.id) ? prior : storedItem(item);
      if (item.changes.length > 0) nextPending[item.id] = item.changes;
    }
    stored.windows[key] = {
      items: nextItems,
      pendingChanges: nextPending,
      acknowledgedAt: previous.acknowledgedAt,
    };
    return previous.acknowledgedAt;
  });

  return {
    viewer,
    authored,
    reviewRequested,
    authoredScope,
    reviewRequestedScope,
    inboxItems,
    issueItems,
    issueRoles,
    issueTruncated,
    issueSearchFailures,
    issueFreshAt,
    issueTruncatedBy,
    enrichmentFailures: enrichment.failures,
    acknowledgedAt,
  };
}

/** The cheap part: shape a snapshot for the URLs this client knows about. */
export function projectSnapshot(snapshot: Snapshot, urls: string[]): ViewerScopeOutput {
  const requestedUrls = new Set(urls.map((url) => url.toLowerCase()));
  const withScope = (direct: SearchRecord[], scope: string[]) => [
    ...new Set([
      ...direct.map(({ url }) => url),
      ...scope.filter((url) => requestedUrls.has(url.toLowerCase())),
    ]),
  ];
  const notes: string[] = [];
  if (snapshot.enrichmentFailures > 0) {
    notes.push(
      `${snapshot.enrichmentFailures} GitHub detail request${snapshot.enrichmentFailures === 1 ? "" : "s"} failed; affected PRs use conservative states.`,
    );
  }
  if (snapshot.issueSearchFailures > 0) {
    notes.push(
      `${snapshot.issueSearchFailures} GitHub issue search request${snapshot.issueSearchFailures === 1 ? "" : "s"} failed; issue list may be stale or incomplete.`,
    );
  }
  const coverageNote =
    notes.length > 0
      ? notes.join(" ")
      : `Open PRs visible to the GitHub CLI. Organization SSO restrictions may omit results.`;
  return {
    viewer: snapshot.viewer,
    authoredUrls: withScope(snapshot.authored, snapshot.authoredScope),
    reviewRequestedUrls: withScope(snapshot.reviewRequested, snapshot.reviewRequestedScope),
    inboxItems: snapshot.inboxItems,
    issueItems: snapshot.issueItems,
    truncated:
      snapshot.authored.length === SEARCH_LIMIT ||
      snapshot.reviewRequested.length === SEARCH_LIMIT ||
      snapshot.issueTruncated,
    coverageNote,
    updates: snapshot.inboxItems.filter(({ changes }) => changes.length > 0).length,
    acknowledgedAt: snapshot.acknowledgedAt,
    error: null,
  };
}

function errorOutput(error: unknown): ViewerScopeOutput {
  return {
    viewer: null,
    authoredUrls: [],
    reviewRequestedUrls: [],
    inboxItems: [],
    truncated: false,
    coverageNote: "GitHub inbox data is unavailable.",
    updates: 0,
    acknowledgedAt: null,
    error: error instanceof Error ? error.message : "GitHub viewer scope is unavailable.",
  };
}

// ---------------------------------------------------------------------------
// Background cache. The plugin's server process is long-lived, so it keeps the last snapshot per
// window and refreshes it on a timer; client requests are answered from memory.
// ---------------------------------------------------------------------------

export const BACKGROUND_INTERVAL_MS = 2 * 60_000;
/** A request older than this triggers a refresh in the background (still answered from cache). */
export const STALE_AFTER_MS = 60_000;
/**
 * A snapshot older than this is not served: a refresh that keeps failing (auth lost, rate limited)
 * is reported instead of hiding behind old data. Entries are bounded by the 365 possible windows.
 */
export const MAX_STALE_MS = 3 * BACKGROUND_INTERVAL_MS;
/** Windows nobody has asked about for this long stop being refreshed, so an unused radar costs no GitHub calls. */
const WINDOW_IDLE_MS = 30 * 60_000;
/** Warmed at startup so the first open of the radar does not wait on GitHub. */
const DEFAULT_WINDOW_DAYS = 30;

const snapshots = new Map<number, { snapshot: Snapshot; at: number }>();
const inflight = new Map<number, Promise<Snapshot>>();
const lastRequested = new Map<number, number>([[DEFAULT_WINDOW_DAYS, Date.now()]]);

/** Single-flight refresh: concurrent callers share one GitHub sweep. */
function refreshWindow(windowDays: number): Promise<Snapshot> {
  const running = inflight.get(windowDays);
  if (running) return running;
  const started = Date.now();
  const promise = fetchSnapshot(windowDays, snapshots.get(windowDays)?.snapshot)
    .then((snapshot) => {
      snapshots.set(windowDays, { snapshot, at: Date.now() });
      console.log(
        `PR Radar: refreshed ${windowDays}d window in ${((Date.now() - started) / 1000).toFixed(1)}s (${snapshot.inboxItems.length} PRs)`,
      );
      return snapshot;
    })
    .finally(() => inflight.delete(windowDays));
  inflight.set(windowDays, promise);
  return promise;
}

function refreshInBackground(windowDays: number): void {
  refreshWindow(windowDays).catch((error) => {
    // Keep serving the last good snapshot until it passes MAX_STALE_MS.
    console.error(`PR Radar: background refresh of ${windowDays}d window failed`, error);
  });
}

/** Starts the refresh timer; returns a stop function for the plugin's cleanup. */
export function startBackgroundRefresh(intervalMs = BACKGROUND_INTERVAL_MS): () => void {
  const tick = () => {
    const now = Date.now();
    for (const [windowDays, requestedAt] of lastRequested) {
      if (now - requestedAt > WINDOW_IDLE_MS) {
        lastRequested.delete(windowDays);
        continue;
      }
      refreshInBackground(windowDays);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function resolveViewerScope({
  urls,
  windowDays,
}: z.output<typeof viewerScope.input>): Promise<ViewerScopeOutput> {
  lastRequested.set(windowDays, Date.now());
  const cached = snapshots.get(windowDays);
  if (cached && Date.now() - cached.at <= MAX_STALE_MS) {
    if (Date.now() - cached.at > STALE_AFTER_MS) refreshInBackground(windowDays);
    return projectSnapshot(cached.snapshot, urls);
  }
  // First request for this window, or its snapshot expired: wait once.
  try {
    return projectSnapshot(await refreshWindow(windowDays), urls);
  } catch (error) {
    console.error("PR Radar GitHub inbox refresh failed", error);
    return errorOutput(error);
  }
}

/** Test seam: waits for running refreshes to finish, keeping the cache. */
export async function settleViewerScopeRefreshes(): Promise<void> {
  await Promise.allSettled([...inflight.values()]);
  await stateQueue;
}

/** Test seam: waits for running refreshes so tests do not bleed into each other. */
export async function resetViewerScopeCache(): Promise<void> {
  await Promise.allSettled([...inflight.values()]);
  await stateQueue;
  snapshots.clear();
  inflight.clear();
  lastRequested.clear();
  lastRequested.set(DEFAULT_WINDOW_DAYS, Date.now());
}

export async function acknowledgeViewerUpdates({
  windowDays,
}: z.output<typeof acknowledgeViewerScope.input>): Promise<
  z.input<typeof acknowledgeViewerScope.output>
> {
  const key = String(windowDays);
  const acknowledgedAt = new Date().toISOString();
  await updateState((state) => {
    const current = state.windows[key] ?? { items: {}, pendingChanges: {}, acknowledgedAt: null };
    state.windows[key] = { ...current, pendingChanges: {}, acknowledgedAt };
  });
  // Keep the cached snapshot in step so the badge clears without waiting for a refresh.
  const cached = snapshots.get(windowDays);
  if (cached) {
    cached.snapshot = {
      ...cached.snapshot,
      acknowledgedAt,
      inboxItems: cached.snapshot.inboxItems.map((item) => ({ ...item, changes: [] })),
    };
  }
  return { acknowledgedAt };
}
