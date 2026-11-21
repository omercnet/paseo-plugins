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
  | {
      status: "blocked";
      rejected: RejectedLabel[];
      message: string;
      // Set when an active fallback rule was refused because it would drop a downgrade label.
      fallbackRefusal?: string;
    };

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
  const prefixes = splitPrefixes(raw);
  return prefixes.every((prefix) => prefixProblem(prefix) === null) ? prefixes : [];
}

function splitPrefixes(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((prefix) => prefix.length > 0);
}

// One normalizer for both sides of the downgrade guard's comparison: a configured prefix and a key
// a script returns. NFKC folds compatibility forms (full-width letters, U+2024 for a dot), and every
// control, format and default-ignorable character goes, so an invisible character in a prefix
// cannot make it differ from the key it looks like (UTS #39 skeleton step 2 removes the same code
// points). Case and surrounding space are the caller's business. Validation does not use it: a
// prefix that holds such a character is a visible error there, never silently repaired.
function stripInvisible(text: string): string {
  return text.normalize("NFKC").replace(ESCAPED_CHARS, "");
}

function firstPrefixProblem(raw: string): { prefix: string; problem: string } | null {
  for (const prefix of splitPrefixes(raw)) {
    const problem = prefixProblem(prefix);
    if (problem) return { prefix, problem };
  }
  return null;
}

function prefixProblem(prefix: string): string | null {
  if (prefix.length > MAX_LABEL_KEY_LEN) {
    return `is longer than ${MAX_LABEL_KEY_LEN} characters`;
  }
  if (!LABEL_KEY.test(prefix)) {
    return "may only use letters, digits and . _ / - and must start with a letter or digit";
  }
  const lower = prefix.toLowerCase();
  if (RESERVED_ROOTS.some((root) => root.startsWith(lower) || lower.startsWith(root))) {
    return "is, or starts like, a reserved name (pr-radar, paseo)";
  }
  return null;
}

// Why the whole setting is void, naming the first bad entry; null when every entry is usable.
// The settings screen shows it, so a typo does not silently turn every prefix off.
export function labelPrefixesProblem(raw: string): string | null {
  const bad = firstPrefixProblem(raw);
  return bad
    ? `Ignoring every prefix: ${quotePrefix(bad.prefix)} ${bad.problem}. Fix or remove it.`
    : null;
}

// Keys shown in a notice come from the script, so control and invisible characters are written out.
export function displayLabelKey(key: string, maxShown = MAX_SHOWN_KEY_LEN): string {
  const escaped = key
    .replaceAll("\\", "\\\\")
    .replace(
      ESCAPED_CHARS,
      (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
    );
  return escaped.length > maxShown ? `${escaped.slice(0, maxShown)}...` : escaped;
}

function quoteLabelKey(key: string, maxShown = MAX_SHOWN_KEY_LEN): string {
  return `"${displayLabelKey(key, maxShown).replaceAll('"', '\\"')}"`;
}

// A prefix in a notice about a malformed prefix: every character outside ASCII is written out too,
// because a look-alike letter (Cyrillic a) prints exactly like the Latin one it imitates.
function quotePrefix(prefix: string): string {
  const shown = displayLabelKey(prefix).replace(
    /[^\x20-\x7e]/gu,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
  return `"${shown.replaceAll('"', '\\"')}"`;
}

// How a label is shown in the modal: quoted, so a value cannot pass for a second label. Keys and
// values are quoted the same way, so a backslash is written once as two, never doubled again.
// Only accepted labels reach here: they hold no control or invisible characters, so escaping can at
// most double a character, and twice the limits shows a key or value in full.
export function describeLabel(key: string, value: string): string {
  return `${quoteLabelKey(key, 2 * MAX_LABEL_KEY_LEN)}=${quoteLabelKey(value, 2 * MAX_LABEL_VALUE_LEN)}`;
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

// A prefix admits a key that equals it, any key under a prefix that ends in a separator (`ade.`),
// and a key whose next character after the prefix is a separator (`ade.kind` admits `ade.kind.x`,
// not `ade.kinder`; `team` admits `team/x`, not `teamx`).
const SEPARATORS = [".", "/"];

function admits(prefix: string, key: string): boolean {
  if (!key.startsWith(prefix)) return false;
  if (key.length === prefix.length) return true;
  return SEPARATORS.includes(prefix.slice(-1)) || SEPARATORS.includes(key.charAt(prefix.length));
}

// A key that an allowed prefix admits keeps its name; any other key goes under pr-radar.route.
function finalKey(key: string, prefixes: readonly string[]): string {
  return prefixes.some((prefix) => admits(prefix, key)) ? key : `${ROUTE_NAMESPACE}${key}`;
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
            .map((other) => quoteLabelKey(other))
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

export type FallbackRuleStatus = "active" | "expired" | "too-far" | "not-a-date";

// The date and time fields name a moment that exists. `Date.parse` in V8 rolls 2026-11-31 over to
// 2026-12-01 and other engines read it as invalid, so devices could disagree about when a rule ends.
// A timestamp that fails this is never active.
export function isRealTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const daysInMonth = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return (
    (month ?? 0) >= 1 &&
    (month ?? 0) <= 12 &&
    (day ?? 0) >= 1 &&
    (day ?? 0) <= daysInMonth &&
    (hour ?? 99) <= 23 &&
    (minute ?? 99) <= 59 &&
    (second ?? 0) <= 59
  );
}

export function fallbackRuleStatus(rule: LabelFallbackRule, now: number): FallbackRuleStatus {
  if (!isRealTimestamp(rule.until)) return "not-a-date";
  const until = Date.parse(rule.until);
  if (!Number.isFinite(until) || until <= now) return "expired";
  if (until - now > MAX_FALLBACK_MS) return "too-far";
  return "active";
}

// The next instant a rule changes what it does: it expires, or it comes within the seven day cap
// and starts to apply. Null when no rule has a boundary ahead.
export function nextFallbackBoundary(
  rules: readonly LabelFallbackRule[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const rule of rules) {
    const until = Date.parse(rule.until);
    if (!isRealTimestamp(rule.until) || !Number.isFinite(until)) continue;
    for (const boundary of [until, until - MAX_FALLBACK_MS]) {
      if (boundary > now && (next === null || boundary < next)) next = boundary;
    }
  }
  return next;
}

// A timer reads at most about 24.8 days; the cap keeps a far boundary from firing at once.
const MAX_TIMER_MS = 2_147_483_647;
// Fires a little after the boundary so the clock reads past it when the callback runs.
const BOUNDARY_SLACK_MS = 50;

// Calls `onChange` when a rule's status may have changed, so a screen that decided at render time
// does not keep showing an expired rule as active. The caller re-runs it with the new time, so a
// timer that fired early, or a boundary beyond the timer limit, just schedules the next one.
// Returns a function that cancels the timer.
export function watchFallbackBoundary(
  rules: readonly LabelFallbackRule[],
  now: number,
  onChange: () => void,
): () => void {
  const next = nextFallbackBoundary(rules, now);
  if (next === null) return () => undefined;
  const timer = setTimeout(onChange, Math.min(next - now + BOUNDARY_SLACK_MS, MAX_TIMER_MS));
  return () => clearTimeout(timer);
}

export function describeFallbackStatus(rule: LabelFallbackRule, now: number): string {
  const status = fallbackRuleStatus(rule, now);
  if (status === "not-a-date") return `ignored: ${rule.until} is not a real date`;
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

// What a rule does: the repository without regard to case and the instant it ends, the same way
// `activeFallbackRule` and `fallbackRuleStatus` read it. Two rules with the same target are the
// same rule, whatever their spelling (`Acme/Api` and `acme/api`, `18:00Z` and `19:00+01:00`).
// A timestamp that does not parse stays as written, so it matches only itself.
export function fallbackRuleTarget(rule: Pick<LabelFallbackRule, "repository" | "until">): string {
  const until = Date.parse(rule.until);
  return `${rule.repository.toLowerCase()} ${Number.isFinite(until) ? until : `raw:${rule.until}`}`;
}

export function describeRejection({ key, reason }: RejectedLabel): string {
  return `${quoteLabelKey(key)}: ${reason}`;
}

export const BLOCKED_HEADLINE =
  "Launch blocked: the routing script returned labels PR Radar will not apply";

// The notice lists the first few; the Start New Agent window lists them all.
export function describeRejected(rejected: readonly RejectedLabel[]): string {
  const listed = rejected.slice(0, MAX_LISTED_REJECTIONS).map(describeRejection);
  const more = rejected.length - listed.length;
  const rest = more > 0 ? `; and ${more} more (Start New Agent lists every rejected label)` : "";
  return `${listed.join("; ")}${rest}`;
}

export function describeFallbackRule(rule: LabelFallbackRule): string {
  const note = rule.note ? ` (${rule.note})` : "";
  return `${rule.repository} until ${rule.until}${note}`;
}

// A downgrade label is one an operator trusted to keep its own name: an Allowed label prefix admits
// it. A fallback rule skips every script label, so it must never apply to a set that holds one.
// The guard is wider than the real check, so it fails closed. It reads the raw prefix entries (one
// malformed entry voids the parsed list, which would otherwise let the fallback drop the label),
// ignores case, and normalizes prefixes and keys the same way before comparing, so an invisible
// character in a prefix cannot hide the key it imitates. A prefix that is still malformed (a
// look-alike letter, say) cannot be matched to any key, so the fallback is refused outright.
// Blocking more is harmless.
function downgradeRefusal(labels: unknown, rawPrefixes: string): string | null {
  const prefixes = splitPrefixes(rawPrefixes)
    .map((prefix) => stripInvisible(prefix).toLowerCase())
    .filter((prefix) => prefix.length > 0);
  if (prefixes.length > 0 && labels !== undefined && labels !== null) {
    if (typeof labels !== "object" || Array.isArray(labels)) {
      return "The labels are not an object of keys and values, so PR Radar cannot tell whether they hold a label an Allowed label prefix trusts, and a fallback rule cannot drop it.";
    }
    const held = Object.keys(labels).find((key) => {
      const guarded = stripInvisible(key).trim().toLowerCase();
      return prefixes.some((prefix) => admits(prefix, guarded));
    });
    if (held !== undefined) {
      return `The label ${quoteLabelKey(held)} is one an Allowed label prefix trusts, and a fallback rule cannot drop it.`;
    }
  }
  const bad = firstPrefixProblem(rawPrefixes);
  if (bad) {
    return `The Allowed label prefix ${quotePrefix(bad.prefix)} ${bad.problem}, so PR Radar cannot tell which labels a prefix trusts, and a fallback rule cannot be used until it is fixed.`;
  }
  return null;
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
  const refusal = rule ? downgradeRefusal(labels, policy.routingLabelPrefixes) : null;
  if (rule && refusal) {
    return {
      status: "blocked",
      rejected: checked.rejected,
      fallbackRefusal: `${refusal} Fallback rule ${describeFallbackRule(rule)} does not apply. Fix the script.`,
      message: `${BLOCKED_HEADLINE} (${listed}). ${refusal} Fallback rule ${describeFallbackRule(rule)} does not apply. Fix the script.`,
    };
  }
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
    message: `${BLOCKED_HEADLINE} (${listed}). Fix the script, or add a short-term fallback rule for ${repository} in the PR Radar settings.`,
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
  if (status === "not-a-date") return { error: "That date does not exist." };
  if (status === "expired") return { error: "That time has already passed." };
  if (status === "too-far") {
    return { error: `Fallback rules must end within ${MAX_FALLBACK_DAYS} days.` };
  }
  return { rule: parsed.data };
}
