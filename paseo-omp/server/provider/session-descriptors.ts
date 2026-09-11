import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ompSessionDir } from "../paths";

const MAX_DESCRIPTOR_PREFIX_BYTES = 64 * 1024;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_SESSION_DIRECTORIES = 16_384;
const MAX_SESSION_FILES = 100_000;
const MAX_LIST_RESULTS = 500;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export interface OmpSessionDescriptor {
  id: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface OmpSessionListOptions {
  cwd: string;
  query?: string;
  limit?: number;
  sessionId?: string;
}

export function validateNativeSessionId(value: unknown): string {
  if (typeof value !== "string" || !NATIVE_SESSION_ID.test(value)) {
    throw new Error("Invalid OMP session identifier");
  }
  return value;
}

function safeText(value: unknown, maxBytes: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  )
    return;
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  return sanitized.trim() || undefined;
}

function completePrefixLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    const end = index > start && buffer[index - 1] === 13 ? index - 1 : index;
    lines.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return lines;
}

function parseDescriptor(file: string): OmpSessionDescriptor | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return;
    const buffer = Buffer.allocUnsafe(Math.min(MAX_DESCRIPTOR_PREFIX_BYTES, stat.size));
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    let title: string | undefined;
    for (const bytes of completePrefixLines(buffer.subarray(0, length))) {
      if (bytes.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "title") {
        title = safeText(record.title, 512) ?? title;
        continue;
      }
      if (record.type === "session_info") {
        title ??= safeText(record.title ?? record.sessionName ?? record.name, 512);
        continue;
      }
      if (record.type !== "session") continue;
      const id = validateNativeSessionId(record.id);
      const cwd = safeText(record.cwd, 4_096);
      if (!cwd || !isAbsolute(cwd)) return;
      const headerTitle = safeText(record.title, 512);
      return {
        id,
        cwd,
        ...((title ?? headerTitle) ? { title: title ?? headerTitle } : {}),
        updatedAt: stat.mtime.toISOString(),
      };
    }
  } catch {
    return;
  } finally {
    closeSync(descriptor);
  }
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visitedDirectories = 0;
  while (pending.length > 0 && visitedDirectories < MAX_SESSION_DIRECTORIES) {
    const current = pending.pop();
    if (!current) break;
    visitedDirectories += 1;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SESSION_FILES) return files;
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      else if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
        pending.push({ path, depth: current.depth + 1 });
      }
    }
  }
  return files;
}

export function listOmpSessionDescriptors(
  options: OmpSessionListOptions,
  environment: NodeJS.ProcessEnv = process.env,
): OmpSessionDescriptor[] {
  if (!options.cwd || !isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    throw new Error("OMP session listing requires an absolute working directory");
  }
  const requestedId = options.sessionId ? validateNativeSessionId(options.sessionId) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST_RESULTS);
  const query = options.query?.trim().toLowerCase();
  const matches: OmpSessionDescriptor[] = [];
  for (const file of sessionFiles(ompSessionDir(environment))) {
    const fileName = basename(file);
    const stem = fileName.slice(0, -".jsonl".length);
    if (requestedId && !stem.endsWith(`_${requestedId}`)) continue;
    const descriptor = parseDescriptor(file);
    if (!descriptor || !stem.endsWith(`_${descriptor.id}`) || descriptor.cwd !== options.cwd)
      continue;
    if (
      query &&
      !descriptor.id.toLowerCase().includes(query) &&
      !descriptor.title?.toLowerCase().includes(query)
    ) {
      continue;
    }
    matches.push(descriptor);
  }
  matches.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return matches.slice(0, requestedId ? 2 : limit);
}
