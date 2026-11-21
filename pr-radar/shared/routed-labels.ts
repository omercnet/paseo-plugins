// Labels a routing script asks for. The script sees PR text on stdin, so its output is untrusted:
// every label is validated all or nothing, and a bad set blocks the launch instead of dropping
// labels (a dropped trust-downgrade label would launch an agent without it).

// The extra labels a script may add. PR Radar always adds `pr-radar.cwd` on top of these.
export const MAX_SCRIPT_LABELS = 16;
export const MAX_LABEL_KEY_LEN = 128;
export const MAX_LABEL_VALUE_LEN = 128;
export const ROUTE_NAMESPACE = "pr-radar.route.";
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
}

export type RoutedLabelsDecision =
  | { status: "ok"; labels: Record<string, string> }
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
  const prefixes = splitPrefixes(raw);
  return prefixes.every((prefix) => prefixProblem(prefix) === null) ? prefixes : [];
}

function splitPrefixes(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((prefix) => prefix.length > 0);
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
  for (const prefix of splitPrefixes(raw)) {
    const problem = prefixProblem(prefix);
    if (problem) {
      return `Ignoring every prefix: ${quoteLabelKey(prefix)} ${problem}. Fix or remove it.`;
    }
  }
  return null;
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

// How a label is shown in the modal: quoted, so a value cannot pass for a second label. Keys and
// values are quoted the same way, so a backslash is written once as two, never doubled again.
export function describeLabel(key: string, value: string): string {
  return `${quoteLabelKey(key)}=${quoteLabelKey(value)}`;
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

export function decideRoutedLabels(input: {
  labels: unknown;
  policy: LabelPolicy;
}): RoutedLabelsDecision {
  const { labels, policy } = input;
  const checked = checkRoutedLabels(labels, parseLabelPrefixes(policy.routingLabelPrefixes));
  if (checked.rejected.length === 0) return { status: "ok", labels: checked.labels };

  return {
    status: "blocked",
    rejected: checked.rejected,
    message: `${BLOCKED_HEADLINE} (${describeRejected(checked.rejected)}). Fix the script.`,
  };
}
