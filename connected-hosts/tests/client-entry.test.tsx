import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/screen", () => ({ ConnectedHostsScreen: () => null }));
vi.mock("../client/sidebar", () => ({
  ConnectedHostsSidebarItem: () => null,
  SCREEN_ID: "connected-hosts",
}));

interface Command {
  context: string;
  onSelect(input: { openScreen(input: { screenId: string }): void }): void;
}

describe("client entry", () => {
  it("registers the screen, sidebar item and command, and removes all three on teardown", () => {
    const removers = [vi.fn(), vi.fn(), vi.fn()];
    const addScreen = vi.fn((_screen: { id: string; title: string }) => removers[0]);
    const addSidebarHeaderItem = vi.fn((_item: { id: string }) => removers[1]);
    const addCommandCenterItem = vi.fn((_command: Command) => removers[2]);
    const cleanup = contribute({
      addScreen,
      addSidebarHeaderItem,
      addCommandCenterItem,
    } as unknown as PluginClientContext);

    expect(addScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "connected-hosts", title: "Connected hosts" }),
    );
    expect(addSidebarHeaderItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "connected-hosts" }),
    );

    const command = addCommandCenterItem.mock.calls[0][0];
    const openScreen = vi.fn();
    command.onSelect({ openScreen });
    expect(command.context).toBe("global");
    expect(openScreen).toHaveBeenCalledWith({ screenId: "connected-hosts" });

    for (const remove of removers) expect(remove).not.toHaveBeenCalled();
    cleanup();
    for (const remove of removers) expect(remove).toHaveBeenCalledOnce();
  });
});
