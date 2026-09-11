import { describe, expect, test } from "bun:test";
import {
  AttentionListSchema,
  CityRigSnapshotSchema,
  ConvoyListSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  EventListSchema,
  GAS_CITY_LIMITS,
  GasCityProviderSelectionSchema,
  GasCitySettingsSchema,
  listEvents,
  ProviderSelectionListSchema,
  SessionActionRequestSchema,
  SessionActionResultSchema,
  SessionListSchema,
  SupervisorDiscoverySchema,
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
  providerSelectionFixture,
  providerSelectionsFixture,
  sessionActionRequestFixture,
  sessionActionRequestFixtures,
  sessionActionResultFixture,
  sessionsFixture,
  settingsFixture,
  supervisorDiscoveryFixture,
  workspaceRigMappingFixture,
} from "./fixtures";

const contractFixtures = [
  [SupervisorDiscoverySchema, supervisorDiscoveryFixture],
  [WorkspaceRigMappingSchema, workspaceRigMappingFixture],
  [CityRigSnapshotSchema, cityRigSnapshotFixture],
  [SessionListSchema, sessionsFixture],
  [ConvoyListSchema, convoysFixture],
  [EventListSchema, eventsFixture],
  [AttentionListSchema, attentionFixture],
  [DispatchRequestSchema, dispatchRequestFixture],
  [DispatchRequestSchema, dispatchFormulaRequestFixture],
  [DispatchResultSchema, dispatchResultFixture],
  [SessionActionRequestSchema, sessionActionRequestFixture],
  ...sessionActionRequestFixtures.map((fixture) => [SessionActionRequestSchema, fixture] as const),
  [SessionActionResultSchema, sessionActionResultFixture],
  [GasCityProviderSelectionSchema, providerSelectionFixture],
  [ProviderSelectionListSchema, providerSelectionsFixture],
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

  test("rejects oversized lists at the RPC boundary", () => {
    const items = Array.from({ length: GAS_CITY_LIMITS.events + 1 }, () => eventsFixture.items[0]);
    expect(EventListSchema.safeParse({ ...eventsFixture, items }).success).toBe(false);
    expect(
      listEvents.input.safeParse({
        scope: "city",
        cityName: "alpha-city",
        afterSequence: null,
        limit: GAS_CITY_LIMITS.events + 1,
      }).success,
    ).toBe(false);
  });

  test("rejects oversized strings and unknown fields", () => {
    expect(
      WorkspaceRigMappingSchema.safeParse({
        ...workspaceRigMappingFixture,
        workspaceId: "x".repeat(GAS_CITY_LIMITS.identifier + 1),
      }).success,
    ).toBe(false);
    expect(
      GasCityProviderSelectionSchema.safeParse({
        ...providerSelectionFixture,
        unexpected: true,
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
});
