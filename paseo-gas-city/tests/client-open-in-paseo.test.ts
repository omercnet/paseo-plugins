import { describe, expect, test } from "bun:test";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { gasCityAgentConfig, openSessionInPaseo } from "../client/open-in-paseo";
import { sessionsFixture } from "./fixtures";

describe("Open in Paseo", () => {
  test("uses the gas-city-session provider with exact provider options", () => {
    expect(
      gasCityAgentConfig({
        cityName: "alpha-city",
        sessionName: "reviewer-a1b",
        endpointUrl: "http://127.0.0.1:7375",
      }),
    ).toEqual({
      provider: "gas-city-session",
      options: {
        cityName: "alpha-city",
        sessionName: "reviewer-a1b",
        endpointUrl: "http://127.0.0.1:7375",
      },
    });
  });

  test("creates the bridge agent inside the active workspace and opens it", async () => {
    const observed: {
      captured?: PaseoWorkspaceAgentCreateOptions;
      openedAgentId?: string;
    } = {};
    const paseo = {
      workspaces: {
        ref(workspaceId: string) {
          expect(workspaceId).toBe("workspace-1");
          return {
            agents: {
              async create(options: PaseoWorkspaceAgentCreateOptions) {
                observed.captured = options;
                return { id: "paseo-agent-1" };
              },
            },
          };
        },
      },
    } as unknown as PaseoApi;

    const agentId = await openSessionInPaseo({
      paseo,
      session: sessionsFixture.items[0],
      endpointUrl: "http://127.0.0.1:7375",
      workspaceId: "workspace-1",
      onOpenAgent(id) {
        observed.openedAgentId = id;
      },
    });

    expect(agentId).toBe("paseo-agent-1");
    expect(observed.openedAgentId).toBe("paseo-agent-1");
    expect(observed.captured).toEqual({
      config: {
        provider: "gas-city-session",
        options: {
          cityName: "alpha-city",
          sessionName: "reviewer-a1b",
          endpointUrl: "http://127.0.0.1:7375",
        },
      },
      title: "Gas City: Review API",
    });
  });

  test("creates a global bridge agent with the requested working directory", async () => {
    let captured: unknown;
    const paseo = {
      agents: {
        async create(options: unknown) {
          captured = options;
          return { id: "paseo-agent-global" };
        },
      },
    } as unknown as PaseoApi;

    await expect(
      openSessionInPaseo({
        paseo,
        session: sessionsFixture.items[0],
        endpointUrl: "http://127.0.0.1:7375",
        cwd: "/work/alpha",
      }),
    ).resolves.toBe("paseo-agent-global");
    expect(captured).toMatchObject({ cwd: "/work/alpha", title: "Gas City: Review API" });
  });
});
