import { describe, expect, test } from "bun:test";
import {
  type BeadsView,
  buildBeadSections,
  buildBeadsView,
  issueAccessibilityLabel,
} from "../client/beads-view";
import type { BeadSummary } from "../shared/beads";

function bead(id: string, overrides: Partial<BeadSummary> = {}): BeadSummary {
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

function ids(issues: readonly BeadSummary[]): string[] {
  return issues.map((issue) => issue.id);
}

describe("beads lanes", () => {
  test("puts open issues blocked by dependencies in the blocked lane", () => {
    const dependencyBlocked = bead("blocked-by-dependency", {
      dependencyCount: 2,
      isReady: false,
      isBlocked: true,
    });

    const view = buildBeadsView([dependencyBlocked]);

    expect(ids(view.lanes.blocked)).toEqual(["blocked-by-dependency"]);
    expect(view.counts.blocked).toBe(1);
  });

  test("applies in-progress, blocked, ready, then other precedence", () => {
    const view = buildBeadsView([
      bead("in-progress", { status: "in_progress", isBlocked: true, isReady: true }),
      bead("hooked", { status: "hooked", isBlocked: true, isReady: true }),
      bead("blocked", { isBlocked: true, isReady: true }),
      bead("ready"),
      bead("other", { status: "closed", isReady: false }),
    ]);

    expect(ids(view.lanes.in_progress)).toEqual(["hooked", "in-progress"]);
    expect(ids(view.lanes.blocked)).toEqual(["blocked"]);
    expect(ids(view.lanes.ready)).toEqual(["ready"]);
    expect(ids(view.lanes.other)).toEqual(["other"]);
  });
});

describe("beads search and filters", () => {
  const searchable = [
    bead("BD-SEARCH-ID", { title: "Identifier match" }),
    bead("title-match", { title: "Database Migration" }),
    bead("assignee-match", { assignee: "Alice" }),
    bead("label-match", { labels: ["Needs-Review"] }),
    bead("unrelated", { title: "Unrelated work" }),
  ];

  test.each([
    ["search-id", "BD-SEARCH-ID"],
    ["DATABASE", "title-match"],
    ["ALI", "assignee-match"],
    ["review", "label-match"],
  ])("searches id, title, assignee, and labels case-insensitively", (query, expectedId) => {
    const view = buildBeadsView(searchable, { query });

    expect(ids(view.lanes.ready)).toEqual([expectedId]);
  });

  test("filters to high-priority issues", () => {
    const issues = [
      bead("critical", { priority: 0 }),
      bead("high", { priority: 1 }),
      bead("normal", { priority: 2 }),
    ];

    expect(ids(buildBeadsView(issues, { filter: "high_priority" }).lanes.ready)).toEqual([
      "critical",
      "high",
    ]);
  });

  test("filters to assigned issues", () => {
    const issues = [
      bead("assigned", { assignee: "octocat" }),
      bead("unassigned", { assignee: null }),
    ];

    expect(ids(buildBeadsView(issues, { filter: "assigned" }).lanes.ready)).toEqual(["assigned"]);
  });
});

describe("beads ordering and counts", () => {
  test("sorts by priority, most recently updated, then id", () => {
    const issues = [
      bead("priority-one-old", { priority: 1, updatedAt: "2026-08-01T00:00:00.000Z" }),
      bead("same-time-b", { priority: 1, updatedAt: "2026-09-02T00:00:00.000Z" }),
      bead("no-update", { priority: 1, updatedAt: null }),
      bead("priority-zero", { priority: 0, updatedAt: "2026-01-01T00:00:00.000Z" }),
      bead("same-time-a", { priority: 1, updatedAt: "2026-09-02T00:00:00.000Z" }),
    ];

    expect(ids(buildBeadsView(issues).lanes.ready)).toEqual([
      "priority-zero",
      "same-time-a",
      "same-time-b",
      "priority-one-old",
      "no-update",
    ]);
  });

  test("keeps lane counts unfiltered by search and the selected filter", () => {
    const issues = [
      bead("visible-ready", { priority: 0 }),
      bead("hidden-progress", { status: "in_progress", priority: 3 }),
      bead("hidden-blocked", { isReady: false, isBlocked: true, priority: 3 }),
      bead("hidden-other", { status: "closed", isReady: false, priority: 3 }),
    ];

    const view = buildBeadsView(issues, { filter: "high_priority", query: "visible" });

    expect(view.counts).toEqual({ ready: 1, in_progress: 1, blocked: 1, other: 1 });
    expect(ids(view.lanes.ready)).toEqual(["visible-ready"]);
    expect(view.lanes.in_progress).toEqual([]);
    expect(view.lanes.blocked).toEqual([]);
    expect(view.lanes.other).toEqual([]);
  });
});

describe("bead sections", () => {
  const view: BeadsView = {
    lanes: {
      ready: [bead("ready")],
      in_progress: [],
      blocked: [bead("blocked", { isBlocked: true, isReady: false })],
      other: [],
    },
    counts: { ready: 91, in_progress: 82, blocked: 73, other: 64 },
  };

  test("preserves lane order, titles, and lane data without filtering", () => {
    const sections = buildBeadSections(view, false);

    expect(sections.map(({ lane, title, data }) => ({ lane, title, issueIds: ids(data) }))).toEqual(
      [
        { lane: "ready", title: "Ready frontier", issueIds: ["ready"] },
        { lane: "in_progress", title: "In progress", issueIds: [] },
        { lane: "blocked", title: "Blocked", issueIds: ["blocked"] },
        { lane: "other", title: "Other", issueIds: [] },
      ],
    );
    expect(sections[0]?.data).toBe(view.lanes.ready);
    expect(sections[2]?.data).toBe(view.lanes.blocked);
  });

  test("omits only empty lane data while filtering", () => {
    expect(buildBeadSections(view, true).map(({ lane }) => lane)).toEqual(["ready", "blocked"]);
  });
});

describe("issue accessibility labels", () => {
  test("announces every triage field with singular activity wording", () => {
    const issue = bead("BD-42", {
      title: "Repair workspace sync",
      priority: 1,
      issueType: "bug",
      assignee: "alice",
      dependencyCount: 1,
      dependentCount: 1,
      commentCount: 1,
    });

    expect(issueAccessibilityLabel(issue, "ready")).toBe(
      "Open issue BD-42: Repair workspace sync. Priority P1. Ready frontier. Issue type bug. Assigned to alice. 1 dependency. 1 dependent. 1 comment.",
    );
  });

  test("uses plural activity wording", () => {
    const issue = bead("BD-43", {
      dependencyCount: 2,
      dependentCount: 3,
      commentCount: 4,
    });

    expect(issueAccessibilityLabel(issue, "in_progress")).toBe(
      "Open issue BD-43: Issue BD-43. Priority P2. In progress lane. Issue type task. Unassigned. 2 dependencies. 3 dependents. 4 comments.",
    );
  });

  test("announces unassigned lane placement and omits zero activity", () => {
    const issue = bead("BD-44", { title: "Waiting for input", isBlocked: true, isReady: false });

    expect(issueAccessibilityLabel(issue, "blocked")).toBe(
      "Open issue BD-44: Waiting for input. Priority P2. Blocked lane. Issue type task. Unassigned.",
    );
  });
});
