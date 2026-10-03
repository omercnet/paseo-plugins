import { expect, test, vi } from "vitest";
import {
  createWorkspaceSummary,
  describeRefresh,
  type RefreshOutcome,
} from "../client/workspace-summary";

const entry = {
  id: "one",
  projectRootPath: "/repo",
  directory: "/repo/one",
  remoteRef: "origin/main",
  behindBy: 3,
};

function summaryWith(
  refreshRoot: (root: string) => Promise<RefreshOutcome> = async () => "unchanged",
  recheck: (id: string) => Promise<void> = async () => {},
) {
  return createWorkspaceSummary({ refreshRoot, recheck });
}

test("counts workspaces, replacing results and removing current or deleted workspaces", () => {
  const summary = summaryWith();
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

test("refresh-all refreshes each source checkout once, then rechecks every workspace after it", async () => {
  const calls: string[] = [];
  const refreshRoot = vi.fn(async (root: string) => {
    calls.push(`refresh ${root}`);
    return "updated" as const;
  });
  const summary = summaryWith(refreshRoot, async (id) => {
    calls.push(`recheck ${id}`);
  });
  summary.set(entry);
  summary.set({ ...entry, id: "two" });
  summary.set({ ...entry, id: "three", projectRootPath: "/other" });

  const report = await summary.refreshAll();

  expect(refreshRoot).toHaveBeenCalledTimes(2);
  expect(report).toEqual({ updated: 2, unchanged: 0, dirty: 0, unavailable: 0, failed: 0 });
  for (const [root, ids] of [
    ["/repo", ["one", "two"]],
    ["/other", ["three"]],
  ] as const) {
    const refreshed = calls.indexOf(`refresh ${root}`);
    for (const id of ids) expect(calls.indexOf(`recheck ${id}`)).toBeGreaterThan(refreshed);
  }
});

test("a failed source refresh is counted and the workspaces are still rechecked", async () => {
  const recheck = vi.fn(async () => {});
  const summary = summaryWith(async (root) => {
    if (root === "/repo") throw new Error("offline");
    return "dirty";
  }, recheck);
  summary.set(entry);
  summary.set({ ...entry, id: "two", projectRootPath: "/other" });

  expect(await summary.refreshAll()).toEqual({
    updated: 0,
    unchanged: 0,
    dirty: 1,
    unavailable: 0,
    failed: 1,
  });
  expect(recheck).toHaveBeenCalledTimes(2);
});

test("describes refresh results, naming skipped dirty checkouts", () => {
  expect(describeRefresh({ updated: 1, unchanged: 0, dirty: 2, unavailable: 0, failed: 0 })).toBe(
    "Fast-forwarded 1. 2 skipped: source checkout has uncommitted changes.",
  );
  expect(describeRefresh({ updated: 0, unchanged: 2, dirty: 0, unavailable: 0, failed: 0 })).toBe(
    "2 source already up to date.",
  );
});
