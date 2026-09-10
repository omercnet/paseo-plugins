import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import type { acknowledgeViewerScope, GitHubInboxItem, viewerScope } from "../shared/viewer-scope";

const execFileAsync = promisify(execFile);
const SEARCH_LIMIT = 100;
const ENRICHMENT_BATCH_SIZE = 20;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const statePath = join(homedir(), ".paseo", "plugin-data", "pr-radar", "inbox-state.json");
const SCOPE_SEARCH_LIMIT = 1000;

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
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
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
  const output = await runGh([
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

async function searchScopeUrls(filter: "author" | "review-requested"): Promise<string[]> {
  const output = await runGh([
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
  };
}

async function readState(): Promise<StoredState> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as StoredState;
    if (state.version === 2 && state.windows && typeof state.windows === "object") return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("PR Radar ignored unreadable inbox state", error);
    }
  }
  return { version: 2, windows: {} };
}

async function writeState(state: StoredState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
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

export async function resolveViewerScope({
  urls,
  windowDays,
}: z.output<typeof viewerScope.input>): Promise<z.input<typeof viewerScope.output>> {
  try {
    const viewer = await viewerLogin();
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    const [authored, reviewRequested, authoredScope, reviewRequestedScope, stored] =
      await Promise.all([
        searchPullRequests("author", viewer, since),
        searchPullRequests("review-requested", viewer, since),
        searchScopeUrls("author"),
        searchScopeUrls("review-requested"),
        readState(),
      ]);
    const records = new Map<string, { record: SearchRecord; role: GitHubInboxItem["role"] }>();
    for (const record of reviewRequested) records.set(record.id, { record, role: "reviewer" });
    for (const record of authored) records.set(record.id, { record, role: "author" });
    const enrichment = await enrich([...records.keys()]);
    const inboxItems = [...records.values()].map(({ record, role }) =>
      toInboxItem(record, role, enrichment.states.get(record.id)),
    );

    const key = String(windowDays);
    const previous = stored.windows[key] ?? { items: {}, pendingChanges: {}, acknowledgedAt: null };
    const initialized = Object.keys(previous.items).length > 0;
    const nextItems: Record<string, StoredItem> = {};
    const nextPending: Record<string, string[]> = {};
    for (const item of inboxItems) {
      const prior = previous.items[item.id];
      const detected =
        initialized && (!prior || enrichment.states.has(item.id)) ? detectChanges(prior, item) : [];
      item.changes = [...new Set([...(previous.pendingChanges[item.id] ?? []), ...detected])];
      nextItems[item.id] = prior && !enrichment.states.has(item.id) ? prior : storedItem(item);
      if (item.changes.length > 0) nextPending[item.id] = item.changes;
    }
    stored.windows[key] = {
      items: nextItems,
      pendingChanges: nextPending,
      acknowledgedAt: previous.acknowledgedAt,
    };
    await writeState(stored);

    const requestedUrls = new Set(urls.map((url) => url.toLowerCase()));
    const authoredUrls = new Set([
      ...authored.map(({ url }) => url),
      ...authoredScope.filter((url) => requestedUrls.has(url.toLowerCase())),
    ]);
    const reviewRequestedUrls = new Set([
      ...reviewRequested.map(({ url }) => url),
      ...reviewRequestedScope.filter((url) => requestedUrls.has(url.toLowerCase())),
    ]);
    const coverageNote =
      enrichment.failures > 0
        ? `${enrichment.failures} GitHub detail request${enrichment.failures === 1 ? "" : "s"} failed; affected PRs use conservative states.`
        : `Open PRs visible to the GitHub CLI. Organization SSO restrictions may omit results.`;
    return {
      viewer,
      authoredUrls: [...authoredUrls],
      reviewRequestedUrls: [...reviewRequestedUrls],
      inboxItems,
      truncated: authored.length === SEARCH_LIMIT || reviewRequested.length === SEARCH_LIMIT,
      coverageNote,
      updates: inboxItems.filter(({ changes }) => changes.length > 0).length,
      acknowledgedAt: previous.acknowledgedAt,
      error: null,
    };
  } catch (error) {
    console.error("PR Radar GitHub inbox refresh failed", error);
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
}

export async function acknowledgeViewerUpdates({
  windowDays,
}: z.output<typeof acknowledgeViewerScope.input>): Promise<
  z.input<typeof acknowledgeViewerScope.output>
> {
  const state = await readState();
  const key = String(windowDays);
  const acknowledgedAt = new Date().toISOString();
  const current = state.windows[key] ?? { items: {}, pendingChanges: {}, acknowledgedAt: null };
  state.windows[key] = { ...current, pendingChanges: {}, acknowledgedAt };
  await writeState(state);
  return { acknowledgedAt };
}
