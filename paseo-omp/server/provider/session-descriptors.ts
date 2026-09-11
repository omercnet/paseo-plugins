import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_DESCRIPTOR_PREFIX_BYTES = 16 * 1024;
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
  cwd?: string;
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
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, length))
      .split(/\r?\n/u);
    let title: string | undefined;
    for (const line of lines.slice(0, 3)) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "title") {
        title = safeText(record.title, 512);
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

function sessionRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment.PASEO_OMP_AGENT_DIR ?? environment.PI_CODING_AGENT_DIR;
  return configured ? join(configured, "sessions") : join(homedir(), ".omp", "agent", "sessions");
}

export function listOmpSessionDescriptors(
  options: OmpSessionListOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): OmpSessionDescriptor[] {
  const requestedId = options.sessionId ? validateNativeSessionId(options.sessionId) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST_RESULTS);
  const query = options.query?.trim().toLowerCase();
  const matches: OmpSessionDescriptor[] = [];
  let fileCount = 0;
  let directories: Dirent<string>[];
  try {
    directories = readdirSync(sessionRoot(environment), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const directory of directories.slice(0, MAX_SESSION_DIRECTORIES)) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(directory.parentPath, directory.name);
    let files: Dirent<string>[];
    try {
      files = readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (fileCount >= MAX_SESSION_FILES) break;
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      fileCount += 1;
      const candidateId = file.name.slice(file.name.lastIndexOf("_") + 1, -".jsonl".length);
      if (!NATIVE_SESSION_ID.test(candidateId) || (requestedId && candidateId !== requestedId))
        continue;
      const descriptor = parseDescriptor(join(file.parentPath, file.name));
      if (!descriptor || descriptor.id !== candidateId) continue;
      if (options.cwd && descriptor.cwd !== options.cwd) continue;
      if (
        query &&
        !descriptor.id.toLowerCase().includes(query) &&
        !descriptor.cwd.toLowerCase().includes(query) &&
        !descriptor.title?.toLowerCase().includes(query)
      ) {
        continue;
      }
      matches.push(descriptor);
    }
    if (fileCount >= MAX_SESSION_FILES) break;
  }
  matches.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return matches.slice(0, requestedId ? 2 : limit);
}
