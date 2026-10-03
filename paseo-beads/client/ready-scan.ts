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

/** The fields of a listed Paseo workspace that the scan reads. */
export interface ListedWorkspace extends ReadyBeadsWorkspace {
  projectId: string;
  workspaceKind: string;
}

/**
 * Worktrees read their checkout's Beads database, so a project needs one workspace read, not one
 * per worktree: every checkout, or the first worktree when the project lists none.
 */
export function pickBeadsWorkspaces<T extends Pick<ListedWorkspace, "projectId" | "workspaceKind">>(
  workspaces: readonly T[],
): T[] {
  const checkoutProjects = new Set(
    workspaces
      .filter(({ workspaceKind }) => workspaceKind !== "worktree")
      .map(({ projectId }) => projectId),
  );
  const readWorktreeProjects = new Set<string>();
  return workspaces.filter(({ projectId, workspaceKind }) => {
    if (workspaceKind !== "worktree") return true;
    if (checkoutProjects.has(projectId) || readWorktreeProjects.has(projectId)) return false;
    readWorktreeProjects.add(projectId);
    return true;
  });
}

export interface ReadyBeadsScan {
  hostId: string;
  /** Stops the scan from starting more workspace reads once its query is cancelled. */
  signal: AbortSignal;
  queryClient: QueryClient;
  listWorkspaces(): Promise<readonly ListedWorkspace[]>;
  loadSnapshot(input: { workspaceId: string }): Promise<BeadsSnapshot>;
}

/**
 * Reads the Beads snapshot of each project's workspaces through the cache the panel polls, and
 * summarizes the ready beads. A workspace that cannot be read counts as failed.
 */
export async function scanReadyBeads({
  hostId,
  signal,
  queryClient,
  listWorkspaces,
  loadSnapshot,
}: ReadyBeadsScan): Promise<ReadyBeadsSummary> {
  const loaded: { workspace: ListedWorkspace; snapshot: BeadsSnapshot | null }[] = [];
  // ponytail: first page of the workspace list (up to 200), read one at a time so bd load stays
  // flat. Add a small pool if the count lags on hosts with many Beads projects.
  for (const workspace of pickBeadsWorkspaces(await listWorkspaces())) {
    if (signal.aborted) throw new Error("The ready beads scan was cancelled.");
    // fetchQuery, not query(): the host app's query-core (5.90) has no query().
    const snapshot = await queryClient
      .fetchQuery({
        queryKey: beadsSnapshotQueryKey(hostId, workspace.id),
        queryFn: () => loadSnapshot({ workspaceId: workspace.id }),
        staleTime: SNAPSHOT_FRESH_MS,
      })
      .catch(() => null);
    loaded.push({ workspace, snapshot });
  }
  return summarizeReadyBeads(loaded, READY_LIST_LIMIT);
}
