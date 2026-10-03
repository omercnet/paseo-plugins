import { describe, expect, test } from "vitest";
import {
  type BeadsView,
  buildBeadSections,
  buildBeadsView,
  describeReadyBeads,
  issueAccessibilityLabel,
  parseBeadScreenParams,
  type ReadyBeadsSummary,
  type ReadyBeadsWorkspace,
  summarizeReadyBeads,
} from "../client/beads-view";
import type { BeadSummary } from "../shared/beads";
import { bead, snapshot } from "./fixtures";

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

describe("ready beads summary", () => {
  function workspace(id: string, project = "project-a"): ReadyBeadsWorkspace {
    return { id, projectDisplayName: project, name: id };
  }

  function grouped({ groups }: ReadyBeadsSummary) {
    return groups.map((group) => [group.workspace.id, ids(group.beads)]);
  }

  test("counts only the ready frontier", () => {
    const summary = summarizeReadyBeads(
      [
        {
          workspace: workspace("main"),
          snapshot: snapshot([
            bead("ready"),
            bead("claimed", { status: "in_progress" }),
            bead("blocked", { isReady: false, isBlocked: true }),
            bead("deferred", { status: "deferred", isReady: false }),
          ]),
        },
      ],
      10,
    );

    expect(summary.count).toBe(1);
    expect(grouped(summary)).toEqual([["main", ["ready"]]]);
  });

  test("counts an issue once however many workspaces read its database", () => {
    const summary = summarizeReadyBeads(
      [
        {
          workspace: workspace("feature"),
          snapshot: snapshot([bead("a-1", { priority: 1 })], { databaseId: "db-a" }),
        },
        {
          workspace: workspace("main"),
          snapshot: snapshot([bead("a-1", { priority: 1 }), bead("a-2")], { databaseId: "db-a" }),
        },
      ],
      10,
    );

    expect(summary.count).toBe(2);
    expect(grouped(summary)).toEqual([
      ["feature", ["a-1"]],
      ["main", ["a-2"]],
    ]);
  });

  test("does not take a rename between two reads of one database for a second issue", () => {
    const summary = summarizeReadyBeads(
      [
        {
          workspace: workspace("feature"),
          snapshot: snapshot([bead("a-1", { title: "Fix login" })], { databaseId: "db-a" }),
        },
        {
          workspace: workspace("main"),
          snapshot: snapshot([bead("a-1", { title: "Fix sign-in" })], { databaseId: "db-a" }),
        },
      ],
      10,
    );

    expect(summary.count).toBe(1);
  });

  test("keeps issues from different databases that share an ID and a title", () => {
    const summary = summarizeReadyBeads(
      [
        {
          workspace: workspace("web"),
          snapshot: snapshot([bead("app-1")], { databaseId: "db-web" }),
        },
        {
          workspace: workspace("api"),
          snapshot: snapshot([bead("app-1")], { databaseId: "db-api" }),
        },
      ],
      10,
    );

    expect(summary.count).toBe(2);
  });

  test("treats a snapshot that cannot name its database as having one of its own", () => {
    const summary = summarizeReadyBeads(
      [
        { workspace: workspace("one"), snapshot: snapshot([bead("a-1")]) },
        { workspace: workspace("two"), snapshot: snapshot([bead("a-1")]) },
      ],
      10,
    );

    expect(summary.count).toBe(2);
  });

  test("skips workspaces without Beads and tells unreadable ones from unavailable bd", () => {
    const summary = summarizeReadyBeads(
      [
        { workspace: workspace("plain"), snapshot: snapshot([], { state: "not_initialized" }) },
        { workspace: workspace("no-bd"), snapshot: snapshot([], { state: "bd_unavailable" }) },
        { workspace: workspace("broken"), snapshot: null },
        { workspace: workspace("beads", "project-b"), snapshot: snapshot([bead("b-1")]) },
      ],
      10,
    );

    expect(summary).toMatchObject({ count: 1, failed: 1, unavailable: 1 });
    expect(grouped(summary)).toEqual([["beads", ["b-1"]]]);
  });

  test("lists the top ready beads by priority and still counts the rest", () => {
    const summary = summarizeReadyBeads(
      [
        {
          workspace: workspace("main"),
          snapshot: snapshot([bead("a-low", { priority: 3 }), bead("a-high", { priority: 1 })]),
        },
        {
          workspace: workspace("api", "project-b"),
          snapshot: snapshot([bead("b-urgent", { priority: 0 })]),
        },
      ],
      2,
    );

    expect(summary.count).toBe(3);
    expect(grouped(summary)).toEqual([
      ["api", ["b-urgent"]],
      ["main", ["a-high"]],
    ]);
  });
});

describe("ready beads notes", () => {
  function summary(overrides: Partial<ReadyBeadsSummary>): ReadyBeadsSummary {
    return { count: 0, groups: [], failed: 0, unavailable: 0, ...overrides };
  }

  test("claims an empty host only when every workspace was checked", () => {
    const { empty, notices } = describeReadyBeads(summary({}), null);

    expect(empty).toContain("No ready beads in any workspace");
    expect(notices).toEqual([]);
  });

  test("blames the host, not the workspaces, when bd is unavailable", () => {
    const { empty } = describeReadyBeads(summary({ unavailable: 3 }), null);

    expect(empty).toContain("bd CLI is not available");
  });

  test("qualifies an empty result when workspaces could not be read", () => {
    const one = describeReadyBeads(summary({ failed: 1 }), null);
    const many = describeReadyBeads(summary({ failed: 2 }), null);

    expect(one.empty).not.toContain("any workspace");
    expect(one.notices).toEqual(["1 workspace could not be read."]);
    expect(many.notices).toEqual(["2 workspaces could not be read."]);
  });

  test("reports a failed refresh next to the previous result", () => {
    const withReady = describeReadyBeads(summary({ count: 3 }), "Request timed out.");
    const withNone = describeReadyBeads(summary({}), "Request timed out.");

    expect(withReady.empty).toBeNull();
    expect(withReady.notices).toEqual([
      "Refresh failed, showing the last result. Request timed out.",
    ]);
    expect(withNone.empty).not.toContain("any workspace");
  });

  test("warns when bd was unavailable for some workspaces while others have ready beads", () => {
    const one = describeReadyBeads(summary({ count: 2, unavailable: 1 }), null);
    const many = describeReadyBeads(summary({ count: 2, unavailable: 3 }), null);

    expect(one.empty).toBeNull();
    expect(one.notices).toEqual([
      "The bd CLI was unavailable for 1 workspace, so the count may be incomplete.",
    ]);
    expect(many.notices).toEqual([
      "The bd CLI was unavailable for 3 workspaces, so the count may be incomplete.",
    ]);
  });

  test("adds no caveats to a clean result", () => {
    expect(describeReadyBeads(summary({ count: 4 }), null)).toEqual({ empty: null, notices: [] });
  });
});

describe("bead screen params", () => {
  test("reads the workspace and bead IDs and ignores other params", () => {
    expect(parseBeadScreenParams({ workspace: "ws-1", bead: "demo-d4f", tab: "notes" })).toEqual({
      workspaceId: "ws-1",
      issueId: "demo-d4f",
    });
  });

  test("rejects links the detail RPC would refuse", () => {
    const invalid: Record<string, string>[] = [
      {},
      { workspace: "ws-1" },
      { bead: "demo-d4f" },
      { workspace: "", bead: "demo-d4f" },
      { workspace: "ws-1", bead: "" },
      { workspace: "ws-1", bead: "--help" },
      { workspace: "ws-1", bead: "x".repeat(257) },
    ];

    for (const params of invalid) expect(parseBeadScreenParams(params)).toBeNull();
  });
});
