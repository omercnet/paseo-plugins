import { type BeadSummary, type BeadsSnapshot, getWorkspaceBead } from "../shared/beads";

export const BEAD_LANES = ["ready", "in_progress", "blocked", "other"] as const;

export type BeadLane = (typeof BEAD_LANES)[number];

export const BEAD_LANE_TITLES: Record<BeadLane, string> = {
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  other: "Other",
};

export const BEAD_LANE_METADATA: readonly { id: BeadLane; title: string }[] = BEAD_LANES.map(
  (id) => ({ id, title: BEAD_LANE_TITLES[id] }),
);

export type BeadsFilter = "all" | "high_priority" | "assigned";

export interface BeadsViewOptions {
  query?: string;
  filter?: BeadsFilter;
}

export type BeadLanes = Record<BeadLane, BeadSummary[]>;
export type BeadLaneCounts = Record<BeadLane, number>;

export interface BeadsView {
  lanes: BeadLanes;
  counts: BeadLaneCounts;
}

export interface BeadSection {
  lane: BeadLane;
  title: string;
  data: BeadSummary[];
}

export function buildBeadSections(view: BeadsView, activeFiltering: boolean): BeadSection[] {
  const sections: BeadSection[] = [];

  for (const lane of BEAD_LANES) {
    const data = view.lanes[lane];
    if (activeFiltering && data.length === 0) continue;

    sections.push({
      lane,
      title: lane === "ready" ? "Ready frontier" : BEAD_LANE_TITLES[lane],
      data,
    });
  }

  return sections;
}

export function issueAccessibilityLabel(issue: BeadSummary, lane: BeadLane): string {
  const laneDescription = lane === "ready" ? "Ready frontier" : `${BEAD_LANE_TITLES[lane]} lane`;
  const assigneeDescription = issue.assignee ? `Assigned to ${issue.assignee}` : "Unassigned";
  const activity: string[] = [];

  if (issue.dependencyCount > 0) {
    activity.push(
      `${issue.dependencyCount} ${issue.dependencyCount === 1 ? "dependency" : "dependencies"}`,
    );
  }
  if (issue.dependentCount > 0) {
    activity.push(
      `${issue.dependentCount} ${issue.dependentCount === 1 ? "dependent" : "dependents"}`,
    );
  }
  if (issue.commentCount > 0) {
    activity.push(`${issue.commentCount} ${issue.commentCount === 1 ? "comment" : "comments"}`);
  }

  const descriptions = [
    `Open issue ${issue.id}: ${issue.title}`,
    `Priority P${issue.priority}`,
    laneDescription,
    `Issue type ${issue.issueType}`,
    assigneeDescription,
    ...activity,
  ];

  return `${descriptions.join(". ")}.`;
}

export function beadLaneFor(issue: BeadSummary): BeadLane {
  if (issue.status === "in_progress" || issue.status === "hooked") return "in_progress";
  if (issue.isBlocked) return "blocked";
  if (issue.isReady) return "ready";
  return "other";
}

function matchesSearch(issue: BeadSummary, query: string): boolean {
  if (!query) return true;
  if (issue.id.toLowerCase().includes(query)) return true;
  if (issue.title.toLowerCase().includes(query)) return true;
  if (issue.assignee?.toLowerCase().includes(query)) return true;
  return issue.labels.some((label) => label.toLowerCase().includes(query));
}

function matchesFilter(issue: BeadSummary, filter: BeadsFilter): boolean {
  if (filter === "high_priority") return issue.priority <= 1;
  if (filter === "assigned") return issue.assignee !== null;
  return true;
}

function updatedTimestamp(updatedAt: string | null): number {
  if (updatedAt === null) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareBeads(left: BeadSummary, right: BeadSummary): number {
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) return byPriority;

  const leftUpdatedAt = updatedTimestamp(left.updatedAt);
  const rightUpdatedAt = updatedTimestamp(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt > leftUpdatedAt ? 1 : -1;

  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function buildBeadsView(
  issues: readonly BeadSummary[],
  options: BeadsViewOptions = {},
): BeadsView {
  const lanes: BeadLanes = {
    ready: [],
    in_progress: [],
    blocked: [],
    other: [],
  };
  const counts: BeadLaneCounts = {
    ready: 0,
    in_progress: 0,
    blocked: 0,
    other: 0,
  };
  const query = options.query?.trim().toLowerCase() ?? "";
  const filter = options.filter ?? "all";

  for (const issue of issues) {
    const lane = beadLaneFor(issue);
    counts[lane] += 1;
    if (matchesFilter(issue, filter) && matchesSearch(issue, query)) lanes[lane].push(issue);
  }

  for (const lane of BEAD_LANES) lanes[lane].sort(compareBeads);

  return { lanes, counts };
}

export const BEAD_SCREEN_ID = "bead";

/** Reads bead screen params (`{ workspace, bead }`) with the detail RPC's own input rules. */
export function parseBeadScreenParams(params: Readonly<Record<string, string>>) {
  const parsed = getWorkspaceBead.input.safeParse({
    workspaceId: params.workspace,
    issueId: params.bead,
  });
  return parsed.success ? parsed.data : null;
}

/** Shared by the panel and the sidebar count, so either one reuses the other's snapshot. */
export function beadsSnapshotQueryKey(hostId: string, workspaceId: string) {
  return ["paseo-beads", "snapshot", hostId, workspaceId] as const;
}

export interface ReadyBeadsWorkspace {
  id: string;
  projectDisplayName: string;
  name: string;
}

export interface ReadyBeadsSummary {
  /** Ready beads across every workspace that loaded. */
  count: number;
  /** The top ready beads, grouped under the workspace each one is listed for. */
  groups: { workspace: ReadyBeadsWorkspace; beads: BeadSummary[] }[];
  /** Workspaces whose snapshot failed to load. */
  failed: number;
  /** Workspaces on a host that cannot run `bd`. */
  unavailable: number;
}

/**
 * Worktrees read their checkout's Beads database, and Paseo can register a worktree as a project
 * of its own, so one issue can arrive from several workspaces. An issue is identified by its ID
 * and title: it counts once and is listed under the first workspace that reported it.
 */
export function summarizeReadyBeads(
  entries: readonly { workspace: ReadyBeadsWorkspace; snapshot: BeadsSnapshot | null }[],
  limit: number,
): ReadyBeadsSummary {
  const seen = new Set<string>();
  const ready: { workspace: ReadyBeadsWorkspace; bead: BeadSummary }[] = [];
  let failed = 0;
  let unavailable = 0;

  for (const { workspace, snapshot } of entries) {
    if (!snapshot) failed += 1;
    else if (snapshot.state === "bd_unavailable") unavailable += 1;
    for (const bead of snapshot?.issues ?? []) {
      const key = JSON.stringify([bead.id, bead.title]);
      if (beadLaneFor(bead) !== "ready" || seen.has(key)) continue;
      seen.add(key);
      ready.push({ workspace, bead });
    }
  }
  ready.sort((left, right) => compareBeads(left.bead, right.bead));

  const groups = new Map<string, ReadyBeadsSummary["groups"][number]>();
  for (const { workspace, bead } of ready.slice(0, limit)) {
    const group = groups.get(workspace.id) ?? { workspace, beads: [] };
    group.beads.push(bead);
    groups.set(workspace.id, group);
  }

  return { count: ready.length, groups: [...groups.values()], failed, unavailable };
}

export interface ReadyBeadsNotes {
  /** Replaces the list when no ready bead was found; qualified when the result is incomplete. */
  empty: string | null;
  /** Caveats about the result, shown below it. */
  notices: string[];
}

/** `refreshError` is the message of a failed refresh that left the previous result in place. */
export function describeReadyBeads(
  { count, failed, unavailable }: ReadyBeadsSummary,
  refreshError: string | null,
): ReadyBeadsNotes {
  const notices: string[] = [];
  if (refreshError) notices.push(`Refresh failed, showing the last result. ${refreshError}`);
  if (failed > 0) {
    notices.push(`${failed === 1 ? "1 workspace" : `${failed} workspaces`} could not be read.`);
  }

  let empty: string | null = null;
  if (count === 0) {
    if (unavailable > 0) empty = "The bd CLI is not available on this Paseo host.";
    else if (failed > 0 || refreshError) {
      empty = "No ready beads found in the workspaces that could be checked.";
    } else empty = "No ready beads in any workspace on this host.";
  }
  return { empty, notices };
}
