import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { GAS_CITY_LIMITS } from "./limits";
import { endpointUrlSchema, identifierSchema, nameSchema } from "./schemas";

export const DEFAULT_GAS_CITY_SETTINGS = {
  endpointUrl: "http://127.0.0.1:7375",
  allowRemoteEndpoint: false,
  mutationsEnabled: false,
  refreshIntervalMs: 10_000,
  eventLimit: 100,
  workspaceMappings: [],
} as const;

export const WorkspaceMappingOverrideSchema = z
  .object({
    workspaceId: identifierSchema,
    cityName: nameSchema,
    rigName: nameSchema,
  })
  .strict();

export const GasCitySettingsSchema = z
  .object({
    endpointUrl: endpointUrlSchema.default(DEFAULT_GAS_CITY_SETTINGS.endpointUrl),
    allowRemoteEndpoint: z.boolean().default(DEFAULT_GAS_CITY_SETTINGS.allowRemoteEndpoint),
    mutationsEnabled: z.boolean().default(DEFAULT_GAS_CITY_SETTINGS.mutationsEnabled),
    refreshIntervalMs: z
      .number()
      .int()
      .min(2_000)
      .max(60_000)
      .default(DEFAULT_GAS_CITY_SETTINGS.refreshIntervalMs),
    eventLimit: z
      .number()
      .int()
      .min(1)
      .max(GAS_CITY_LIMITS.events)
      .default(DEFAULT_GAS_CITY_SETTINGS.eventLimit),
    workspaceMappings: z
      .array(WorkspaceMappingOverrideSchema)
      .max(GAS_CITY_LIMITS.rigs)
      .default([]),
  })
  .strict()
  .superRefine((settings, context) => {
    const workspaceIds = new Set<string>();
    for (const mapping of settings.workspaceMappings) {
      if (workspaceIds.has(mapping.workspaceId)) {
        context.addIssue({
          code: "custom",
          path: ["workspaceMappings"],
          message: `Duplicate workspace mapping for ${mapping.workspaceId}`,
        });
      }
      workspaceIds.add(mapping.workspaceId);
    }
  });

export type GasCitySettings = z.infer<typeof GasCitySettingsSchema>;
export type WorkspaceMappingOverride = z.infer<typeof WorkspaceMappingOverrideSchema>;

export const gasCitySettings = defineSettings({
  id: "gas-city",
  scope: "host",
  version: 1,
  schema: GasCitySettingsSchema,
});
