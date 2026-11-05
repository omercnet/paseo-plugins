import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

vi.mock("../client/config-sidebar", () => ({ ConfigSidebarItem: () => null }));
vi.mock("../client/hub-icon", () => ({ OMP_ICON: { svg: "<svg></svg>" } }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
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
vi.mock("../client/subagents-strip", () => ({ OmpSubagentStrip: () => null }));
vi.mock("../client/rule-notice", () => ({ OmpRuleNoticeRow: () => null }));

import {
  configParamsFromStore,
  configScreenTitle,
  configStoreFromParams,
} from "../client/sidebar-compat";
import { registerConfig } from "../index.client";

function screenHost() {
  return {
    addScreen: vi.fn((_screen: { id: string }) => vi.fn()),
    addSidebarHeaderItem: vi.fn((_item: { id: string }) => vi.fn()),
    openScreen: vi.fn(),
  };
}

type Host = Parameters<typeof registerConfig>[0];

describe("config navigation", () => {
  test("registers the config screen under the legacy id with a single sidebar row", () => {
    const host = screenHost();
    const cleanup = registerConfig(host as unknown as Host, () => {});
    expect(host.addScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "config", title: configScreenTitle }),
    );
    expect(host.addSidebarHeaderItem.mock.calls.map(([item]) => item.id)).toEqual(["config"]);
    cleanup();
    for (const { value } of [
      ...host.addScreen.mock.results,
      ...host.addSidebarHeaderItem.mock.results,
    ]) {
      expect(value).toHaveBeenCalledOnce();
    }
  });

  test("store changes open the screen with params, except re-selecting the current store", () => {
    const host = screenHost();
    registerConfig(host as unknown as Host, () => {});
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
