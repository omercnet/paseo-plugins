export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_PUBLIC_STRING_LENGTH = 64 * 1024;
const MAX_PUBLIC_COLLECTION_ITEMS = 128;
const MAX_PUBLIC_DEPTH = 16;
const MAX_PUBLIC_NODES = 2_048;
const REDACTED = "<redacted>";
const OMITTED = "<omitted>";

const SENSITIVE_KEY =
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|auth|authorization|cookie|credential|password|private_?key|secret|session_?token)(?:$|_)/iu;
const CREDENTIAL_ASSIGNMENT =
  /\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|credential|password|private[ _-]?key|secret|session[ _-]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/giu;
const TOKEN_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/gu;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=:\[])(\/(?!\/)[^\s"'`<>\])},;]+)/gu;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\[^\s"'`<>\])},;]+/gu;
export class BoundedStringSet {
  private readonly values = new Map<string, true>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Bounded set limit must be positive");
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    if (this.values.delete(value)) {
      this.values.set(value, true);
      return;
    }
    this.values.set(value, true);
    if (this.values.size <= this.limit) return;
    const oldest = this.values.keys().next().value;
    if (oldest !== undefined) this.values.delete(oldest);
  }
}

export class OmpPublicError extends Error {}



/**
 * Sanitizes every provider-owned value before it can cross the plugin boundary. Explicit child
 * environment values are included as literals because their names are not guaranteed to identify
 * credentials. Values shorter than four characters are excluded to avoid corrupting ordinary
 * prose; credential-shaped assignments are still removed regardless of length.
 */
export class OmpPublicDataFilter {
  private readonly sensitiveValues: readonly string[];

  constructor(values: Iterable<string> = []) {
    this.sensitiveValues = [...new Set(values)]
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
  }

  text(input: string, maxLength = MAX_PUBLIC_STRING_LENGTH): string {
    let output = input;
    for (const value of this.sensitiveValues) output = output.split(value).join(REDACTED);
    output = output
      .replace(CREDENTIAL_ASSIGNMENT, (_match, name: string, separator: string) => {
        return `${name}${separator}${REDACTED}`;
      })
      .replace(BEARER_CREDENTIAL, `Bearer ${REDACTED}`)
      .replace(TOKEN_CREDENTIAL, REDACTED)
      .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<absolute path>`)
      .replace(WINDOWS_ABSOLUTE_PATH, "<absolute path>");
    return output.length <= maxLength ? output : `${output.slice(0, maxLength)}<truncated>`;
  }

  json(input: unknown, maxStringLength = MAX_PUBLIC_STRING_LENGTH): JsonValue {
    const seen = new WeakSet<object>();
    let nodes = 0;
    const visit = (value: unknown, key: string | undefined, depth: number): JsonValue => {
      nodes += 1;
      if (nodes > MAX_PUBLIC_NODES || depth > MAX_PUBLIC_DEPTH) return OMITTED;
      if (key && SENSITIVE_KEY.test(key)) return REDACTED;
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string") return this.text(value, maxStringLength);
      if (typeof value !== "object") return OMITTED;
      if (seen.has(value)) return OMITTED;
      seen.add(value);
      if (Array.isArray(value)) {
        return value
          .slice(0, MAX_PUBLIC_COLLECTION_ITEMS)
          .map((item) => visit(item, undefined, depth + 1));
      }
      const output: { [key: string]: JsonValue } = {};
      for (const [childKey, childValue] of Object.entries(value).slice(
        0,
        MAX_PUBLIC_COLLECTION_ITEMS,
      )) {
        output[this.text(childKey, 256)] = visit(childValue, childKey, depth + 1);
      }
      return output;
    };
    return visit(input, undefined, 0);
  }
}
