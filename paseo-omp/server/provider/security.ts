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
const MAX_SENSITIVE_VALUES = 256;
const MAX_SENSITIVE_VALUE_BYTES = 256 * 1024;
const MAX_PUBLIC_JSON_BYTES = 256 * 1024;
const REDACTED = "<redacted>";
const OMITTED = "<omitted>";

const SENSITIVE_KEY =
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|auth|authorization|cookie|credential|password|private_?key|secret|session_?token)(?:$|_)/iu;
const AUTHORIZATION_CREDENTIAL = /\bAuthorization\s*[:=]\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{1,}/giu;
const CREDENTIAL_ASSIGNMENT =
  /\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|credential|password|private[ _-]?key|secret|session[ _-]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const TOKEN_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/gu;
const INCOMPLETE_TOKEN_CREDENTIAL =
  /(?:^|[^A-Za-z0-9_])((?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{0,7})$/u;
const STREAM_CREDENTIAL_MARKERS = ["authorization", "bearer "] as const;
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

function replaceControlCharacters(value: string): string {
  let output = "";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f))
      continue;
    output += `${value.slice(segmentStart, index)}<control>`;
    segmentStart = index + 1;
  }
  return segmentStart === 0 ? value : output + value.slice(segmentStart);
}

/** Returns Infinity as soon as a depth, item, node, string, or cumulative byte limit is crossed. */
export function boundedJsonBytes(
  value: unknown,
  maxBytes: number,
  maxItems = MAX_PUBLIC_COLLECTION_ITEMS,
  maxStringBytes = maxBytes,
  maxNodes = MAX_PUBLIC_NODES,
): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes || current.depth > MAX_PUBLIC_DEPTH) {
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

function prefixTable(value: string): Uint32Array {
  const table = new Uint32Array(value.length);
  let matched = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched]) matched = table[matched - 1] ?? 0;
    if (value[index] === value[matched]) matched += 1;
    table[index] = matched;
  }
  return table;
}

function trailingPrefixLength(input: string, pattern: string, table: Uint32Array): number {
  if (pattern.length < 2) return 0;
  const start = Math.max(0, input.length - pattern.length + 1);
  let matched = 0;
  for (let index = start; index < input.length; index += 1) {
    while (matched > 0 && input[index] !== pattern[matched]) matched = table[matched - 1] ?? 0;
    if (input[index] === pattern[matched]) matched += 1;
  }
  if (matched === 0) return 0;
  const lastComplete = input.lastIndexOf(pattern);
  return lastComplete >= 0 && input.length - matched < lastComplete + pattern.length ? 0 : matched;
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
export class OmpCleanupFailure extends Error {
  constructor(
    message: string,
    readonly cleanup: Promise<void>,
  ) {
    super(message);
  }
}

export class OmpPublicDataFilter {
  private readonly sensitiveValueSet = new Set<string>();
  private readonly sensitiveValues: string[] = [];
  private readonly sensitivePrefixTables = new Map<string, Uint32Array>();
  private sensitiveValueBytes = 0;

  constructor(values: Iterable<string> = []) {
    this.addSensitiveValues(values);
  }

  addSensitiveValues(values: Iterable<string>): void {
    const additions: string[] = [];
    let addedBytes = 0;
    for (const value of values) {
      if (utf8Bytes(value) < 4) continue;
      if (this.sensitiveValueSet.has(value) || additions.includes(value)) continue;
      additions.push(value);
      addedBytes += utf8Bytes(value);
    }
    if (
      this.sensitiveValueSet.size + additions.length > MAX_SENSITIVE_VALUES ||
      this.sensitiveValueBytes + addedBytes > MAX_SENSITIVE_VALUE_BYTES
    ) {
      throw new Error("OMP sensitive-value redaction budget exceeded");
    }
    additions.sort((left, right) => right.length - left.length);
    for (const value of additions) {
      this.sensitiveValueSet.add(value);
      this.sensitivePrefixTables.set(value, prefixTable(value));
      this.sensitiveValueBytes += utf8Bytes(value);
      const index = this.sensitiveValues.findIndex((existing) => existing.length < value.length);
      if (index < 0) this.sensitiveValues.push(value);
      else this.sensitiveValues.splice(index, 0, value);
    }
  }
  streamText(
    input: string,
    final = false,
    maxBytes = MAX_PUBLIC_STRING_BYTES,
  ): { text: string; pending: boolean } {
    if (final) return { text: this.text(input, maxBytes), pending: false };
    let holdback = 0;
    for (const value of this.sensitiveValues) {
      const table = this.sensitivePrefixTables.get(value);
      if (!table) continue;
      holdback = Math.max(holdback, trailingPrefixLength(input, value, table));
    }
    const lowerInput = input.toLowerCase();
    for (const marker of STREAM_CREDENTIAL_MARKERS) {
      const maxLength = Math.min(lowerInput.length, marker.length);
      for (let length = maxLength; length >= 4 && length > holdback; length -= 1) {
        if (lowerInput.endsWith(marker.slice(0, length))) {
          holdback = length;
          break;
        }
      }
    }
    const token = INCOMPLETE_TOKEN_CREDENTIAL.exec(input)?.[1];
    if (token) holdback = Math.max(holdback, token.length);
    const safeInput = holdback === 0 ? input : input.slice(0, -holdback);
    return { text: this.text(safeInput, maxBytes), pending: holdback > 0 };
  }

  hasUnsafeStreamSuffix(input: unknown): boolean {
    const stack: unknown[] = [input];
    const seen = new WeakSet<object>();
    let nodes = 0;
    while (stack.length > 0) {
      nodes += 1;
      if (nodes > MAX_PUBLIC_NODES) return true;
      const value = stack.pop();
      if (typeof value === "string") {
        if (this.streamText(value).pending) return true;
      } else if (Array.isArray(value)) {
        if (seen.has(value)) continue;
        seen.add(value);
        for (const child of value) stack.push(child);
      } else if (value && typeof value === "object") {
        if (seen.has(value)) continue;
        seen.add(value);
        for (const key in value) {
          if (Object.hasOwn(value, key)) stack.push((value as Record<string, unknown>)[key]);
        }
      }
    }
    return false;
  }

  text(input: string, maxBytes = MAX_PUBLIC_STRING_BYTES): string {
    let output = input.replace(AUTHORIZATION_CREDENTIAL, `Authorization: ${REDACTED}`);
    output = output.replace(BEARER_CREDENTIAL, `Bearer ${REDACTED}`);
    for (const value of this.sensitiveValues) output = output.split(value).join(REDACTED);
    output = replaceControlCharacters(
      output
        .replace(CREDENTIAL_ASSIGNMENT, (_match, name: string, separator: string) => {
          return `${name}${separator}${REDACTED}`;
        })
        .replace(TOKEN_CREDENTIAL, REDACTED),
    )
      .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<absolute path>`)
      .replace(WINDOWS_ABSOLUTE_PATH, "<absolute path>");
    return truncateUtf8(output, maxBytes);
  }

  json(
    input: unknown,
    maxStringBytes = MAX_PUBLIC_STRING_BYTES,
    maxOutputBytes = MAX_PUBLIC_JSON_BYTES,
  ): JsonValue {
    const seen = new WeakSet<object>();
    let nodes = 0;
    let remaining = maxOutputBytes;
    const consume = (bytes: number) => {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    };
    const boundedString = (value: string): string => {
      const sanitized = this.text(value, Math.min(maxStringBytes, remaining));
      const encodedBytes = utf8Bytes(JSON.stringify(sanitized));
      if (consume(encodedBytes)) return sanitized;
      const fallback = this.text(sanitized, Math.max(0, Math.floor((remaining - 2) / 2)));
      consume(utf8Bytes(JSON.stringify(fallback)));
      return fallback;
    };
    const visit = (value: unknown, key: string | undefined, depth: number): JsonValue => {
      nodes += 1;
      if (nodes > MAX_PUBLIC_NODES || depth > MAX_PUBLIC_DEPTH || remaining < 16) return OMITTED;
      if (key && SENSITIVE_KEY.test(key)) {
        consume(utf8Bytes(JSON.stringify(REDACTED)));
        return REDACTED;
      }
      if (value === null) {
        consume(4);
        return null;
      }
      if (typeof value === "boolean") {
        consume(value ? 4 : 5);
        return value;
      }
      if (typeof value === "number") {
        const safe = Number.isFinite(value) ? value : null;
        consume(utf8Bytes(JSON.stringify(safe)));
        return safe;
      }
      if (typeof value === "string") return boundedString(value);
      if (typeof value !== "object" || seen.has(value)) return OMITTED;
      seen.add(value);
      if (Array.isArray(value)) {
        if (!consume(2)) return OMITTED;
        const output: JsonValue[] = [];
        const length = Math.min(value.length, MAX_PUBLIC_COLLECTION_ITEMS);
        for (let index = 0; index < length && remaining >= 16; index += 1) {
          if (index > 0) consume(1);
          output.push(visit(value[index], undefined, depth + 1));
        }
        return output;
      }
      if (!consume(2)) return OMITTED;
      const output = Object.create(null) as { [key: string]: JsonValue };
      let itemCount = 0;
      for (const childKey in value) {
        if (!Object.hasOwn(value, childKey) || remaining < 32) continue;
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
        const keyBytes = utf8Bytes(JSON.stringify(safeKey)) + 1 + (itemCount > 1 ? 1 : 0);
        if (!consume(keyBytes)) break;
        output[safeKey] = visit((value as Record<string, unknown>)[childKey], childKey, depth + 1);
      }
      return output;
    };
    return visit(input, undefined, 0);
  }
}
