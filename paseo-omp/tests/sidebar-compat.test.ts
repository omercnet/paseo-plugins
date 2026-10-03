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
  summarizeHubWorkspaces,
  supportsScreens,
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

function legacyHost() {
  return {
    addSurface: vi.fn(() => vi.fn()),
    addSidebarItem: vi.fn(() => vi.fn()),
    rpc: vi.fn(),
    paseo: { workspaces: { list: vi.fn() } },
  };
}

type Legacy = Parameters<typeof registerConfigAndHub>[0];

describe("0.9/0.10 fallback", () => {
  test("keeps the static sidebar row and surface when screens are unavailable", () => {
    const host = legacyHost();
    const cleanup = registerConfigAndHub(
      host as unknown as Legacy,
      () => null,
      () => {},
    );
    expect(host.addSurface).toHaveBeenCalledWith("config", expect.any(Function));
    expect(host.addSidebarItem).toHaveBeenCalledWith({
      id: "config",
      title: "OMP",
      icon: "Settings",
      surface: "config",
    });
    cleanup();
    expect(host.addSurface.mock.results[0].value).toHaveBeenCalledOnce();
    expect(host.addSidebarItem.mock.results[0].value).toHaveBeenCalledOnce();
  });

  test("a partial 0.11 surface (no openScreen) still takes the legacy path", () => {
    const host = { ...legacyHost(), addScreen: vi.fn(), addSidebarHeaderItem: vi.fn() };
    expect(supportsScreens(host)).toBe(false);
    registerConfigAndHub(
      host as unknown as Legacy,
      () => null,
      () => {},
    );
    expect(host.addScreen).not.toHaveBeenCalled();
    expect(host.addSurface).toHaveBeenCalledOnce();
  });
});

describe("0.11 screens", () => {
  function screenHost() {
    return {
      ...legacyHost(),
      addScreen: vi.fn(() => vi.fn()),
      addSidebarHeaderItem: vi.fn((_item: { id: string }) => vi.fn()),
      openScreen: vi.fn(),
    };
  }

  test("registers the config screen under the legacy id plus config and hub rows", () => {
    const host = screenHost();
    const cleanup = registerConfigAndHub(
      host as unknown as Legacy,
      () => null,
      () => {},
    );
    expect(host.addSurface).not.toHaveBeenCalled();
    expect(host.addSidebarItem).not.toHaveBeenCalled();
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

  test("hub loader lists processes for each distinct workspace directory", async () => {
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
    registerConfigAndHub(
      host as unknown as Legacy,
      () => null,
      () => {},
    );
    await expect(hubLoaders.at(-1)?.()).resolves.toEqual([
      { cwd: "/a", processes: [hubProcess("web", "running")] },
      { cwd: "/b", processes: [] },
    ]);
    expect(host.rpc.mock.calls).toEqual([
      [listHubProcesses, { cwd: "/a" }],
      [listHubProcesses, { cwd: "/b" }],
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

  test("workspace directories are deduplicated and bounded", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({ projectRootPath: `/p${index}` }));
    expect(workspaceDirectories(entries, 3)).toEqual(["/p0", "/p1", "/p2"]);
  });
});
