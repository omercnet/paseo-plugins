import type { BeadSummary } from "../shared/beads";

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
