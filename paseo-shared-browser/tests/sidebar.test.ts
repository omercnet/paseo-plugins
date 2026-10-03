import { describe, expect, it, vi } from "vitest";

vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("react-native", () => ({
  Pressable: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: () => null,
  View: () => null,
}));

import { contributeSharedBrowserSidebar } from "../client/sidebar";

describe("shared browser sidebar footer row", () => {
  it("registers nothing on hosts without addSidebarFooterItem", () => {
    const remove = contributeSharedBrowserSidebar({ addSidebarItem: vi.fn() } as never);
    expect(() => remove()).not.toThrow();
  });

  it("registers one footer item and returns its remover on 0.11 hosts", () => {
    const remove = vi.fn();
    const addSidebarFooterItem = vi.fn(() => remove);

    const cleanup = contributeSharedBrowserSidebar({ addSidebarFooterItem } as never);

    expect(addSidebarFooterItem).toHaveBeenCalledOnce();
    expect(addSidebarFooterItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Shared Browser", Component: expect.any(Function) }),
    );
    expect(cleanup).toBe(remove);
  });
});
