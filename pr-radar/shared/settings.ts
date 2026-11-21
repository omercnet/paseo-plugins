import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CWD_MODES = ["CWD-WORKTREE", "CWD-BASE"] as const;
export type CwdMode = (typeof CWD_MODES)[number];

export const AUTO_LAUNCH_MODES = ["prompt", "existing_only", "existing_or_clone"] as const;
export type AutoLaunchMode = (typeof AUTO_LAUNCH_MODES)[number];

export const DEFAULT_PR_RADAR_SETTINGS = {
  sourceCodeDir: "~/src",
  defaultCwdMode: "CWD-WORKTREE",
  autoLaunchMode: "prompt",
  defaultProfile: "Model Router",
  defaultProvider: "",
  defaultModel: "",
  defaultEffort: "",
  defaultModeId: "",
  defaultContextMode: "",
  routingScriptPath: "",
  routingLabelPrefixes: "",
} as const;

export const PrRadarSettingsSchema = z
  .object({
    /** Base directory for local repositories and auto-clones. */
    sourceCodeDir: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .default(DEFAULT_PR_RADAR_SETTINGS.sourceCodeDir),
    /** Whether new agents open in a dedicated PR worktree or the base checkout. */
    defaultCwdMode: z.enum(CWD_MODES).default(DEFAULT_PR_RADAR_SETTINGS.defaultCwdMode),
    /** When Start New Agent should prompt vs. launch immediately. */
    autoLaunchMode: z.enum(AUTO_LAUNCH_MODES).default(DEFAULT_PR_RADAR_SETTINGS.autoLaunchMode),
    /** Preferred Paseo agent profile name when starting a new agent. */
    defaultProfile: z.string().trim().max(256).default(DEFAULT_PR_RADAR_SETTINGS.defaultProfile),
    /** Optional TUI vendor/provider override (e.g. claude, codex, omp, pi). */
    defaultProvider: z.string().trim().max(256).default(DEFAULT_PR_RADAR_SETTINGS.defaultProvider),
    /** Optional model ID/version override. */
    defaultModel: z.string().trim().max(256).default(DEFAULT_PR_RADAR_SETTINGS.defaultModel),
    /** Optional reasoning effort / thinkingOptionId override (e.g. low, medium, high, xhigh). */
    defaultEffort: z.string().trim().max(128).default(DEFAULT_PR_RADAR_SETTINGS.defaultEffort),
    /** Optional permission/context modeId override (e.g. default, bypassPermissions, plan). */
    defaultModeId: z.string().trim().max(128).default(DEFAULT_PR_RADAR_SETTINGS.defaultModeId),
    /** Optional provider context mode option (passed as options.contextMode when set). */
    defaultContextMode: z
      .string()
      .trim()
      .max(128)
      .default(DEFAULT_PR_RADAR_SETTINGS.defaultContextMode),
    /** Optional path to an executable routing script that reads PR JSON on stdin. */
    routingScriptPath: z
      .string()
      .trim()
      .max(4_096)
      .default(DEFAULT_PR_RADAR_SETTINGS.routingScriptPath),
    // Label key prefixes the routing script may use as-is, separated by commas or spaces (for
    // example `ade.`). Every other script label is stored as `pr-radar.route.<key>`. Never admits
    // `pr-radar`, `pr-radar.*`, `paseo` or `paseo.*`.
    routingLabelPrefixes: z
      .string()
      .trim()
      .max(1_024)
      .default(DEFAULT_PR_RADAR_SETTINGS.routingLabelPrefixes),
  })
  .strict();

export type PrRadarSettings = z.infer<typeof PrRadarSettingsSchema>;

// Settings saved before label fallback rules moved out of the label feature may still hold
// `routingLabelFallbacks`. The schema is strict, so the stored document must lose it before it is
// parsed; a retired rule then enables nothing.
const RETIRED_SETTINGS_KEYS = ["routingLabelFallbacks"] as const;

export function migratePrRadarSettings(values: unknown): unknown {
  if (typeof values !== "object" || values === null || Array.isArray(values)) return values;
  const retired: readonly string[] = RETIRED_SETTINGS_KEYS;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !retired.includes(key)));
}

export const prRadarSettings = defineSettings({
  id: "pr-radar",
  scope: "host",
  version: 2,
  schema: PrRadarSettingsSchema,
  migrate: migratePrRadarSettings,
});
