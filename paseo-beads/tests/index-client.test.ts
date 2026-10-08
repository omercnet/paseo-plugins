import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.client";

vi.mock("../client/paseo-beads", () => ({ BeadScreen: () => null, PaseoBeads: () => null }));
vi.mock("../client/ready-beads", () => ({ ReadyBeadsItem: () => null }));

interface Contribution {
  id: string;
  title?: unknown;
}

const HOST_METHODS = [
  "addWorkspacePanel",
  "addCommandCenterItem",
  "addScreen",
  "addSidebarHeaderItem",
];

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
  test("adds the bead screen, titled from its params, and the ready beads row", () => {
    const { client, registered, registeredIds } = hostClient(HOST_METHODS);

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

  test("removes every registration on cleanup", () => {
    const { client, registeredIds, removed } = hostClient(HOST_METHODS);

    contribute(client)();
    expect(removed.sort()).toEqual(registeredIds().sort());
  });
});
