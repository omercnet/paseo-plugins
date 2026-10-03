import type { QueryClient } from "@tanstack/react-query";
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
/** How long a workspace remembers which database it reads; it is skipped only while this lasts. */
const DATABASE_MEMORY_MS = 10 * 60_000;

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
 * ready beads. A workspace is skipped only when it is already known to read a database that this
 * scan has read, so the first scan reads every workspace and learns which ones share a database
 * (git worktrees do), and later scans read each database once. A workspace that cannot be read
 * counts as failed.
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
    const knownDatabase = queryClient.getQueryData<BeadsSnapshot>(queryKey)?.databaseId;
    if (knownDatabase && readDatabases.has(knownDatabase)) continue;
    // fetchQuery, not query(): the host app's query-core (5.90) has no query().
    const snapshot = await queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => loadSnapshot({ workspaceId: workspace.id }),
        staleTime: (query) =>
          query.state.data?.state === "not_initialized" ? NO_BEADS_FRESH_MS : SNAPSHOT_FRESH_MS,
        gcTime: DATABASE_MEMORY_MS,
      })
      .catch(() => null);
    if (snapshot?.databaseId) readDatabases.add(snapshot.databaseId);
    loaded.push({ workspace, snapshot });
  }
  return summarizeReadyBeads(loaded, READY_LIST_LIMIT);
}
