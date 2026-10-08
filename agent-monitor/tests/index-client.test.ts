import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/agent-monitor", () => ({ AgentMonitor: () => null }));
vi.mock("../client/settings-screen", () => ({ MonitorSettingsScreen: () => null }));
vi.mock("../client/sidebar", () => ({
  MONITOR_SCREEN_ID: "monitor",
  MonitorSidebarItem: () => null,
}));

function host() {
  const removed: string[] = [];
  const registered: string[] = [];
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
  } as unknown as PluginClientContext;
  return { client, registered, removed, commands };
}

describe("client entry", () => {
  test("registers the monitor screen and header row under the saved-link ids, then removes all", () => {
    const { client, registered, removed } = host();

    const cleanup = contribute(client);
    expect(registered).toEqual([
      "addSettingsScreen:monitor",
      "addScreen:monitor",
      "addSidebarHeaderItem:monitor",
      "addCommandCenterItem:open-monitor",
      "addCommandCenterItem:configure-monitor",
    ]);

    cleanup();
    expect(removed.sort()).toEqual([...registered].sort());
  });

  test("Open agent monitor navigates to the screen", () => {
    const { client, commands } = host();
    contribute(client);
    const openScreen = vi.fn();
    commands.find(({ id }) => id === "open-monitor")?.onSelect({ openScreen });
    expect(openScreen).toHaveBeenCalledWith({ screenId: "monitor" });
  });
});
