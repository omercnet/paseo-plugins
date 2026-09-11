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
  SessionActionRequestSchema,
  SessionActionResultSchema,
  SessionListSchema,
  SupervisorDiscoverySchema,
  WorkListSchema,
  WorkspaceRigMappingSchema,
} from "./schemas";
import { GasCityRpcSettingsSchema } from "./settings";

const settingsInput = { settings: GasCityRpcSettingsSchema };
const noInput = z.object(settingsInput).strict();
const cityRigInput = z
  .object({
    ...settingsInput,
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
  input: z.object({ ...settingsInput, workspaceId: identifierSchema }).strict(),
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
export const listWork = defineRpc({
  name: "gas-city.list-work",
  input: cityRigInput,
  output: WorkListSchema,
});

export const listEvents = defineRpc({
  name: "gas-city.list-events",
  input: z.discriminatedUnion("scope", [
    z.object({ ...settingsInput, scope: z.literal("supervisor") }).strict(),
    z
      .object({
        ...settingsInput,
        scope: z.literal("city"),
        cityName: nameSchema,
        cursor: z.string().max(GAS_CITY_LIMITS.cursor).nullable(),
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
  input: z.object({ ...settingsInput, request: DispatchRequestSchema }).strict(),
  output: DispatchResultSchema,
});

export const performSessionAction = defineRpc({
  name: "gas-city.perform-session-action",
  input: z.object({ ...settingsInput, request: SessionActionRequestSchema }).strict(),
  output: SessionActionResultSchema,
});
