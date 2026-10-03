import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beadsSnapshotQueryKey } from "../client/beads-view";
import { type ListedWorkspace, pickBeadsWorkspaces, scanReadyBeads } from "../client/ready-scan";
import type { BeadsSnapshot } from "../shared/beads";
import { bead, snapshot } from "./fixtures";

const HOST = "host-1";

function workspace(
  id: string,
  projectId: string,
  workspaceKind = "local_checkout",
): ListedWorkspace {
  return { id, projectId, workspaceKind, projectDisplayName: projectId, name: id };
}

function workspaceIds(workspaces: readonly ListedWorkspace[]): string[] {
  return workspaces.map(({ id }) => id);
}

describe("pickBeadsWorkspaces", () => {
  test("reads each checkout and skips the worktrees that share its database", () => {
    const listed = [
      workspace("wt-1", "p1", "worktree"),
      workspace("main", "p1"),
      workspace("wt-2", "p1", "worktree"),
      workspace("notes", "p2", "directory"),
    ];

    expect(workspaceIds(pickBeadsWorkspaces(listed))).toEqual(["main", "notes"]);
  });

  test("reads only the first worktree of a project that lists no checkout", () => {
    const listed = [
      workspace("wt-1", "p1", "worktree"),
      workspace("wt-2", "p1", "worktree"),
      workspace("wt-3", "p2", "worktree"),
      workspace("wt-4", "p1", "worktree"),
    ];

    expect(workspaceIds(pickBeadsWorkspaces(listed))).toEqual(["wt-1", "wt-3"]);
  });

  test("reads every checkout of a project, because separate clones keep separate databases", () => {
    const listed = [
      workspace("clone-a", "p1"),
      workspace("clone-b", "p1", "checkout"),
      workspace("wt", "p1", "worktree"),
    ];

    expect(workspaceIds(pickBeadsWorkspaces(listed))).toEqual(["clone-a", "clone-b"]);
  });
});

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

  function readIds(loadSnapshot: ReturnType<typeof setup>["loadSnapshot"]): string[] {
    return loadSnapshot.mock.calls.map(([{ workspaceId }]) => workspaceId);
  }

  test("stops starting workspace reads once its query is cancelled", async () => {
    const controller = new AbortController();
    const { queryClient, loadSnapshot } = setup(
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

    const scan = scanReadyBeads({
      hostId: HOST,
      signal: controller.signal,
      queryClient,
      loadSnapshot,
      listWorkspaces: async () => ["a", "b", "c", "d"].map((id) => workspace(id, id)),
    });

    await expect(scan).rejects.toThrow();
    expect(readIds(loadSnapshot)).toEqual(["a", "b"]);
  });

  test("counts an unreadable workspace as failed and still reads the rest", async () => {
    const { queryClient, loadSnapshot } = setup({
      a: new Error("Workspace not found."),
      b: snapshot([bead("b-1")]),
    });

    const summary = await scanReadyBeads({
      hostId: HOST,
      signal: new AbortController().signal,
      queryClient,
      loadSnapshot,
      listWorkspaces: async () => [workspace("a", "p1"), workspace("b", "p2")],
    });

    expect(summary).toMatchObject({ count: 1, failed: 1, unavailable: 0 });
  });

  test("reuses a snapshot the panel cached moments ago instead of rerunning bd", async () => {
    const { queryClient, loadSnapshot } = setup({ b: snapshot([bead("b-1")]) });
    queryClient.setQueryData(beadsSnapshotQueryKey(HOST, "a"), snapshot([bead("a-1")]));

    const summary = await scanReadyBeads({
      hostId: HOST,
      signal: new AbortController().signal,
      queryClient,
      loadSnapshot,
      listWorkspaces: async () => [workspace("a", "p1"), workspace("b", "p2")],
    });

    expect(readIds(loadSnapshot)).toEqual(["b"]);
    expect(summary.count).toBe(2);
  });

  test("reads a project's worktrees through its checkout alone", async () => {
    const { queryClient, loadSnapshot } = setup({ main: snapshot([bead("a-1")]) });

    const summary = await scanReadyBeads({
      hostId: HOST,
      signal: new AbortController().signal,
      queryClient,
      loadSnapshot,
      listWorkspaces: async () => [
        workspace("wt-1", "p1", "worktree"),
        workspace("main", "p1"),
        workspace("wt-2", "p1", "worktree"),
      ],
    });

    expect(readIds(loadSnapshot)).toEqual(["main"]);
    expect(summary.count).toBe(1);
  });
});
