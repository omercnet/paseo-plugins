import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_INHERITED_ENVIRONMENT_NAMES = 256;
export const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);

export const providerLaunchSettingsSchema = z.object({
  inheritEnv: z.array(environmentNameSchema).max(MAX_INHERITED_ENVIRONMENT_NAMES).default([]),
});

export type ProviderLaunchSettings = z.infer<typeof providerLaunchSettingsSchema>;

export const providerLaunchSettings = defineSettings({
  id: "provider-launch",
  scope: "host",
  version: 1,
  schema: providerLaunchSettingsSchema,
});
