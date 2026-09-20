import { describe, expect, test, vi } from "vitest";

vi.mock("../client/context-mode-pill", () => ({
  contributeContextModeComposerPills: () => () => {},
}));
vi.mock("../client/context-mode-surface", () => ({ ContextModeSurface: () => null }));
vi.mock("../client/settings-screen", () => ({ ContextModeSettingsScreen: () => null }));

import contribute from "../index.client";

describe("client contributions", () => {
  test("registers the surface, settings, sidebar, and global opener with cleanup", () => {
    const removed = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const registrations: Record<string, unknown> = {};
    const client = {
      addSettingsScreen: vi.fn((value) => {
        registrations.settings = value;
        return removed[0];
      }),
      addSurface: vi.fn((id, component) => {
        registrations.surface = { id, component };
        return removed[1];
      }),
      addSidebarItem: vi.fn((value) => {
        registrations.sidebar = value;
        return removed[2];
      }),
      addCommandCenterItem: vi.fn((value) => {
        registrations.command = value;
        return removed[3];
      }),
      openSettings: vi.fn(),
    };

    const cleanup = contribute(client as never);

    expect(registrations.settings).toMatchObject({
      id: "context-mode",
      title: "Context Mode settings",
    });
    expect(registrations.surface).toMatchObject({ id: "context-mode" });
    expect(registrations.sidebar).toEqual({
      id: "context-mode",
      title: "Context Mode",
      icon: "Gauge",
      surface: "context-mode",
    });
    expect(registrations.command).toMatchObject({
      id: "open-context-mode",
      title: "Open Context Mode",
      context: "global",
    });

    const openSurface = vi.fn();
    const command = registrations.command as {
      onSelect(input: { openSurface: typeof openSurface }): void;
    };
    command.onSelect({ openSurface });
    expect(openSurface).toHaveBeenCalledWith("context-mode");

    cleanup();
    for (const remove of removed) expect(remove).toHaveBeenCalledOnce();
    expect(removed[3].mock.invocationCallOrder[0]).toBeLessThan(
      removed[0].mock.invocationCallOrder[0],
    );
  });
});
