import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";

vi.mock("../client/pr-radar", () => ({ PrRadar: () => null }));
vi.mock("../client/settings-screen", () => ({ PrRadarSettingsScreen: () => null }));
vi.mock("../client/sidebar", () => ({ RadarSidebar: () => null }));

import contribute from "../index.client";

describe("client entry", () => {
  test("registers the settings screen, radar screen, sidebar row and opener, and removes all four on cleanup", () => {
    const registered: string[] = [];
    const removed: string[] = [];
    const commands: Array<{ id: string; onSelect(capabilities: unknown): void }> = [];
    const register = (method: string) => (contribution: { id: string }) => {
      registered.push(`${method}:${contribution.id}`);
      return () => removed.push(`${method}:${contribution.id}`);
    };
    const client = {
      addSettingsScreen: register("addSettingsScreen"),
      addScreen: register("addScreen"),
      addSidebarHeaderItem: register("addSidebarHeaderItem"),
      addCommandCenterItem: (command: { id: string; onSelect(capabilities: unknown): void }) => {
        commands.push(command);
        return register("addCommandCenterItem")(command);
      },
      openSettings: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    expect(registered).toEqual([
      "addSettingsScreen:pr-radar",
      "addScreen:radar",
      "addSidebarHeaderItem:radar",
      "addCommandCenterItem:open-radar",
    ]);

    const openScreen = vi.fn();
    commands[0].onSelect({ openScreen });
    expect(openScreen).toHaveBeenCalledWith({ screenId: "radar" });

    cleanup();
    expect(removed).toEqual([
      "addCommandCenterItem:open-radar",
      "addSidebarHeaderItem:radar",
      "addScreen:radar",
      "addSettingsScreen:pr-radar",
    ]);
  });
});
