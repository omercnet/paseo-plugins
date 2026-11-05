import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";

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
vi.mock("../client/subagents-strip", () => ({ OmpSubagentStrip: () => null }));
vi.mock("../client/rule-notice", () => ({ OmpRuleNoticeRow: () => null }));
vi.mock("../client/lsp-diagnostics", () => ({ OmpLspDiagnosticsCard: () => null }));
vi.mock("../client/generated-image", () => ({ OmpGeneratedImagesRow: () => null }));
vi.mock("../client/ast-edit", () => ({ OmpAstEditCard: () => null }));

import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client";
import { OMP_RULE_NOTICE_KIND } from "../shared/rule-notices";

interface NoticeRow {
  openRule(name: string): void;
}
interface ConfigSurface {
  focusRule?: string;
}
interface Registered<Rendered> {
  kind?: string;
  id?: string;
  Component(props: object): ReactElement<Rendered>;
}

test("a rule-fired notice opens the config screen on that rule", () => {
  const timeline: Registered<NoticeRow>[] = [];
  const screens: Registered<ConfigSurface>[] = [];
  const openScreen = vi.fn();
  const noop = () => () => {};
  const client = {
    paseo: { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } },
    rpc: async () => ({ status: "error" }),
    openScreen,
    addWorkspacePanel: noop,
    addCommandCenterItem: noop,
    addSidebarHeaderItem: noop,
    addTimelineTransformer: noop,
    addTimelineRenderer: (renderer: Registered<NoticeRow>) => {
      timeline.push(renderer);
      return () => {};
    },
    addScreen: (screen: Registered<ConfigSurface>) => {
      screens.push(screen);
      return () => {};
    },
    addComposerPill: () => ({ update: () => {}, remove: () => {} }),
  } as unknown as PluginClientContext;
  const dispose = contribute(client);
  try {
    const notice = timeline.find((renderer) => renderer.kind === OMP_RULE_NOTICE_KIND);
    const config = screens.find((screen) => screen.id === "config");
    if (!notice || !config) throw new Error("The notice renderer and config screen must register");

    const row = notice.Component({ item: { data: { rules: [] } } });
    row.props.openRule("no-canary");
    expect(openScreen).toHaveBeenCalledOnce();
    const [{ params }] = openScreen.mock.calls[0] as [{ params: Record<string, string> }];

    // The screen the link opens puts that rule in view.
    const surface = config.Component({ params });
    expect(surface.props.focusRule).toBe("no-canary");
    const plain = config.Component({ params: {} });
    expect(plain.props.focusRule).toBeUndefined();
  } finally {
    dispose();
  }
});
