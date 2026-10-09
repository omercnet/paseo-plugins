/**
 * Host-persisted display favorites through Paseo's settings service. These values
 * change picker convenience only, never browser input ownership or emulation.
 * Retired IDs remain parseable; the current catalogue prunes them at the view.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_CAPTURE_QUALITY } from "./capture-settings";
import { DEVICE_PRESETS } from "./device-presets";

export const browserDisplayPreferencesSchema = z.object({
  captureQuality: z.enum(["low", "medium", "high"]).default(DEFAULT_CAPTURE_QUALITY),
  favoritePresetIds: z.array(z.string().min(1).max(128)).max(DEVICE_PRESETS.length).default([]),
});

export type BrowserDisplayPreferences = z.output<typeof browserDisplayPreferencesSchema>;

/** One revisioned document per plugin host, shared across that host's panels. */
export const browserDisplayPreferences = defineSettings({
  id: "display-preferences",
  scope: "host",
  version: 1,
  schema: browserDisplayPreferencesSchema,
});
