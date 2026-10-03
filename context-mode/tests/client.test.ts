import { describe, expect, test, vi } from "vitest";

vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("../client/context-mode-footer", () => ({ ContextModeFooter: () => null }));
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
  test("uses screens on 0.11 and falls back when openScreen is absent", () => {
    for (const supported of [true, false]) {
      let command: { onSelect(input: unknown): void } | undefined;
      const client = {
        addSettingsScreen: vi.fn(() => vi.fn()),
        addScreen: vi.fn(() => vi.fn()),
        addSidebarFooterItem: vi.fn(() => vi.fn()),
        addSurface: vi.fn(() => vi.fn()),
        addSidebarItem: vi.fn(() => vi.fn()),
        addCommandCenterItem: vi.fn((value) => {
          command = value;
          return vi.fn();
        }),
        openScreen: supported ? vi.fn() : undefined,
        openSettings: vi.fn(),
      };
      const cleanup = contribute(client as never);
      const openScreen = vi.fn();
      const openSurface = vi.fn();
      if (!command) throw new Error("Command was not registered");
      command.onSelect({ openScreen, openSurface });
      if (supported) {
        expect(client.addScreen).toHaveBeenCalledWith(
          expect.objectContaining({ id: "context-mode" }),
        );
        expect(client.addSidebarFooterItem).toHaveBeenCalledOnce();
        expect(client.addSurface).not.toHaveBeenCalled();
        expect(openScreen).toHaveBeenCalledWith({ screenId: "context-mode" });
        expect(openSurface).not.toHaveBeenCalled();
      } else {
        expect(client.addScreen).not.toHaveBeenCalled();
        expect(client.addSidebarFooterItem).not.toHaveBeenCalled();
        expect(openSurface).toHaveBeenCalledWith("context-mode");
      }
      cleanup();
    }
  });
});
