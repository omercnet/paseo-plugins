import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GAS_CITY_LIMITS } from "./limits";
import {
  AttentionListSchema,
  CityRigSnapshotSchema,
  ConvoyListSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  EventListSchema,
  identifierSchema,
  nameSchema,
  ProviderSelectionListSchema,
  SessionActionRequestSchema,
  SessionActionResultSchema,
  SessionListSchema,
  SupervisorDiscoverySchema,
  WorkspaceRigMappingSchema,
} from "./schemas";

const noInput = z.object({}).strict();
const cityRigInput = z
  .object({
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
  })
  .strict();

export const discoverSupervisor = defineRpc({
  name: "gas-city.discover-supervisor",
  input: noInput,
  output: SupervisorDiscoverySchema,
});

export const resolveWorkspaceRig = defineRpc({
  name: "gas-city.resolve-workspace-rig",
  input: z.object({ workspaceId: identifierSchema }).strict(),
  output: WorkspaceRigMappingSchema,
});

export const getCityRigSnapshot = defineRpc({
  name: "gas-city.get-city-rig-snapshot",
  input: cityRigInput,
  output: CityRigSnapshotSchema,
});

export const listSessions = defineRpc({
  name: "gas-city.list-sessions",
  input: cityRigInput,
  output: SessionListSchema,
});

export const listConvoys = defineRpc({
  name: "gas-city.list-convoys",
  input: cityRigInput,
  output: ConvoyListSchema,
});

export const listEvents = defineRpc({
  name: "gas-city.list-events",
  input: z.discriminatedUnion("scope", [
    z
      .object({
        scope: z.literal("supervisor"),
        cursor: z.string().max(GAS_CITY_LIMITS.cursor).nullable(),
        limit: z.number().int().min(1).max(GAS_CITY_LIMITS.events),
      })
      .strict(),
    z
      .object({
        scope: z.literal("city"),
        cityName: nameSchema,
        afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        limit: z.number().int().min(1).max(GAS_CITY_LIMITS.events),
      })
      .strict(),
  ]),
  output: EventListSchema,
});

export const listAttention = defineRpc({
  name: "gas-city.list-attention",
  input: cityRigInput,
  output: AttentionListSchema,
});

export const dispatchWork = defineRpc({
  name: "gas-city.dispatch-work",
  input: DispatchRequestSchema,
  output: DispatchResultSchema,
});

export const performSessionAction = defineRpc({
  name: "gas-city.perform-session-action",
  input: SessionActionRequestSchema,
  output: SessionActionResultSchema,
});

export const listProviderSelections = defineRpc({
  name: "gas-city.list-provider-selections",
  input: z.object({ cityName: nameSchema.nullable() }).strict(),
  output: ProviderSelectionListSchema,
});
