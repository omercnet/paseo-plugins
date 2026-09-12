import { constants, type Dir } from "node:fs";
import { type FileHandle, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ompSessionDir } from "../paths";

const MAX_DESCRIPTOR_PREFIX_BYTES = 64 * 1024;
const MAX_DESCRIPTOR_SUFFIX_BYTES = 64 * 1024;
const MAX_PROMPT_PREVIEW_CHARS = 160;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_SCAN_DIRECTORIES = 1_024;
const MAX_SCAN_FILES = 10_000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_MS = 1_000;
const SCAN_YIELD_INTERVAL = 128;
const MAX_LIST_RESULTS = 500;
const MAX_CHILD_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_TRANSCRIPT_MESSAGES = 100_000;
const CHILD_TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export interface OmpSessionDescriptor {
  id: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  transcriptFile?: string;
  firstPromptPreview?: string;
  lastPromptPreview?: string;
}

export interface OmpPersistedSubagentTranscript {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: unknown[];
}
export interface OmpSessionListOptions {
  cwd: string;
  query?: string;
  limit?: number;
  sessionId?: string;
  sessionDir?: string;
}

interface ScanBudget {
  startedAt: number;
  directories: number;
  files: number;
  bytes: number;
  entries: number;
  exhausted: boolean;
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

function validatedCwd(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    !isAbsolute(value)
  ) {
    return;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return;
  }
  return value;
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
function completeSuffixLines(buffer: Buffer): Buffer[] {
  const firstNewline = buffer.indexOf(10);
  if (firstNewline < 0) return [];
  return completePrefixLines(buffer.subarray(firstNewline + 1));
}

function promptPreview(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .slice(0, 64)
            .flatMap((part) =>
              part && typeof part === "object" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("\n")
        : "";
  const sanitized = safeText(text, MAX_DESCRIPTOR_PREFIX_BYTES)?.replace(/\s+/gu, " ").trim();
  if (!sanitized) return;
  const characters = Array.from(sanitized);
  if (characters.length <= MAX_PROMPT_PREVIEW_CHARS) return sanitized;
  return `${characters.slice(0, MAX_PROMPT_PREVIEW_CHARS - 1).join("")}…`;
}

function budgetExceeded(budget: ScanBudget): boolean {
  return (
    budget.exhausted ||
    budget.directories >= MAX_SCAN_DIRECTORIES ||
    budget.files >= MAX_SCAN_FILES ||
    budget.bytes >= MAX_SCAN_BYTES ||
    Date.now() - budget.startedAt >= MAX_SCAN_MS
  );
}

async function yieldToEventLoop(): Promise<void> {
  const result = Promise.withResolvers<void>();
  setImmediate(result.resolve);
  await result.promise;
}

async function parseDescriptor(
  file: string,
  budget: ScanBudget,
): Promise<OmpSessionDescriptor | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const prefixBytes = Math.min(MAX_DESCRIPTOR_PREFIX_BYTES, stat.size);
    const suffixBytes = Math.min(MAX_DESCRIPTOR_SUFFIX_BYTES, Math.max(0, stat.size - prefixBytes));
    if (budget.bytes + prefixBytes + suffixBytes > MAX_SCAN_BYTES) {
      budget.exhausted = true;
      return;
    }
    budget.bytes += prefixBytes + suffixBytes;
    const prefix = Buffer.allocUnsafe(prefixBytes);
    const { bytesRead: prefixRead } = await handle.read(prefix, 0, prefix.length, 0);
    const suffix = Buffer.allocUnsafe(suffixBytes);
    const { bytesRead: suffixRead } = suffixBytes
      ? await handle.read(suffix, 0, suffix.length, stat.size - suffixBytes)
      : { bytesRead: 0 };
    let title: string | undefined;
    let id: string | undefined;
    let cwd: string | undefined;
    let firstPromptPreview: string | undefined;
    let lastPromptPreview: string | undefined;
    const lines = [
      ...completePrefixLines(prefix.subarray(0, prefixRead)),
      ...completeSuffixLines(suffix.subarray(0, suffixRead)),
    ];
    for (const bytes of lines) {
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
      if (record.type === "session") {
        id = validateNativeSessionId(record.id);
        cwd = validatedCwd(record.cwd);
        if (!cwd) return;
        title ??= safeText(record.title, 512);
        continue;
      }
      if (record.type !== "message") continue;
      const message = record.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "user") continue;
      const preview = promptPreview(messageRecord.content);
      if (!preview) continue;
      firstPromptPreview ??= preview;
      lastPromptPreview = preview;
    }
    if (!id || !cwd) return;
    return {
      id,
      cwd,
      transcriptFile: file,
      ...(title ? { title } : {}),
      updatedAt: stat.mtime.toISOString(),
      ...(firstPromptPreview ? { firstPromptPreview } : {}),
      ...(lastPromptPreview ? { lastPromptPreview } : {}),
    };
  } catch {
    return;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function retainNewest(
  descriptors: OmpSessionDescriptor[],
  descriptor: OmpSessionDescriptor,
  limit: number,
): void {
  descriptors.push(descriptor);
  descriptors.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  if (descriptors.length > limit) descriptors.pop();
}

async function scanSessionFiles(
  root: string,
  budget: ScanBudget,
  visit: (file: string) => Promise<boolean>,
): Promise<void> {
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0 && !budgetExceeded(budget)) {
    const current = pending.pop();
    if (!current) return;
    budget.directories += 1;
    let directory: Dir;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    try {
      for await (const entry of directory) {
        budget.entries += 1;
        if (budget.entries % SCAN_YIELD_INTERVAL === 0) await yieldToEventLoop();
        if (budgetExceeded(budget)) return;
        const path = join(current.path, entry.name);
        if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
          if (pending.length + budget.directories < MAX_SCAN_DIRECTORIES) {
            pending.push({ path, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        budget.files += 1;
        if (!entry.name.endsWith(".jsonl")) continue;
        if (!(await visit(path))) return;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
}

export async function listOmpSessionDescriptors(
  options: OmpSessionListOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<OmpSessionDescriptor[]> {
  if (!options.cwd || !isAbsolute(options.cwd) || options.cwd.includes("\0")) {
    throw new Error("OMP session listing requires an absolute working directory");
  }
  const requestedId = options.sessionId ? validateNativeSessionId(options.sessionId) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST_RESULTS);
  const retentionLimit = requestedId ? 2 : limit;
  const query = options.query?.trim().toLowerCase();
  const matches: OmpSessionDescriptor[] = [];
  const budget: ScanBudget = {
    startedAt: Date.now(),
    directories: 0,
    files: 0,
    bytes: 0,
    entries: 0,
    exhausted: false,
  };
  const root = options.sessionDir
    ? options.sessionDir.startsWith("~/")
      ? join(environment.HOME ?? environment.USERPROFILE ?? homedir(), options.sessionDir.slice(2))
      : resolve(options.cwd, options.sessionDir)
    : ompSessionDir(environment);
  await scanSessionFiles(root, budget, async (file) => {
    const fileName = basename(file);
    const stem = fileName.slice(0, -".jsonl".length);
    if (requestedId && !stem.endsWith(`_${requestedId}`)) return true;
    const descriptor = await parseDescriptor(file, budget);
    if (!descriptor || !stem.endsWith(`_${descriptor.id}`) || descriptor.cwd !== options.cwd)
      return !budgetExceeded(budget);
    if (
      query &&
      !descriptor.id.toLowerCase().includes(query) &&
      !descriptor.title?.toLowerCase().includes(query) &&
      !descriptor.firstPromptPreview?.toLowerCase().includes(query) &&
      !descriptor.lastPromptPreview?.toLowerCase().includes(query)
    ) {
      return !budgetExceeded(budget);
    }
    retainNewest(matches, descriptor, retentionLimit);
    return !requestedId || matches.length < 2;
  });
  return matches;
}

export async function readOmpPersistedSubagentTranscript(
  parentSessionFile: string,
  childTranscriptId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<OmpPersistedSubagentTranscript> {
  signal?.throwIfAborted();
  if (
    !isAbsolute(parentSessionFile) ||
    !parentSessionFile.endsWith(".jsonl") ||
    parentSessionFile.includes("\0") ||
    !CHILD_TRANSCRIPT_ID.test(childTranscriptId) ||
    basename(childTranscriptId) !== childTranscriptId
  ) {
    throw new Error("Invalid OMP child transcript descriptor");
  }
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      parentSessionFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP parent transcript could not be opened");
  }
  try {
    const stat = await parentHandle.stat();
    if (!stat.isFile()) throw new Error("OMP parent transcript is not a file");
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
  const canonicalParent = await realpath(parentSessionFile);
  const parentExtension = extname(canonicalParent);
  const expectedDirectory = canonicalParent.slice(0, -parentExtension.length);
  const canonicalDirectory = await realpath(expectedDirectory).catch(() => undefined);
  if (!canonicalDirectory || canonicalDirectory !== expectedDirectory) {
    throw new Error("OMP child transcript directory is not canonically owned by its parent");
  }
  const sessionFile = join(canonicalDirectory, `${childTranscriptId}.jsonl`);
  let handle: FileHandle;
  try {
    handle = await open(
      sessionFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP child transcript could not be opened");
  }
  try {
    const [stat, canonicalChild] = await Promise.all([handle.stat(), realpath(sessionFile)]);
    if (
      !stat.isFile() ||
      stat.size > MAX_CHILD_TRANSCRIPT_BYTES ||
      dirname(canonicalChild) !== canonicalDirectory ||
      canonicalChild !== sessionFile
    ) {
      throw new Error("OMP child transcript failed ownership validation");
    }
    const bytes = await handle.readFile();
    signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const messages: unknown[] = [];
    let nativeSessionId: string | undefined;
    for (const line of text.split("\n")) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "session") {
        const candidateId = validateNativeSessionId(record.id);
        const candidateCwd = validatedCwd(record.cwd);
        if (candidateCwd !== cwd)
          throw new Error("OMP child transcript belongs to another workspace");
        nativeSessionId ??= candidateId;
        if (nativeSessionId !== candidateId)
          throw new Error("OMP child transcript identity changed");
      } else if (record.type === "message" && record.message !== undefined) {
        if (messages.length >= MAX_CHILD_TRANSCRIPT_MESSAGES) {
          throw new Error("OMP child transcript exceeds message limits");
        }
        messages.push(record.message);
      }
    }
    if (!nativeSessionId) throw new Error("OMP child transcript is missing session identity");
    return { sessionFile, nativeSessionId, byteLength: bytes.byteLength, messages };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("OMP child transcript could not be decoded");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
