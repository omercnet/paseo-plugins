import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/footer", () => ({ TopFooter: () => null }));
vi.mock("../client/screen", () => ({ TopScreen: () => null }));
vi.mock("../client/usage", () => ({ SCREEN_ID: "usage" }));

describe("client entry", () => {
  it("registers the Top screen and the footer item, and removes both on teardown", () => {
    const removeScreen = vi.fn();
    const removeFooter = vi.fn();
    const addScreen = vi.fn(() => removeScreen);
    const addSidebarFooterItem = vi.fn(() => removeFooter);
    const cleanup = contribute({
      addScreen,
      addSidebarFooterItem,
    } as unknown as PluginClientContext);

    expect(addScreen).toHaveBeenCalledWith(expect.objectContaining({ id: "usage", title: "Top" }));
    expect(addSidebarFooterItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usage", title: "Top" }),
    );
    expect(removeScreen).not.toHaveBeenCalled();
    expect(removeFooter).not.toHaveBeenCalled();

    cleanup();
    expect(removeScreen).toHaveBeenCalledOnce();
    expect(removeFooter).toHaveBeenCalledOnce();
  });
});
