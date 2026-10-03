import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beadsSnapshotQueryKey, type ReadyBeadsWorkspace } from "../client/beads-view";
import { scanReadyBeads } from "../client/ready-scan";
import type { BeadsSnapshot } from "../shared/beads";
import { bead, snapshot } from "./fixtures";

const HOST = "host-1";
const MINUTE = 60_000;

function workspace(id: string): ReadyBeadsWorkspace {
  return { id, projectDisplayName: "project", name: id };
}

describe("scanReadyBeads", () => {
  const clients: QueryClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
  });

  function setup(
    snapshots: Record<string, BeadsSnapshot | Error>,
    onRead: (workspaceId: string) => void = () => {},
  ) {
    const queryClient = new QueryClient();
    clients.push(queryClient);
    const loadSnapshot = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      onRead(workspaceId);
      const result = snapshots[workspaceId];
      if (result === undefined) throw new Error(`unexpected read of ${workspaceId}`);
      if (result instanceof Error) throw result;
      return result;
    });
    return { queryClient, loadSnapshot };
  }

  /** What an earlier scan, or the panel, read `agoMs` earlier and left in the cache. */
  function remember(
    queryClient: QueryClient,
    workspaceId: string,
    remembered: BeadsSnapshot,
    agoMs: number,
  ) {
    queryClient.setQueryData(beadsSnapshotQueryKey(HOST, workspaceId), remembered, {
      updatedAt: Date.now() - agoMs,
    });
  }

  function scan(
    { queryClient, loadSnapshot }: ReturnType<typeof setup>,
    workspaceIds: string[],
    signal: AbortSignal = new AbortController().signal,
  ) {
    return scanReadyBeads({
      hostId: HOST,
      signal,
      queryClient,
      loadSnapshot,
      listWorkspaces: async () => workspaceIds.map(workspace),
    });
  }

  function readIds({ loadSnapshot }: ReturnType<typeof setup>): string[] {
    return loadSnapshot.mock.calls.map(([{ workspaceId }]) => workspaceId);
  }

  test("stops starting workspace reads once its query is cancelled", async () => {
    const controller = new AbortController();
    const env = setup(
      {
        a: snapshot([bead("a-1")]),
        b: snapshot([bead("b-1")]),
        c: snapshot([bead("c-1")]),
        d: snapshot([bead("d-1")]),
      },
      // The last consumer of the scan goes away while the second workspace is being read.
      (workspaceId) => {
        if (workspaceId === "b") controller.abort();
      },
    );

    await expect(scan(env, ["a", "b", "c", "d"], controller.signal)).rejects.toThrow();
    expect(readIds(env)).toEqual(["a", "b"]);
  });

  test("counts an unreadable workspace as failed and still reads the rest", async () => {
    const env = setup({ a: new Error("Workspace not found."), b: snapshot([bead("b-1")]) });

    const summary = await scan(env, ["a", "b"]);

    expect(summary).toMatchObject({ count: 1, failed: 1, unavailable: 0 });
  });

  test("reuses a snapshot the panel cached moments ago instead of rerunning bd", async () => {
    const env = setup({ b: snapshot([bead("b-1")]) });
    remember(env.queryClient, "a", snapshot([bead("a-1")]), 1_000);

    const summary = await scan(env, ["a", "b"]);

    expect(readIds(env)).toEqual(["b"]);
    expect(summary.count).toBe(2);
  });

  test("reads every workspace the first time and counts a shared database once", async () => {
    const shared = snapshot([bead("a-1"), bead("a-2")], { databaseId: "db-x" });
    const env = setup({
      main: shared,
      "wt-1": shared,
      other: snapshot([bead("b-1")], { databaseId: "db-y" }),
    });

    const summary = await scan(env, ["main", "wt-1", "other"]);

    expect(readIds(env)).toEqual(["main", "wt-1", "other"]);
    expect(summary.count).toBe(3);
  });

  test("afterwards reads each database once, through its first listed workspace", async () => {
    const shared = snapshot([bead("a-1"), bead("a-2")], { databaseId: "db-x" });
    const other = snapshot([bead("b-1")], { databaseId: "db-y" });
    const env = setup({ "wt-1": shared, other });
    for (const id of ["wt-1", "main", "wt-2"]) remember(env.queryClient, id, shared, MINUTE);
    remember(env.queryClient, "other", other, MINUTE);

    const summary = await scan(env, ["wt-1", "main", "wt-2", "other"]);

    expect(readIds(env)).toEqual(["wt-1", "other"]);
    expect(summary).toMatchObject({ count: 3, failed: 0 });
  });

  test("still reads a worktree when the first reader of its database failed", async () => {
    const shared = snapshot([bead("a-1")], { databaseId: "db-x" });
    const env = setup({ main: new Error("Request timed out."), wt: shared });
    remember(env.queryClient, "main", shared, MINUTE);
    remember(env.queryClient, "wt", shared, MINUTE);

    const summary = await scan(env, ["main", "wt"]);

    expect(readIds(env)).toEqual(["main", "wt"]);
    expect(summary).toMatchObject({ count: 1, failed: 1 });
  });

  test("does not skip a worktree because a directory beside it has no Beads", async () => {
    const env = setup({
      notes: snapshot([], { state: "not_initialized" }),
      wt: snapshot([bead("a-1")], { databaseId: "db-x" }),
    });

    const summary = await scan(env, ["notes", "wt"]);

    expect(readIds(env)).toEqual(["notes", "wt"]);
    expect(summary.count).toBe(1);
  });

  test("rechecks a workspace without Beads only after a few minutes", async () => {
    const none = snapshot([], { state: "not_initialized" });
    const env = setup({ old: none });
    remember(env.queryClient, "recent", none, MINUTE);
    remember(env.queryClient, "old", none, 6 * MINUTE);

    const summary = await scan(env, ["recent", "old"]);

    expect(readIds(env)).toEqual(["old"]);
    expect(summary).toMatchObject({ count: 0, failed: 0 });
  });
});
