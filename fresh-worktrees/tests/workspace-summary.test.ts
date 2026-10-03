import { expect, test } from "vitest";
import { createWorkspaceSummary } from "../client/workspace-summary";

const entry = { id: "one", directory: "/repo/one", remoteRef: "origin/main", behindBy: 3 };

test("counts workspaces, replacing results and removing current or deleted workspaces", () => {
  const summary = createWorkspaceSummary(async () => {});
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

test("refreshes the stale snapshot even when checks change the count", async () => {
  const refreshed: string[] = [];
  const summary = createWorkspaceSummary(async (id) => {
    refreshed.push(id);
    summary.remove(id);
  });
  summary.set(entry);
  summary.set({ ...entry, id: "two" });
  await summary.refreshAll();
  expect(refreshed).toEqual(["one", "two"]);
  expect(summary.getSnapshot()).toEqual([]);
});

test("refresh-all attempts every workspace and preserves failed results for retry", async () => {
  const summary = createWorkspaceSummary(async (id) => {
    if (id === "one") throw new Error("offline");
    summary.remove(id);
  });
  summary.set(entry);
  summary.set({ ...entry, id: "two" });
  await expect(summary.refreshAll()).rejects.toThrow("Could not refresh 1 workspace(s).");
  expect(summary.getSnapshot().map(({ id }) => id)).toEqual(["one"]);
});
