import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { BeadsSnapshot } from "../shared/beads";
import {
  beadsSnapshotQueryKey,
  type ReadyBeadsSummary,
  type ReadyBeadsWorkspace,
  summarizeReadyBeads,
} from "./beads-view";

/** How many ready beads the popover lists; the sidebar count covers all of them. */
export const READY_LIST_LIMIT = 10;
/** The panel's polling interval: a snapshot an open panel just read is reused, not refetched. */
const SNAPSHOT_FRESH_MS = 10_000;
/** A workspace without Beads is rechecked this rarely: it seldom changes and each check runs bd. */
const NO_BEADS_FRESH_MS = 5 * 60_000;
/** How long a successful read vouches for the database a workspace reads. */
const DATABASE_MEMORY_MS = 10 * 60_000;

/**
 * The database a workspace was last confirmed to read, or null when nothing vouches for it. The
 * cache cannot decide this on its own: `gcTime` only drops queries nobody observes, and an open
 * panel keeps a failing query's old data indefinitely. So the data must not be invalidated (a
 * failed refresh keeps the old data but flags it) and must be recent.
 */
function confirmedDatabase(queryClient: QueryClient, queryKey: QueryKey): string | null {
  const state = queryClient.getQueryState<BeadsSnapshot>(queryKey);
  if (!state || state.isInvalidated) return null;
  if (Date.now() - state.dataUpdatedAt > DATABASE_MEMORY_MS) return null;
  return state.data?.databaseId ?? null;
}

export interface ReadyBeadsScan {
  hostId: string;
  /** Stops the scan from starting more workspace reads once its query is cancelled. */
  signal: AbortSignal;
  queryClient: QueryClient;
  listWorkspaces(): Promise<readonly ReadyBeadsWorkspace[]>;
  loadSnapshot(input: { workspaceId: string }): Promise<BeadsSnapshot>;
}

/**
 * Reads each workspace's Beads snapshot through the cache the panel polls, and summarizes the
 * ready beads. A workspace is skipped only when it is confirmed to read a database that this scan
 * has read, so the first scan reads every workspace and learns which ones share a database (git
 * worktrees do), and later scans read each database once. A workspace that cannot be read counts
 * as failed.
 */
export async function scanReadyBeads({
  hostId,
  signal,
  queryClient,
  listWorkspaces,
  loadSnapshot,
}: ReadyBeadsScan): Promise<ReadyBeadsSummary> {
  const readDatabases = new Set<string>();
  const loaded: { workspace: ReadyBeadsWorkspace; snapshot: BeadsSnapshot | null }[] = [];
  // ponytail: first page of the workspace list (up to 200), read one at a time so bd load stays
  // flat. Add a small pool if the count lags on hosts with many Beads projects.
  for (const workspace of await listWorkspaces()) {
    if (signal.aborted) throw new Error("The ready beads scan was cancelled.");
    const queryKey = beadsSnapshotQueryKey(hostId, workspace.id);
    const knownDatabase = confirmedDatabase(queryClient, queryKey);
    if (knownDatabase && readDatabases.has(knownDatabase)) continue;
    // fetchQuery, not query(): the host app's query-core (5.90) has no query().
    const snapshot = await queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => loadSnapshot({ workspaceId: workspace.id }),
        staleTime: (query) =>
          query.state.data?.state === "not_initialized" ? NO_BEADS_FRESH_MS : SNAPSHOT_FRESH_MS,
        gcTime: DATABASE_MEMORY_MS, // storage cleanup only; confirmedDatabase enforces the age
      })
      .catch(() => null);
    if (snapshot?.databaseId) readDatabases.add(snapshot.databaseId);
    loaded.push({ workspace, snapshot });
  }
  return summarizeReadyBeads(loaded, READY_LIST_LIMIT);
}
