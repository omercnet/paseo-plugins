import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/paseo-beads", () => ({ BeadScreen: () => null, PaseoBeads: () => null }));
vi.mock("../client/ready-beads", () => ({ ReadyBeadsItem: () => null }));

interface Contribution {
  id: string;
  title?: unknown;
}

// The client APIs each host gives this entry. 0.10 already has the deprecated sidebar APIs.
const PASEO_0_10 = ["addWorkspacePanel", "addCommandCenterItem", "addSurface", "addSidebarItem"];
const PASEO_0_11 = [...PASEO_0_10, "addScreen", "addSidebarHeaderItem", "addSidebarFooterItem"];

function hostClient(methods: readonly string[]) {
  const registered: { method: string; contribution: Contribution }[] = [];
  const removed: string[] = [];
  const client = Object.fromEntries(
    methods.map((method) => [
      method,
      (contribution: Contribution) => {
        registered.push({ method, contribution });
        return () => removed.push(`${method}:${contribution.id}`);
      },
    ]),
  ) as unknown as PluginClientContext;
  const registeredIds = () =>
    registered.map(({ method, contribution }) => `${method}:${contribution.id}`);
  return { client, registered, registeredIds, removed };
}

const PANEL_AND_COMMANDS = [
  "addWorkspacePanel:beads",
  "addCommandCenterItem:open-beads",
  "addCommandCenterItem:open-beads-agent",
];

describe("client entry", () => {
  test("keeps only the panel and commands on Paseo 0.10", () => {
    const { client, registeredIds, removed } = hostClient(PASEO_0_10);

    const cleanup = contribute(client);
    expect(registeredIds()).toEqual(PANEL_AND_COMMANDS);

    cleanup();
    expect(removed.sort()).toEqual([...PANEL_AND_COMMANDS].sort());
  });

  test("adds the bead screen, titled from its params, and the ready beads row on Paseo 0.11", () => {
    const { client, registered, registeredIds } = hostClient(PASEO_0_11);

    contribute(client);
    expect(registeredIds()).toEqual([
      ...PANEL_AND_COMMANDS,
      "addScreen:bead",
      "addSidebarHeaderItem:ready-beads",
    ]);

    const screen = registered.find(({ method }) => method === "addScreen")?.contribution;
    const title = screen?.title as (params: Record<string, string>) => string;
    expect(title({ workspace: "ws-1", bead: "demo-d4f" })).toBe("demo-d4f");
    expect(title({ bead: "--help" })).toBe("Bead");
  });
});
