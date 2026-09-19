import { describe, expect, test, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client";
import { workspaceFreshness } from "../shared/workspace-freshness";

interface WorkspaceUpdate {
  kind: "upsert";
  workspace: {
    id: string;
    projectId: string;
    workspaceDirectory: string;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("freshness scheduling", () => {
  test("checks listed workspaces with a host-owned subscription", async () => {
    const rpc = vi.fn().mockResolvedValue({ kind: "current", remoteRef: "origin/main" });
    const list = vi.fn(async (options: { subscribe?: { subscriptionId?: string } }) => {
      if (options.subscribe && "subscriptionId" in options.subscribe) {
        throw new Error("Subscription IDs are assigned by the host");
      }
      return {
        entries: [
          {
            id: "workspace-1",
            projectId: "project-1",
            workspaceDirectory: "/repo/worktree",
          },
        ],
        subscription: { release: vi.fn().mockResolvedValue(undefined) },
      };
    });
    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list,
          subscribe: vi.fn(() => () => {}),
        },
      },
      rpc,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);

    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(workspaceFreshness, {
        projectRootPath: "/repo",
        workspaceDirectory: "/repo/worktree",
      }),
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ subscribe: {} });

    await cleanup();
  });

  test("releases the host-owned workspace observation during cleanup", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn().mockResolvedValue({ kind: "current", remoteRef: "origin/main" });
    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(async () => ({
            entries: [
              {
                id: "workspace-1",
                projectId: "project-1",
                workspaceDirectory: "/repo/worktree",
              },
            ],
            subscription: { release },
          })),
          subscribe: vi.fn(() => () => {}),
        },
      },
      rpc,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    await cleanup();

    expect(release).toHaveBeenCalledTimes(1);
  });

  test("releases a late workspace observation without scheduling work", async () => {
    const listed = deferred<{
      entries: WorkspaceUpdate["workspace"][];
      subscription: { release: () => Promise<void> };
    }>();
    const release = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn().mockResolvedValue({
      kind: "behind",
      remoteRef: "origin/main",
      behindBy: 1,
    });
    const addHeaderButton = vi.fn();
    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(() => listed.promise),
          subscribe: vi.fn(() => () => {}),
        },
      },
      rpc,
      addHeaderButton,
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    await cleanup();
    expect(release).not.toHaveBeenCalled();

    listed.resolve({
      entries: [
        {
          id: "workspace-1",
          projectId: "project-1",
          workspaceDirectory: "/repo/worktree",
        },
      ],
      subscription: { release },
    });

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));

    expect(rpc).not.toHaveBeenCalled();
    expect(addHeaderButton).not.toHaveBeenCalled();
  });

  test("releases the workspace observation when initialization fails", async () => {
    const projects = deferred<never>();
    const release = vi.fn().mockResolvedValue(undefined);
    const client = {
      paseo: {
        projects: { list: vi.fn(() => projects.promise) },
        workspaces: {
          list: vi.fn(async () => ({ entries: [], subscription: { release } })),
          subscribe: vi.fn(() => () => {}),
        },
      },
      rpc: vi.fn(),
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    projects.reject(new Error("project listing failed"));

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await cleanup();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("coalesces repeated updates for an unchanged workspace", async () => {
    const freshness = deferred<{ kind: "current"; remoteRef: string }>();
    const rpc = vi.fn(() => freshness.promise);
    let onWorkspaceUpdate!: (update: WorkspaceUpdate) => void;

    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(async () => ({ entries: [] })),
          subscribe: vi.fn((callback) => {
            onWorkspaceUpdate = callback;
            return () => {};
          }),
        },
      },
      rpc,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    const update: WorkspaceUpdate = {
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/worktree",
      },
    };

    onWorkspaceUpdate(update);
    onWorkspaceUpdate(update);
    onWorkspaceUpdate(update);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    freshness.resolve({ kind: "current", remoteRef: "origin/main" });
    await freshness.promise;
    onWorkspaceUpdate(update);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  test("rechecks a moved workspace without applying its old result", async () => {
    const firstFreshness = deferred<{
      kind: "behind";
      remoteRef: string;
      behindBy: number;
    }>();
    const rpc = vi
      .fn()
      .mockImplementationOnce(() => firstFreshness.promise)
      .mockResolvedValueOnce({ kind: "current", remoteRef: "origin/main" });
    const addHeaderButton = vi.fn();
    let onWorkspaceUpdate!: (update: WorkspaceUpdate) => void;

    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(async () => ({ entries: [] })),
          subscribe: vi.fn((callback) => {
            onWorkspaceUpdate = callback;
            return () => {};
          }),
        },
      },
      rpc,
      addHeaderButton,
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    onWorkspaceUpdate({
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/old-worktree",
      },
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    onWorkspaceUpdate({
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/new-worktree",
      },
    });
    firstFreshness.resolve({ kind: "behind", remoteRef: "origin/main", behindBy: 1 });

    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[1]?.[1]).toEqual({
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/new-worktree",
    });
    expect(addHeaderButton).not.toHaveBeenCalled();

    await cleanup();
  });
});
