import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";

vi.mock("../client/configuration-popover", () => ({ ConfigurationPopover: () => null }));
vi.mock("../client/hub-panel", () => ({ OmpHubPanel: () => null }));
vi.mock("../client/hub-icon", () => ({ OMP_ICON: { svg: "<svg></svg>" } }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
vi.mock("../client/config-sidebar", () => ({ ConfigSidebarItem: () => null }));
vi.mock("../client/mcp-authorization", () => ({ OmpMcpAuthorizationCard: () => null }));
vi.mock("../client/mcp-popover", () => ({ McpPopover: () => null }));
vi.mock("../client/memory-panel", () => ({ OmpMemoryPanel: () => null }));
vi.mock("../client/memory-popover", () => ({ MemoryPopover: () => null }));
vi.mock("../client/model-roles-screen", () => ({ ModelRolesScreen: () => null }));
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

import contribute from "../index.client";

interface ClientCalls {
  registrations: Map<string, number>;
  removals: number;
}

/**
 * The Paseo 0.14 client context: exactly the registration surface the plugin uses. A 0.15-only
 * client call would be missing here and fail the registration test.
 */
function client014(): { client: PluginClientContext; calls: ClientCalls } {
  const calls: ClientCalls = { registrations: new Map(), removals: 0 };
  const register = (name: string) => () => {
    calls.registrations.set(name, (calls.registrations.get(name) ?? 0) + 1);
    return () => {
      calls.removals += 1;
    };
  };
  const client = {
    addScreen: register("addScreen"),
    addSidebarHeaderItem: register("addSidebarHeaderItem"),
    addWorkspacePanel: register("addWorkspacePanel"),
    addCommandCenterItem: register("addCommandCenterItem"),
    addTimelineRenderer: register("addTimelineRenderer"),
    addTimelineTransformer: register("addTimelineTransformer"),
    addComposerPill: register("addComposerPill"),
    openScreen: vi.fn(),
    rpc: async () => ({ status: "invalid" as const, revision: "0", error: "test" }),
    paseo: {
      agents: { list: async () => ({ agents: [], subscription: undefined }) },
      workspaces: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false }, subscription: undefined }),
      },
    },
  } as unknown as PluginClientContext;
  return { client, calls };
}

describe("OMP client registration on the Paseo 0.14 surface", () => {
  test("registers every contribution and releases them all", () => {
    const { client, calls } = client014();
    const cleanup = contribute(client);
    expect(calls.registrations.get("addScreen")).toBe(1);
    expect(calls.registrations.get("addSidebarHeaderItem")).toBe(1);
    expect(calls.registrations.get("addWorkspacePanel")).toBe(2);
    expect(calls.registrations.get("addCommandCenterItem")).toBe(3);
    expect(calls.registrations.get("addTimelineRenderer")).toBe(7);
    expect(calls.registrations.get("addTimelineTransformer")).toBe(4);
    // Composer pills arrive after the first settings read resolves, so this call registers none.
    expect(calls.registrations.get("addComposerPill")).toBeUndefined();

    cleanup();
    expect(calls.removals).toBe(18);
  });
});
