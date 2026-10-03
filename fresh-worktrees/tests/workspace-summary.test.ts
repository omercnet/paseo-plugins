import { expect, test } from "vitest";
import { createWorkspaceSummary, describeRefresh } from "../client/workspace-summary";

const entry = { id: "one", directory: "/repo/one", remoteRef: "origin/main", behindBy: 3 };

test("counts workspaces, replacing results and removing current or deleted workspaces", () => {
  const summary = createWorkspaceSummary(async () => "unchanged");
  summary.set(entry);
  summary.set({ ...entry, behindBy: 5 });
  summary.set({ ...entry, id: "two" });
  expect(summary.getSnapshot().length).toBe(2);
  expect(summary.getSnapshot()[0].behindBy).toBe(5);
  summary.remove("one");
  expect(summary.getSnapshot().map(({ id }) => id)).toEqual(["two"]);
  summary.clear();
  expect(summary.getSnapshot()).toEqual([]);
});

test("refresh-all refreshes every listed workspace and tallies outcomes, counting rejections as failed", async () => {
  const outcomes = { one: "updated", two: "dirty" } as const;
  const summary = createWorkspaceSummary(async (id) => {
    if (id === "three") throw new Error("offline");
    return outcomes[id as keyof typeof outcomes];
  });
  summary.set(entry);
  summary.set({ ...entry, id: "two" });
  summary.set({ ...entry, id: "three" });
  expect(await summary.refreshAll()).toEqual({
    updated: 1,
    unchanged: 0,
    dirty: 1,
    unavailable: 0,
    failed: 1,
  });
});

test("describes refresh results, naming skipped dirty checkouts", () => {
  expect(describeRefresh({ updated: 1, unchanged: 0, dirty: 2, unavailable: 0, failed: 0 })).toBe(
    "Fast-forwarded 1. 2 skipped: source checkout has uncommitted changes.",
  );
  expect(describeRefresh({ updated: 0, unchanged: 2, dirty: 0, unavailable: 0, failed: 0 })).toBe(
    "2 source already up to date.",
  );
});
