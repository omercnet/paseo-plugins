import { type LabelFallbackRule, LabelFallbackRuleSchema } from "./settings";

// Labels a routing script asks for. The script sees PR text on stdin, so its output is untrusted:
// every label is validated all or nothing, and a bad set blocks the launch instead of dropping
// labels (a dropped trust-downgrade label would launch an agent without it).

// The extra labels a script may add. PR Radar always adds `pr-radar.cwd` on top of these.
export const MAX_SCRIPT_LABELS = 16;
export const MAX_LABEL_KEY_LEN = 128;
export const MAX_LABEL_VALUE_LEN = 128;
export const ROUTE_NAMESPACE = "pr-radar.route.";
export const MAX_FALLBACK_DAYS = 7;
const MAX_FALLBACK_MS = MAX_FALLBACK_DAYS * 24 * 60 * 60 * 1_000;
const MAX_SHOWN_KEY_LEN = 64;

const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// Unicode general categories Cc (C0, DEL and C1 controls), Cf (format characters: bidi controls
// such as U+202A-U+202E and U+2066-U+2069 used by Trojan Source, CVE-2021-42574, zero-width
// U+200B-U+200F, U+2060-U+2064, U+FEFF, tag characters), Cs (lone surrogates), Zl and Zp.
// Default_Ignorable_Code_Point adds invisible fillers (U+3164, U+115F, U+FFA0) and variation selectors.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const ESCAPED_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
// A script that returns more raw keys than this is rejected before any per-key work.
const MAX_RAW_LABELS = MAX_SCRIPT_LABELS * 4;
const MAX_LISTED_REJECTIONS = 5;
const RESERVED_ROOTS = ["pr-radar", "paseo"];

export interface RejectedLabel {
  key: string;
  reason: string;
}

export interface CheckedLabels {
  labels: Record<string, string>;
  rejected: RejectedLabel[];
}

export interface LabelPolicy {
  routingLabelPrefixes: string;
  routingLabelFallbacks: readonly LabelFallbackRule[];
}

export type RoutedLabelsDecision =
  | { status: "ok"; labels: Record<string, string> }
  | { status: "fallback"; rejected: RejectedLabel[]; rule: LabelFallbackRule; warning: string }
  | { status: "blocked"; rejected: RejectedLabel[]; message: string };

export class RoutedLabelsBlockedError extends Error {
  readonly rejected: RejectedLabel[];

  constructor(message: string, rejected: RejectedLabel[]) {
    super(message);
    this.name = "RoutedLabelsBlockedError";
    this.rejected = rejected;
  }
}

// A prefix that is a root of a reserved family (`p`, `paseo`) or extends one (`paseo-`, `pr-radar/`)
// could admit look-alikes of reserved keys. One malformed entry voids the whole setting, so a typo
// can never widen a prefix: every script label then stays namespaced.
export function parseLabelPrefixes(raw: string): string[] {
  const prefixes = raw.split(/[\s,]+/).filter((prefix) => prefix.length > 0);
  const usable = prefixes.every((prefix) => {
    const lower = prefix.toLowerCase();
    const nearReserved = RESERVED_ROOTS.some(
      (root) => root.startsWith(lower) || lower.startsWith(root),
    );
    return prefix.length < MAX_LABEL_KEY_LEN && LABEL_KEY.test(prefix) && !nearReserved;
  });
  return usable ? prefixes : [];
}

// Keys shown in a notice come from the script, so control and invisible characters are written out.
export function displayLabelKey(key: string): string {
  const escaped = key
    .replaceAll("\\", "\\\\")
    .replace(
      ESCAPED_CHARS,
      (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
    );
  return escaped.length > MAX_SHOWN_KEY_LEN ? `${escaped.slice(0, MAX_SHOWN_KEY_LEN)}...` : escaped;
}

function quoteLabelKey(key: string): string {
  return `"${displayLabelKey(key).replaceAll('"', '\\"')}"`;
}

// How a label is shown in the modal: quoted, so a value cannot pass for a second label.
export function describeLabel(key: string, value: string): string {
  return `${quoteLabelKey(key)}=${JSON.stringify(displayLabelKey(value))}`;
}

function isReservedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "pr-radar" ||
    lower.startsWith("pr-radar.") ||
    lower === "paseo" ||
    lower.startsWith("paseo.")
  );
}

function keyProblem(rawKey: string): string | null {
  if (UNSAFE_CHARS.test(rawKey)) return "key contains control or invisible characters";
  const key = rawKey.trim();
  if (!key) return "key is empty";
  if (isReservedKey(key)) {
    return "key is reserved (pr-radar, pr-radar.*, paseo and paseo.* belong to PR Radar and Paseo)";
  }
  if (!LABEL_KEY.test(key)) {
    return "key may only use letters, digits and . _ / - and must start with a letter or digit";
  }
  return null;
}

function valueProblem(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return "value must be a string";
  if (UNSAFE_CHARS.test(rawValue)) return "value contains control or invisible characters";
  const value = rawValue.trim();
  if (!value) return "value is empty";
  if (value.length > MAX_LABEL_VALUE_LEN) {
    return `value is longer than ${MAX_LABEL_VALUE_LEN} characters`;
  }
  return null;
}

// A key that starts with an allowed prefix keeps its name; any other key goes under pr-radar.route.
function finalKey(key: string, prefixes: readonly string[]): string {
  return prefixes.some((prefix) => key.startsWith(prefix)) ? key : `${ROUTE_NAMESPACE}${key}`;
}

interface LabelEntry {
  rawKey: string;
  key: string;
  value: string;
  problem: string | null;
}

function toEntry(
  [rawKey, rawValue]: [string, unknown],
  prefixes: readonly string[],
): LabelEntry & { final: string | null } {
  const keyIssue = keyProblem(rawKey);
  const key = rawKey.trim();
  const final = keyIssue ? null : finalKey(key, prefixes);
  const lengthIssue =
    final && final.length > MAX_LABEL_KEY_LEN
      ? `key is longer than ${MAX_LABEL_KEY_LEN} characters once namespaced as ${displayLabelKey(final.slice(0, 32))}...`
      : null;
  const problem = keyIssue ?? lengthIssue ?? valueProblem(rawValue);
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  return { rawKey, key, value, problem, final: lengthIssue ? null : final };
}

export function checkRoutedLabels(raw: unknown, prefixes: readonly string[]): CheckedLabels {
  if (raw === undefined || raw === null) return { labels: {}, rejected: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      labels: {},
      rejected: [{ key: "labels", reason: "labels must be an object of string values" }],
    };
  }
  const rawEntries = Object.entries(raw);
  if (rawEntries.length > MAX_RAW_LABELS) {
    return {
      labels: {},
      rejected: [
        {
          key: "labels",
          reason: `${rawEntries.length} labels returned; at most ${MAX_SCRIPT_LABELS} are allowed`,
        },
      ],
    };
  }
  const entries = rawEntries.map((entry) => toEntry(entry, prefixes));

  const bySlot = new Map<string, string[]>();
  for (const { final, rawKey } of entries) {
    if (final) bySlot.set(final, [...(bySlot.get(final) ?? []), rawKey]);
  }

  const rejected: RejectedLabel[] = [];
  const labels: Record<string, string> = {};
  for (const entry of entries) {
    const sharing = entry.final ? (bySlot.get(entry.final) ?? []) : [];
    const collision =
      sharing.length > 1
        ? `key collides with ${sharing
            .filter((other) => other !== entry.rawKey)
            .slice(0, 2)
            .map(quoteLabelKey)
            .join(", ")} (both become ${entry.final})`
        : null;
    const problem = entry.problem ?? collision;
    if (problem) {
      rejected.push({ key: entry.rawKey, reason: problem });
    } else if (entry.final) {
      labels[entry.final] = entry.value;
    }
  }
  if (rejected.length === 0 && Object.keys(labels).length > MAX_SCRIPT_LABELS) {
    rejected.push({
      key: "labels",
      reason: `${Object.keys(labels).length} labels returned; at most ${MAX_SCRIPT_LABELS} are allowed`,
    });
  }
  return { labels: rejected.length > 0 ? {} : labels, rejected };
}

export type FallbackRuleStatus = "active" | "expired" | "too-far";

export function fallbackRuleStatus(rule: LabelFallbackRule, now: number): FallbackRuleStatus {
  const until = Date.parse(rule.until);
  if (!Number.isFinite(until) || until <= now) return "expired";
  if (until - now > MAX_FALLBACK_MS) return "too-far";
  return "active";
}

export function describeFallbackStatus(rule: LabelFallbackRule, now: number): string {
  const status = fallbackRuleStatus(rule, now);
  if (status === "expired") return `expired ${rule.until}`;
  if (status === "too-far") {
    return `ignored: ends more than ${MAX_FALLBACK_DAYS} days from now (${rule.until})`;
  }
  return `active until ${rule.until}`;
}

export function activeFallbackRule(
  rules: readonly LabelFallbackRule[],
  repository: string,
  now: number,
): LabelFallbackRule | undefined {
  const repo = repository.toLowerCase();
  return rules.find(
    (rule) =>
      (rule.repository === "*" || rule.repository.toLowerCase() === repo) &&
      fallbackRuleStatus(rule, now) === "active",
  );
}

export function describeRejected(rejected: readonly RejectedLabel[]): string {
  const listed = rejected
    .slice(0, MAX_LISTED_REJECTIONS)
    .map(({ key, reason }) => `${quoteLabelKey(key)}: ${reason}`);
  const more = rejected.length - listed.length;
  return `${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

export function describeFallbackRule(rule: LabelFallbackRule): string {
  const note = rule.note ? ` (${rule.note})` : "";
  return `${rule.repository} until ${rule.until}${note}`;
}

export function decideRoutedLabels(input: {
  labels: unknown;
  repository: string;
  policy: LabelPolicy;
  now: number;
}): RoutedLabelsDecision {
  const { labels, repository, policy, now } = input;
  const checked = checkRoutedLabels(labels, parseLabelPrefixes(policy.routingLabelPrefixes));
  if (checked.rejected.length === 0) return { status: "ok", labels: checked.labels };

  const listed = describeRejected(checked.rejected);
  const rule = activeFallbackRule(policy.routingLabelFallbacks, repository, now);
  if (rule) {
    return {
      status: "fallback",
      rejected: checked.rejected,
      rule,
      warning: `Routing script labels rejected (${listed}). Fallback rule ${describeFallbackRule(rule)} lets this launch go ahead without any script labels.`,
    };
  }
  return {
    status: "blocked",
    rejected: checked.rejected,
    message: `Launch blocked: the routing script returned labels PR Radar will not apply (${listed}). Fix the script, or add a short-term fallback rule for ${repository} in the PR Radar settings.`,
  };
}

export type ParsedFallbackRule = { rule: LabelFallbackRule } | { error: string };

// "owner/name 2026-11-25T18:00Z optional note": the add-rule field in settings.
export function parseFallbackRuleInput(input: string, now: number): ParsedFallbackRule {
  const [repository, until, ...noteWords] = input.trim().split(/\s+/);
  if (!repository || !until) {
    return {
      error:
        "Enter: owner/name (or *), an ISO-8601 time such as 2026-11-25T18:00Z, then an optional note.",
    };
  }
  const note = noteWords.join(" ");
  const parsed = LabelFallbackRuleSchema.safeParse({
    repository,
    until,
    ...(note ? { note } : {}),
  });
  if (!parsed.success) {
    return {
      error: "Use owner/name (or *) and an ISO-8601 time with a zone, e.g. 2026-11-25T18:00Z.",
    };
  }
  const status = fallbackRuleStatus(parsed.data, now);
  if (status === "expired") return { error: "That time has already passed." };
  if (status === "too-far") {
    return { error: `Fallback rules must end within ${MAX_FALLBACK_DAYS} days.` };
  }
  return { rule: parsed.data };
}
