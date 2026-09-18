import { describe, expect, test } from "vitest";
import {
  AttentionListSchema,
  CityRigSnapshotSchema,
  ConvoyListSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  discoverSupervisor,
  EventListSchema,
  endpointUrlSchema,
  GAS_CITY_LIMITS,
  GasCitySettingsSchema,
  SessionActionRequestSchema,
  SessionActionResultSchema,
  SessionListSchema,
  SupervisorDiscoverySchema,
  WorkListSchema,
  WorkspaceRigMappingSchema,
} from "../shared";
import {
  attentionFixture,
  cityRigSnapshotFixture,
  convoysFixture,
  dispatchFormulaRequestFixture,
  dispatchRequestFixture,
  dispatchResultFixture,
  eventsFixture,
  sessionActionRequestFixture,
  sessionActionRequestFixtures,
  sessionActionResultFixture,
  sessionsFixture,
  settingsFixture,
  supervisorDiscoveryFixture,
  workFixture,
  workspaceRigMappingFixture,
} from "./fixtures";

const contractFixtures = [
  [SupervisorDiscoverySchema, supervisorDiscoveryFixture],
  [WorkspaceRigMappingSchema, workspaceRigMappingFixture],
  [CityRigSnapshotSchema, cityRigSnapshotFixture],
  [SessionListSchema, sessionsFixture],
  [ConvoyListSchema, convoysFixture],
  [WorkListSchema, workFixture],
  [EventListSchema, eventsFixture],
  [AttentionListSchema, attentionFixture],
  [DispatchRequestSchema, dispatchRequestFixture],
  [DispatchRequestSchema, dispatchFormulaRequestFixture],
  [DispatchResultSchema, dispatchResultFixture],
  [SessionActionRequestSchema, sessionActionRequestFixture],
  ...sessionActionRequestFixtures.map((fixture) => [SessionActionRequestSchema, fixture] as const),
  [SessionActionResultSchema, sessionActionResultFixture],
  [GasCitySettingsSchema, settingsFixture],
] as const;

describe("Gas City shared contracts", () => {
  test("accepts the canonical fixtures", () => {
    for (const [schema, fixture] of contractFixtures) {
      expect(schema.safeParse(fixture).success).toBe(true);
    }
  });

  test("applies safe observe-only settings defaults", () => {
    expect(GasCitySettingsSchema.parse({})).toEqual({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      mutationsEnabled: false,
      refreshIntervalMs: 10_000,
      eventLimit: 100,
      workspaceMappings: [],
    });
  });

  test("keeps persisted policy out of RPC payloads", () => {
    expect(discoverSupervisor.input.safeParse({}).success).toBe(true);
    expect(discoverSupervisor.input.safeParse({ settings: settingsFixture }).success).toBe(false);
  });

  test("rejects endpoint components forbidden by the public contract", () => {
    for (const endpoint of [
      "http://user:pass@127.0.0.1:8372",
      "http://127.0.0.1:8372?token=secret",
      "http://127.0.0.1:8372/#fragment",
      "file:///tmp/gc.sock",
    ]) {
      expect(endpointUrlSchema.safeParse(endpoint).success).toBe(false);
    }
  });

  test("requires explicit confirmation for dispatch and session mutations", () => {
    expect(
      DispatchRequestSchema.safeParse({ ...dispatchRequestFixture, confirmed: false }).success,
    ).toBe(false);
    expect(
      SessionActionRequestSchema.safeParse({
        ...sessionActionRequestFixture,
        confirmed: false,
      }).success,
    ).toBe(false);
  });

  test("accepts every supported session action", () => {
    for (const fixture of sessionActionRequestFixtures) {
      expect(SessionActionRequestSchema.safeParse(fixture).success).toBe(true);
    }
  });

  test("rejects oversized event collections and configured limits", () => {
    const items = Array.from({ length: GAS_CITY_LIMITS.events + 1 }, () => eventsFixture.items[0]);
    expect(EventListSchema.safeParse({ ...eventsFixture, items }).success).toBe(false);
    expect(
      GasCitySettingsSchema.safeParse({
        ...settingsFixture,
        eventLimit: GAS_CITY_LIMITS.events + 1,
      }).success,
    ).toBe(false);
  });

  test("rejects oversized workspace identifiers", () => {
    expect(
      WorkspaceRigMappingSchema.safeParse({
        ...workspaceRigMappingFixture,
        workspaceId: "x".repeat(GAS_CITY_LIMITS.identifier + 1),
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate explicit workspace mappings", () => {
    expect(
      GasCitySettingsSchema.safeParse({
        ...settingsFixture,
        workspaceMappings: [
          settingsFixture.workspaceMappings[0],
          settingsFixture.workspaceMappings[0],
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects impossible convoy progress", () => {
    expect(
      ConvoyListSchema.safeParse({
        ...convoysFixture,
        items: [{ ...convoysFixture.items[0], totalWork: 1, closedWork: 2 }],
      }).success,
    ).toBe(false);
  });

  test("accepts non-URL dashboard references from Gas City", () => {
    expect(
      DispatchResultSchema.safeParse({
        ...dispatchResultFixture,
        dashboardUrl: "/cities/alpha/runs",
      }).success,
    ).toBe(true);
  });
});
