import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CWD_MODES = ["CWD-WORKTREE", "CWD-BASE"] as const;
export type CwdMode = (typeof CWD_MODES)[number];

export const AUTO_LAUNCH_MODES = ["prompt", "existing_only", "existing_or_clone"] as const;
export type AutoLaunchMode = (typeof AUTO_LAUNCH_MODES)[number];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Unicode general categories Cc (C0, DEL and C1 controls), Cf (format characters: bidi controls
// such as U+202A-U+202E and U+2066-U+2069 used by Trojan Source, CVE-2021-42574, zero-width
// U+200B-U+200F, U+2060-U+2064, U+FEFF, tag characters), Cs (lone surrogates), Zl and Zp.
// Default_Ignorable_Code_Point adds invisible fillers (U+3164, U+115F, U+FFA0) and variation selectors.
export const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
export const ESCAPED_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

export const FALLBACK_NOTE_UNSAFE_ERROR = "The note may not hold control or invisible characters.";

// Shared validator for fallback rule notes (add-rule input and persisted settings). Runs on the
// raw text before any trim, so leading/trailing BOM, bidi or control characters cannot slip past.
export function fallbackNoteProblem(rawNote: string): string | null {
  return UNSAFE_CHARS.test(rawNote) ? FALLBACK_NOTE_UNSAFE_ERROR : null;
}

// A short-term rule that lets a launch go ahead without the routing script's labels when the
// script returns invalid ones. `repository` is `owner/name` or `*`; `until` is an ISO-8601
// timestamp with an offset. Only rules that expire within the next week are honored (see
// `routed-labels.ts`).
export const LabelFallbackRuleSchema = z
  .object({
    repository: z
      .string()
      .max(256)
      .regex(/^(\*|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/, "Use owner/name or *."),
    until: z
      .string()
      .regex(ISO_TIMESTAMP, "Use an ISO-8601 timestamp with a time zone, e.g. 2026-11-25T18:00Z.")
      .refine((value) => Number.isFinite(Date.parse(value)), "Not a real date."),
    note: z
      .string()
      .refine((value) => fallbackNoteProblem(value) === null, {
        message: FALLBACK_NOTE_UNSAFE_ERROR,
      })
      .trim()
      .max(256)
      .optional(),
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

// Drops stored fallback rules whose note holds control or invisible characters before item
// validation runs, so a hand-edited settings file fails closed (the rule is dropped, consistent
// with the pre-v3 strip) without discarding the rest of the user's settings.
function dropUnsafeNoteRules(value: unknown): unknown {
  if (!Array.isArray(value) || value.length > 32) return value;
  return value.filter((entry) => {
    if (typeof entry !== "object" || entry === null) return true;
    const note = (entry as { note?: unknown }).note;
    return typeof note !== "string" || fallbackNoteProblem(note) === null;
  });
}

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
    // `pr-radar`, `pr-radar.*`, `paseo` or `paseo.*`. Kept raw (no `.trim()`): JS `.trim()` strips
    // Unicode whitespace and U+FEFF at the edges, which would hide a malformed entry like
    // `"team/,\uFEFF"` from the fallback guard; ASCII separators are handled by `splitPrefixes`.
    routingLabelPrefixes: z
      .string()
      .max(1_024)
      .default(DEFAULT_PR_RADAR_SETTINGS.routingLabelPrefixes),
    // Temporary rules that let a launch proceed without script labels when they are invalid.
    // A stored rule whose note fails `fallbackNoteProblem` is dropped on load (fail closed).
    routingLabelFallbacks: z
      .preprocess(dropUnsafeNoteRules, z.array(LabelFallbackRuleSchema).max(32))
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
