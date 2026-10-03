import type { BeadSummary, BeadsSnapshot } from "../shared/beads";

export function bead(id: string, overrides: Partial<BeadSummary> = {}): BeadSummary {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    labels: [],
    parent: null,
    updatedAt: "2026-09-01T12:00:00.000Z",
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0,
    isReady: true,
    isBlocked: false,
    ...overrides,
  };
}

export function snapshot(
  issues: BeadSummary[],
  state: BeadsSnapshot["state"] = "ready",
): BeadsSnapshot {
  return {
    state,
    issues,
    truncated: false,
    refreshedAt: "2026-09-01T12:00:00.000Z",
    message: null,
  };
}
