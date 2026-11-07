import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const REFRESH_INTERVALS = [5_000, 15_000, 30_000, 60_000] as const;

export const DEFAULT_CONTEXT_MODE_SETTINGS = {
  binaryPath: null,
  refreshIntervalMs: 15_000,
  autoInject: true,
  preferNativeIntegrations: true,
} as const;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export const ContextModeSettingsSchema = z
  .object({
    /** Your own Context Mode executable; null runs the runtime bundled with the plugin. */
    binaryPath: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(isAbsolutePath, "The Context Mode binary path must be absolute.")
      .nullable()
      .default(DEFAULT_CONTEXT_MODE_SETTINGS.binaryPath),
    refreshIntervalMs: z
      .union([z.literal(5_000), z.literal(15_000), z.literal(30_000), z.literal(60_000)])
      .default(DEFAULT_CONTEXT_MODE_SETTINGS.refreshIntervalMs),
    autoInject: z.boolean().default(DEFAULT_CONTEXT_MODE_SETTINGS.autoInject),
    preferNativeIntegrations: z
      .boolean()
      .default(DEFAULT_CONTEXT_MODE_SETTINGS.preferNativeIntegrations),
  })
  .strict();

export type ContextModeSettings = z.infer<typeof ContextModeSettingsSchema>;

const VersionOneSettingsSchema = z.looseObject({
  binaryMode: z.string().optional(),
  binaryPath: z.string().optional(),
});

/**
 * Version 1 searched PATH when no path was set and kept a `showDoctorByDefault` flag nothing read.
 * Only an explicitly configured absolute path survives as the user's own binary.
 */
function migrate(values: unknown): unknown {
  const {
    binaryMode,
    binaryPath,
    showDoctorByDefault: _unused,
    ...rest
  } = VersionOneSettingsSchema.parse(values ?? {});
  const configured = binaryMode !== "automatic" ? binaryPath?.trim() : undefined;
  return { ...rest, binaryPath: configured || null };
}

export const contextModeSettings = defineSettings({
  id: "context-mode",
  scope: "host",
  version: 2,
  schema: ContextModeSettingsSchema,
  migrate,
});
