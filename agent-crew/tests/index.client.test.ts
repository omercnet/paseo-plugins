import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, test, vi } from "vitest";

const autoOpenDispose = vi.fn();

vi.mock("../client/main", () => ({ AgentCrew: () => null }));
vi.mock("../client/settings-screen", () => ({ AgentCrewSettingsScreen: () => null }));
vi.mock("../client/auto-open", () => ({
  createAutoOpenManager: () => ({ setEnabled: vi.fn(), dispose: autoOpenDispose }),
}));

test("contribute() registers panel, command, settings and header buttons, and cleans all up", async () => {
  const { default: contribute } = await import("../index.client");
  const removePanel = vi.fn();
  const removeCommand = vi.fn();
  const removeSettings = vi.fn();
  const unsubscribe = vi.fn();
  const client = {
    addWorkspacePanel: vi.fn(() => removePanel),
    addCommandCenterItem: vi.fn(() => removeCommand),
    addSettingsScreen: vi.fn(() => removeSettings),
    addHeaderButton: vi.fn(),
    paseo: {
      workspaces: {
        list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false } })),
        subscribe: vi.fn(() => unsubscribe),
      },
    },
  } as unknown as PluginClientContext;

  const cleanup = contribute(client);
  expect(client.addWorkspacePanel).toHaveBeenCalledWith(expect.objectContaining({ id: "crew" }));
  cleanup();
  expect(removePanel).toHaveBeenCalledTimes(1);
  expect(removeCommand).toHaveBeenCalledTimes(1);
  expect(removeSettings).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(autoOpenDispose).toHaveBeenCalledTimes(1);
});
