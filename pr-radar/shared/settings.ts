import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CWD_MODES = ["CWD-WORKTREE", "CWD-BASE"] as const;
export type CwdMode = (typeof CWD_MODES)[number];

export const AUTO_LAUNCH_MODES = ["prompt", "existing_only", "existing_or_clone"] as const;
export type AutoLaunchMode = (typeof AUTO_LAUNCH_MODES)[number];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// A short-term rule that lets a launch go ahead without the routing script's labels when the
// script returns invalid ones. `repository` is `owner/name` or `*`; `until` is an ISO-8601
// timestamp with an offset. Only rules that expire within the next week are honored (see
// `routed-labels.ts`).
export const LabelFallbackRuleSchema = z
  .object({
    repository: z
      .string()
      .trim()
      .max(256)
      .regex(/^(\*|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/, "Use owner/name or *."),
    until: z
      .string()
      .regex(ISO_TIMESTAMP, "Use an ISO-8601 timestamp with a time zone, e.g. 2026-11-25T18:00Z.")
      .refine((value) => Number.isFinite(Date.parse(value)), "Not a real date."),
    note: z.string().trim().max(256).optional(),
  })
  .strict();

export type LabelFallbackRule = z.infer<typeof LabelFallbackRuleSchema>;

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
  routingLabelFallbacks: [] as LabelFallbackRule[],
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
    // Temporary rules that let a launch proceed without script labels when they are invalid.
    routingLabelFallbacks: z
      .array(LabelFallbackRuleSchema)
      .max(32)
      .default(() => [...DEFAULT_PR_RADAR_SETTINGS.routingLabelFallbacks]),
  })
  .strict();

export type PrRadarSettings = z.infer<typeof PrRadarSettingsSchema>;

// Version 2 (the label feature without fallback rules) dropped `routingLabelFallbacks`, and its
// migration deleted that key from older documents. Rules are live again in version 3, but a
// document saved before it (version 1, or 2 skipped by an upgrade) may hold rules that version 2
// had already retired, so they are stripped here and fail closed: nobody gets a rule back that a
// release in between removed. A version 3 document is not migrated and keeps its rules.
export function migratePrRadarSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 3 || typeof values !== "object" || values === null || Array.isArray(values)) {
    return values;
  }
  const { routingLabelFallbacks: _retired, ...kept } = values as Record<string, unknown>;
  return kept;
}

export const prRadarSettings = defineSettings({
  id: "pr-radar",
  scope: "host",
  version: 3,
  schema: PrRadarSettingsSchema,
  migrate: migratePrRadarSettings,
});
