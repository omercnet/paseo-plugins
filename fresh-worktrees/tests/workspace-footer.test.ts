import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import { registerWorkspaceFooter } from "../client/workspace-footer";
import { createWorkspaceSummary } from "../client/workspace-summary";

vi.mock("react-native", () => ({ Text: "Text", View: "View", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ ScrollView: "ScrollView" }));
// Host components may be memo/forwardRef objects, not plain functions.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SidebarRow: { $$typeof: Symbol.for("react.memo") },
}));

const summary = createWorkspaceSummary({
  refreshRoot: async () => "unchanged",
  recheck: async () => {},
});

describe("footer feature detection", () => {
  test("registers on a host that has footer items, even when SidebarRow is an object component", () => {
    const addSidebarFooterItem = vi.fn(() => () => {});
    registerWorkspaceFooter({ addSidebarFooterItem } as unknown as PluginClientContext, summary);
    expect(addSidebarFooterItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-freshness" }),
    );
  });

  test("registers nothing on a 0.9/0.10 host without addSidebarFooterItem", () => {
    expect(registerWorkspaceFooter({} as unknown as PluginClientContext, summary)).toBeUndefined();
  });
});
