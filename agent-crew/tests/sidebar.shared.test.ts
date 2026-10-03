import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, test, vi } from "vitest";
import { addActiveCrewsItem } from "../client/sidebar";

// The react-native package cannot load under Node; registration renders nothing.
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

test("registers the sidebar row only on hosts with sidebar header items", () => {
  const legacyHost = {} as PluginClientContext;
  expect(() => addActiveCrewsItem(legacyHost)()).not.toThrow();

  const removeItem = vi.fn();
  const addSidebarHeaderItem = vi.fn(() => removeItem);
  addActiveCrewsItem({ addSidebarHeaderItem } as unknown as PluginClientContext)();
  expect(addSidebarHeaderItem).toHaveBeenCalledOnce();
  expect(removeItem).toHaveBeenCalledOnce();
});
