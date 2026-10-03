import { describe, expect, test, vi } from "vitest";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: vi.fn(), useSettings: vi.fn() }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: vi.fn() }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: vi.fn() }));
vi.mock("react-native", () => ({}));
vi.mock("../client/settings-screen", () => ({ MonitorSettingsScreen: vi.fn() }));

import contribute from "../index.client";

function fakeClient(extra: Record<string, unknown>) {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    return () => {};
  };
  const client = {
    addSettingsScreen: record("settings"),
    addCommandCenterItem: record("command"),
    addSurface: record("surface"),
    addSidebarItem: record("sidebarItem"),
    ...Object.fromEntries(Object.keys(extra).map((name) => [name, record(name)])),
  };
  return { client: client as never, calls };
}

describe("client entry", () => {
  test("registers a screen and live sidebar item on hosts that have them", () => {
    const { client, calls } = fakeClient({ addScreen: 1, addSidebarHeaderItem: 1 });
    contribute(client);
    expect(calls).toContain("addScreen");
    expect(calls).toContain("addSidebarHeaderItem");
    expect(calls).not.toContain("surface");
    expect(calls).not.toContain("sidebarItem");
  });

  test("keeps the surface and static sidebar item on hosts without screens", () => {
    const { client, calls } = fakeClient({});
    contribute(client);
    expect(calls).toContain("surface");
    expect(calls).toContain("sidebarItem");
  });
});
