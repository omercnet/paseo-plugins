import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/auto-open", () => ({
  createAutoOpenManager: () => ({ setEnabled: () => {}, dispose: () => {} }),
}));
vi.mock("../client/main", () => ({ AgentCrew: () => null }));
vi.mock("../client/settings-screen", () => ({ AgentCrewSettingsScreen: () => null }));
vi.mock("../client/sidebar", () => ({ createActiveCrewsItem: () => () => null }));

describe("client entry", () => {
  test("registers the Active crews header row and removes it on cleanup", () => {
    const removeHeaderItem = vi.fn();
    const addSidebarHeaderItem = vi.fn((_item: { id: string }) => removeHeaderItem);
    const settingsScreens: Array<{ Component: (props: never) => unknown }> = [];
    const commands: Array<{ onSelect(capabilities: unknown): void }> = [];
    const client = {
      addSettingsScreen: (screen: { Component: (props: never) => unknown }) => {
        settingsScreens.push(screen);
        return () => {};
      },
      addWorkspacePanel: () => () => {},
      addCommandCenterItem: (command: { onSelect(capabilities: unknown): void }) => {
        commands.push(command);
        return () => {};
      },
      addSidebarHeaderItem,
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    expect(addSidebarHeaderItem).toHaveBeenCalledOnce();
    expect(addSidebarHeaderItem.mock.calls[0][0]).toMatchObject({
      id: "active-crews",
      title: "Active crews",
    });

    expect(settingsScreens[0].Component({ theme: {}, layout: {} } as never)).toBeTruthy();
    const openPanel = vi.fn();
    commands[0].onSelect({ openPanel });
    expect(openPanel).toHaveBeenCalledWith("crew", { location: "explorer" });

    cleanup();
    expect(removeHeaderItem).toHaveBeenCalledOnce();
  });
});
