export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_PUBLIC_STRING_BYTES = 1024 * 1024;
const MAX_PUBLIC_COLLECTION_ITEMS = 128;
const MAX_PUBLIC_DEPTH = 16;
const MAX_PUBLIC_NODES = 2_048;
const REDACTED = "<redacted>";
const OMITTED = "<omitted>";

const SENSITIVE_KEY =
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|auth|authorization|cookie|credential|password|private_?key|secret|session_?token)(?:$|_)/iu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{1,}/giu;
const CREDENTIAL_ASSIGNMENT =
  /\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|credential|password|private[ _-]?key|secret|session[ _-]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const TOKEN_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/gu;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=:[])(\/(?!\/)[^\s"'`<>\])},;]+)/gu;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\[^\s"'`<>\])},;]+/gu;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = "<truncated>";
  const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > budget) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}

/** Returns Infinity as soon as a depth, item, node, string, or cumulative byte limit is crossed. */
export function boundedJsonBytes(
  value: unknown,
  maxBytes: number,
  maxItems = MAX_PUBLIC_COLLECTION_ITEMS,
  maxStringBytes = maxBytes,
): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_PUBLIC_NODES || current.depth > MAX_PUBLIC_DEPTH) {
      return Number.POSITIVE_INFINITY;
    }
    const item = current.value;
    if (item === null || typeof item === "boolean" || typeof item === "number") continue;
    if (typeof item === "string") {
      const itemBytes = utf8Bytes(item);
      if (itemBytes > maxStringBytes) return Number.POSITIVE_INFINITY;
      bytes += itemBytes;
      if (bytes > maxBytes) return Number.POSITIVE_INFINITY;
      continue;
    }
    if (typeof item !== "object") return Number.POSITIVE_INFINITY;
    if (Array.isArray(item)) {
      if (item.length > maxItems) return Number.POSITIVE_INFINITY;
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    let itemCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const child = (item as Record<string, unknown>)[key];
      if (child === undefined) continue;
      itemCount += 1;
      if (itemCount > maxItems) return Number.POSITIVE_INFINITY;
      bytes += utf8Bytes(key);
      if (bytes > maxBytes) return Number.POSITIVE_INFINITY;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return bytes;
}

export class BoundedStringSet {
  private readonly values = new Map<string, true>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Bounded set limit must be positive");
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

export class OmpPublicDataFilter {
  private sensitiveValues: string[] = [];

  constructor(values: Iterable<string> = []) {
    this.addSensitiveValues(values);
  }

  addSensitiveValues(values: Iterable<string>): void {
    this.sensitiveValues = [...new Set([...this.sensitiveValues, ...values])]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
  }

  text(input: string, maxBytes = MAX_PUBLIC_STRING_BYTES): string {
    let output = input.replace(BEARER_CREDENTIAL, `Bearer ${REDACTED}`);
    for (const value of this.sensitiveValues) output = output.split(value).join(REDACTED);
    output = output
      .replace(CREDENTIAL_ASSIGNMENT, (_match, name: string, separator: string) => {
        return `${name}${separator}${REDACTED}`;
      })
      .replace(TOKEN_CREDENTIAL, REDACTED)
      .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<absolute path>`)
      .replace(WINDOWS_ABSOLUTE_PATH, "<absolute path>");
    return truncateUtf8(output, maxBytes);
  }

  json(input: unknown, maxStringBytes = MAX_PUBLIC_STRING_BYTES): JsonValue {
    const seen = new WeakSet<object>();
    let nodes = 0;
    const visit = (value: unknown, key: string | undefined, depth: number): JsonValue => {
      nodes += 1;
      if (nodes > MAX_PUBLIC_NODES || depth > MAX_PUBLIC_DEPTH) return OMITTED;
      if (key && SENSITIVE_KEY.test(key)) return REDACTED;
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string") return this.text(value, maxStringBytes);
      if (typeof value !== "object") return OMITTED;
      if (seen.has(value)) return OMITTED;
      seen.add(value);
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        const length = Math.min(value.length, MAX_PUBLIC_COLLECTION_ITEMS);
        for (let index = 0; index < length; index += 1) {
          output.push(visit(value[index], undefined, depth + 1));
        }
        return output;
      }
      const output = Object.create(null) as { [key: string]: JsonValue };
      let itemCount = 0;
      for (const childKey in value) {
        if (!Object.hasOwn(value, childKey)) continue;
        itemCount += 1;
        if (itemCount > MAX_PUBLIC_COLLECTION_ITEMS) break;
        const safeKey = this.text(childKey, 256);
        if (
          safeKey === "__proto__" ||
          safeKey === "constructor" ||
          safeKey === "prototype" ||
          Object.hasOwn(output, safeKey)
        ) {
          continue;
        }
        output[safeKey] = visit((value as Record<string, unknown>)[childKey], childKey, depth + 1);
      }
      return output;
    };
    return visit(input, undefined, 0);
  }
}
