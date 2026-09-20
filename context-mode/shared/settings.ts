import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const REFRESH_INTERVALS = [5_000, 15_000, 30_000, 60_000] as const;

export const DEFAULT_CONTEXT_MODE_SETTINGS = {
  binaryMode: "path",
  binaryPath: "",
  refreshIntervalMs: 15_000,
  showDoctorByDefault: false,
  autoInject: true,
  preferNativeIntegrations: true,
} as const;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export const ContextModeSettingsSchema = z
  .object({
    binaryMode: z.enum(["path", "automatic"]).default(DEFAULT_CONTEXT_MODE_SETTINGS.binaryMode),
    binaryPath: z.string().trim().max(4_096).default(DEFAULT_CONTEXT_MODE_SETTINGS.binaryPath),
    refreshIntervalMs: z
      .union([z.literal(5_000), z.literal(15_000), z.literal(30_000), z.literal(60_000)])
      .default(DEFAULT_CONTEXT_MODE_SETTINGS.refreshIntervalMs),
    showDoctorByDefault: z.boolean().default(DEFAULT_CONTEXT_MODE_SETTINGS.showDoctorByDefault),
    autoInject: z.boolean().default(DEFAULT_CONTEXT_MODE_SETTINGS.autoInject),
    preferNativeIntegrations: z
      .boolean()
      .default(DEFAULT_CONTEXT_MODE_SETTINGS.preferNativeIntegrations),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.binaryMode !== "path" || settings.binaryPath.length === 0) return;
    if (!isAbsolutePath(settings.binaryPath)) {
      context.addIssue({
        code: "custom",
        path: ["binaryPath"],
        message: "The Context Mode binary path must be absolute.",
      });
    }
  });

export type ContextModeSettings = z.infer<typeof ContextModeSettingsSchema>;

export const contextModeSettings = defineSettings({
  id: "context-mode",
  scope: "host",
  version: 1,
  schema: ContextModeSettingsSchema,
});
