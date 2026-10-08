import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import type { HubProcess } from "../shared/hub";

const hubLoaders: Array<() => Promise<unknown>> = [];
vi.mock("../client/hub-icon", () => ({ OmpIcon: () => null }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
vi.mock("../client/hub-sidebar", () => ({
  ConfigSidebarItem: () => null,
  createHubSidebar: (load: () => Promise<unknown>) => {
    hubLoaders.push(load);
    return { HubSidebarItem: () => null, HubSidebarPopover: () => null };
  },
}));
vi.mock("../client/mcp-authorization", () => ({ OmpMcpAuthorizationCard: () => null }));
vi.mock("../client/mcp-popover", () => ({ McpPopover: () => null }));
vi.mock("../client/memory-panel", () => ({ OmpMemoryPanel: () => null }));
vi.mock("../client/memory-popover", () => ({ MemoryPopover: () => null }));
vi.mock("../client/omp-config-surface", () => ({
  OmpConfigSurface: () => null,
  OmpWorkspacePanel: () => null,
}));
vi.mock("../client/provider-icon", () => ({ quotaProviderIcon: () => () => null }));
vi.mock("../client/provider-image", () => ({ OmpImageTimeline: () => null }));
vi.mock("../client/quota-popover", () => ({ QuotaPopover: () => null }));
vi.mock("../client/sessions-popover", () => ({ SessionsPopover: () => null }));

import {
  configParamsFromStore,
  configScreenTitle,
  configStoreFromParams,
  type HubSnapshot,
  hubTrailing,
  loadHubSnapshot,
  summarizeHubWorkspaces,
  workspaceDirectories,
} from "../client/sidebar-compat";
import { registerConfigAndHub } from "../index.client";
import { listHubProcesses } from "../shared/hub";

function hubProcess(name: string, state: string, exitCode: number | null = null): HubProcess {
  return {
    name,
    application: "bun",
    args: [],
    cwd: "/repo",
    state,
    owner: null,
    restartCount: 0,
    persist: false,
    detached: false,
    createdAt: null,
    startedAt: null,
    readyAt: null,
    exitedAt: null,
    exitCode,
  };
}

function screenHost() {
  return {
    addScreen: vi.fn((_screen: { id: string }) => vi.fn()),
    addSidebarHeaderItem: vi.fn((_item: { id: string }) => vi.fn()),
    openScreen: vi.fn(),
    rpc: vi.fn(),
    paseo: { workspaces: { list: vi.fn() } },
  };
}

type Host = Parameters<typeof registerConfigAndHub>[0];

describe("config and hub navigation", () => {
  test("registers the config screen under the legacy id plus config and hub rows", () => {
    const host = screenHost();
    const cleanup = registerConfigAndHub(host as unknown as Host, () => {});
    expect(host.addScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "config", title: configScreenTitle }),
    );
    expect(host.addSidebarHeaderItem.mock.calls.map(([item]) => item.id)).toEqual([
      "config",
      "hub",
    ]);
    cleanup();
    for (const { value } of [
      ...host.addScreen.mock.results,
      ...host.addSidebarHeaderItem.mock.results,
    ]) {
      expect(value).toHaveBeenCalledOnce();
    }
  });

  test("hub loader polls each distinct workspace directory", async () => {
    const host = screenHost();
    host.paseo.workspaces.list.mockResolvedValue({
      entries: [
        { workspaceDirectory: "/a", projectRootPath: "/p" },
        { projectRootPath: "/b" },
        { workspaceDirectory: "/a", projectRootPath: "/p" },
      ],
    });
    host.rpc.mockImplementation(async (_contract, { cwd }) => ({
      processes: cwd === "/a" ? [hubProcess("web", "running")] : [],
    }));
    registerConfigAndHub(host as unknown as Host, () => {});
    await expect(hubLoaders.at(-1)?.()).resolves.toEqual({
      workspaces: [
        { cwd: "/a", processes: [hubProcess("web", "running")] },
        { cwd: "/b", processes: [] },
      ],
      truncated: false,
      unreadable: 0,
    });
    expect(host.rpc.mock.calls).toEqual([
      [listHubProcesses, { cwd: "/a" }],
      [listHubProcesses, { cwd: "/b" }],
    ]);
  });

  test("store changes open the screen with params, except re-selecting the current store", () => {
    const host = screenHost();
    registerConfigAndHub(host as unknown as Host, () => {});
    const [{ Component }] = host.addScreen.mock.calls[0] as unknown as [
      { Component: (props: { params: Record<string, string> }) => ReactElement },
    ];
    const element = Component({ params: { profile: "work" } });
    const { store, onStoreChange } = element.props as {
      store: unknown;
      onStoreChange(store: { profile?: string } | undefined): void;
    };
    expect(store).toEqual({ profile: "work" });
    onStoreChange({ profile: "work" });
    expect(host.openScreen).not.toHaveBeenCalled();
    onStoreChange({ profile: "home" });
    onStoreChange(undefined);
    expect(host.openScreen.mock.calls).toEqual([
      [{ screenId: "config", params: { profile: "home" } }],
      [{ screenId: "config", params: {} }],
    ]);
  });
});

describe("config screen params", () => {
  test("a valid profile param selects that store and round-trips", () => {
    expect(configStoreFromParams({ profile: "work" })).toEqual({ profile: "work" });
    expect(configParamsFromStore({ profile: "work" })).toEqual({ profile: "work" });
    expect(configScreenTitle({ profile: "work" })).toBe("OMP · work");
  });

  test("missing, reserved, or malformed profiles fall back to the default store", () => {
    for (const params of [
      {},
      { profile: "" },
      { profile: "default" },
      { profile: "../etc" },
    ] as Array<Record<string, string>>) {
      expect(configStoreFromParams(params)).toBeUndefined();
      expect(configScreenTitle(params)).toBe("OMP");
    }
    expect(configParamsFromStore(undefined)).toEqual({});
    expect(configParamsFromStore({ agentDir: "/custom" })).toEqual({});
  });
});

describe("hub sidebar summary", () => {
  test("counts running and failed processes across workspaces", () => {
    expect(
      summarizeHubWorkspaces([
        { cwd: "/a", processes: [hubProcess("web", "running"), hubProcess("db", "ready")] },
        {
          cwd: "/b",
          processes: [
            hubProcess("job", "exited", 1),
            hubProcess("old", "stopped"),
            hubProcess("boot", "starting"),
          ],
        },
      ]),
    ).toEqual({ running: 2, failed: 1, total: 5 });
    expect(summarizeHubWorkspaces([])).toEqual({ running: 0, failed: 0, total: 0 });
  });

  test("workspace directories are deduplicated and bounded, reporting truncation", () => {
    expect(
      workspaceDirectories([
        { workspaceDirectory: "/a", projectRootPath: "/p" },
        { projectRootPath: "/b" },
        { workspaceDirectory: "/a", projectRootPath: "/p" },
      ]),
    ).toEqual({ directories: ["/a", "/b"], truncated: false });
    const entries = Array.from({ length: 5 }, (_, index) => ({ projectRootPath: `/p${index}` }));
    expect(workspaceDirectories(entries, 3)).toEqual({
      directories: ["/p0", "/p1", "/p2"],
      truncated: true,
    });
    expect(workspaceDirectories(entries.slice(0, 3), 3).truncated).toBe(false);
  });
});

describe("hub snapshot loading", () => {
  const twoWorkspaces = async () => ({
    entries: [{ projectRootPath: "/a" }, { projectRootPath: "/b" }],
  });

  test("one unreadable workspace does not hide the others", async () => {
    const snapshot = await loadHubSnapshot(twoWorkspaces, async (cwd) => {
      if (cwd === "/b") throw new Error("unreadable");
      return [hubProcess("web", "running")];
    });
    expect(snapshot).toEqual({
      workspaces: [{ cwd: "/a", processes: [hubProcess("web", "running")] }],
      truncated: false,
      unreadable: 1,
    });
  });

  test("fails only when every workspace is unreadable", async () => {
    await expect(
      loadHubSnapshot(twoWorkspaces, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("OMP hub state is unreadable");
    await expect(
      loadHubSnapshot(
        async () => ({ entries: [] }),
        async () => [],
      ),
    ).resolves.toEqual({ workspaces: [], truncated: false, unreadable: 0 });
  });

  test("a further workspace page marks counts as a lower bound", async () => {
    const snapshot = await loadHubSnapshot(
      async () => ({ entries: [{ projectRootPath: "/a" }], pageInfo: { hasMore: true } }),
      async () => [],
    );
    expect(snapshot.truncated).toBe(true);
  });
});

describe("hub row trailing state", () => {
  const snapshot = (processes: HubProcess[], extra: Partial<HubSnapshot> = {}): HubSnapshot => ({
    workspaces: [{ cwd: "/a", processes }],
    truncated: false,
    unreadable: 0,
    ...extra,
  });

  test("shows nothing without processes or problems", () => {
    expect(hubTrailing(undefined, false)).toBeNull();
    expect(hubTrailing(snapshot([]), false)).toBeNull();
  });

  test("shows running and failed counts", () => {
    expect(
      hubTrailing(snapshot([hubProcess("web", "running"), hubProcess("job", "failed")]), false),
    ).toEqual({
      running: "1 running",
      failed: "1 failed",
      unreadable: false,
      accessibilityLabel: "1 running, 1 failed",
    });
  });

  test("marks truncated counts and unreadable state", () => {
    expect(
      hubTrailing(
        snapshot([hubProcess("web", "running")], { truncated: true, unreadable: 2 }),
        false,
      ),
    ).toEqual({
      running: "1+ running",
      unreadable: true,
      accessibilityLabel: "1+ running, some hub state unreadable",
    });
    expect(hubTrailing(undefined, true)).toEqual({
      unreadable: true,
      accessibilityLabel: "some hub state unreadable",
    });
  });
});
