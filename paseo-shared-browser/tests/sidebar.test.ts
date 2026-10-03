import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspaceIds: [] as string[],
  names: new Map<string, string>(),
}));

vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => vi.fn(),
  useWorkspace: (id: string, select: (workspace: { title: null; name: string }) => string) => {
    const name = state.names.get(id);
    return name === undefined ? null : select({ title: null, name });
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.workspaceIds }) }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("react-native", () => ({
  Pressable: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: () => null,
  View: () => null,
}));

import { contributeSharedBrowserSidebar } from "../client/sidebar";

type Props = Record<string, unknown>;
type Element = ReactElement<Props & { children?: unknown }>;

const theme = { colors: { foreground: "#000", foregroundMuted: "#666", surface1: "#eee" } };

function register() {
  const addSidebarFooterItem = vi.fn((_item: { Component: (props: Props) => unknown }) => vi.fn());
  const openPanel = vi.fn();
  contributeSharedBrowserSidebar({ addSidebarFooterItem, openPanel } as never);
  const item = addSidebarFooterItem.mock.calls[0]?.[0];
  if (!item) throw new Error("footer item was not registered");
  return { Component: item.Component, openPanel };
}

/** Renders the popover returned by pressing the footer row, then each session row. */
function openPopover(Component: (props: Props) => unknown) {
  const openPopoverSpy = vi.fn();
  const row = Component({ openPopover: openPopoverSpy }) as Element;
  (row.props.onPress as () => void)();
  const Popover = openPopoverSpy.mock.calls[0]?.[0] as (props: Props) => Element;
  const close = vi.fn();
  const view = Popover({ theme, layout: { compact: false }, close });
  const sessions = (view.props.children as unknown[])[1] as Element[];
  const rendered = sessions.map((session) =>
    (session.type as (props: Props) => Element | null)(session.props),
  );
  return { close, rendered };
}

beforeEach(() => {
  state.workspaceIds = [];
  state.names.clear();
});

describe("shared browser sidebar footer row", () => {
  it("registers nothing on hosts without addSidebarFooterItem", () => {
    const addSidebarItem = vi.fn();
    contributeSharedBrowserSidebar({ addSidebarItem } as never)();
    expect(addSidebarItem).not.toHaveBeenCalled();
  });

  it("hides the row while no browser session is open", () => {
    const { Component } = register();
    expect(Component({ openPopover: vi.fn() })).toBeNull();
  });

  it("counts open sessions in the row label", () => {
    state.workspaceIds = ["one", "two"];
    const { Component } = register();
    expect((Component({ openPopover: vi.fn() }) as Element).props.label).toBe("Shared Browser (2)");
  });

  it("closes the popover, then opens the chosen workspace's panel", () => {
    state.workspaceIds = ["one"];
    state.names.set("one", "Workspace One");
    const { Component, openPanel } = register();
    const { close, rendered } = openPopover(Component);

    (rendered[0]!.props.onPress as () => void)();

    expect(close).toHaveBeenCalledOnce();
    expect(openPanel).toHaveBeenCalledWith("shared-browser", { workspaceId: "one" });
  });

  it("omits sessions for workspaces this client has not loaded", () => {
    state.workspaceIds = ["known", "unknown"];
    state.names.set("known", "Known");
    const { Component } = register();
    const { rendered } = openPopover(Component);

    expect(rendered[0]).not.toBeNull();
    expect(rendered[1]).toBeNull();
  });
});
