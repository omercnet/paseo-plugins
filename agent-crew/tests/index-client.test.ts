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
    const client = {
      addSettingsScreen: () => () => {},
      addWorkspacePanel: () => () => {},
      addCommandCenterItem: () => () => {},
      addSidebarHeaderItem,
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    expect(addSidebarHeaderItem).toHaveBeenCalledOnce();
    expect(addSidebarHeaderItem.mock.calls[0][0]).toMatchObject({
      id: "active-crews",
      title: "Active crews",
    });

    cleanup();
    expect(removeHeaderItem).toHaveBeenCalledOnce();
  });
});
