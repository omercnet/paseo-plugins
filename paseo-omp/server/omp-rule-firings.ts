import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpRuleFirings, OmpRuleFiring } from "../shared/omp-rules";
import { currentOmpEnvironment } from "./paths";
import { listOmpSessionDescriptors } from "./provider/session-descriptors";

export interface FiringLimits {
  /** Newest sessions to count. */
  sessions: number;
  /** Text read from one session file; the rest of a longer file is left uncounted. */
  fileBytes: number;
  /** Text read across all sessions of one request; sessions already counted cost nothing. */
  totalBytes: number;
  ms: number;
}

const DEFAULT_LIMITS: FiringLimits = {
  sessions: 500,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  ms: 8_000,
};
const MAX_RULES = 500;
const MAX_CACHED_FILES = 2_000;
const MAX_NAME_CHARS = 256;

/** One `ttsr_injection` line of an OMP session file: the rules injected after a match. */
const InjectionSchema = z.object({
  type: z.literal("ttsr_injection"),
  timestamp: z.string().optional(),
  injectedRules: z.array(z.string()),
});

interface Tally {
  count: number;
  /** Epoch ms of the latest firing, or 0 when no entry had a readable time. */
  last: number;
}

interface FileFirings {
  mtimeMs: number;
  size: number;
  truncated: boolean;
  rules: Map<string, Tally>;
}

/** Counts per session file, valid while its modification time and size are unchanged. */
const cache = new Map<string, FileFirings>();

function remember(path: string, firings: FileFirings): void {
  cache.delete(path);
  cache.set(path, firings);
  if (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function addTo(rules: Map<string, Tally>, name: string, at: number, count = 1): void {
  const tally = rules.get(name) ?? { count: 0, last: 0 };
  tally.count += count;
  tally.last = Math.max(tally.last, at);
  rules.set(name, tally);
}

async function countFile(path: string, readBytes: number): Promise<Map<string, Tally>> {
  const rules = new Map<string, Tally>();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const lines = createInterface({
      input: handle.createReadStream({ encoding: "utf8", end: readBytes - 1 }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.includes('"ttsr_injection"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = InjectionSchema.safeParse(parsed);
      if (!entry.success) continue;
      const at = Date.parse(entry.data.timestamp ?? "");
      for (const name of entry.data.injectedRules) {
        if (name && name.length <= MAX_NAME_CHARS) addTo(rules, name, Number.isNaN(at) ? 0 : at);
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return rules;
}

/**
 * How often each rule fired, from the `ttsr_injection` entries of OMP's session files: the
 * sessions of `cwd` when given, else every session in the store. Newest sessions first, bounded
 * by `limits`; files already counted are reused while their mtime and size are unchanged.
 */
export async function readRuleFirings(
  input: { cwd?: string; sessionDir?: string },
  environment: NodeJS.ProcessEnv = currentOmpEnvironment(),
  limits: FiringLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): Promise<{ firings: OmpRuleFiring[]; sessions: number; partial: boolean }> {
  const started = now();
  const sessions = await listOmpSessionDescriptors(
    {
      limit: limits.sessions,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.sessionDir ? { sessionDir: input.sessionDir } : {}),
    },
    environment,
  );
  const totals = new Map<string, Tally>();
  let counted = 0;
  let bytes = 0;
  let partial = false;
  for (const session of sessions) {
    const file = session.transcriptFile;
    if (!file) continue;
    if (now() - started > limits.ms) {
      partial = true;
      break;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    let firings = cache.get(file);
    if (firings?.mtimeMs !== info.mtimeMs || firings.size !== info.size) {
      const readBytes = Math.min(info.size, limits.fileBytes);
      if (bytes + readBytes > limits.totalBytes) {
        partial = true;
        break;
      }
      bytes += readBytes;
      firings = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        truncated: info.size > limits.fileBytes,
        rules: await countFile(file, readBytes).catch(() => new Map<string, Tally>()),
      };
      remember(file, firings);
    }
    if (firings.truncated) partial = true;
    counted += 1;
    for (const [name, tally] of firings.rules) addTo(totals, name, tally.last, tally.count);
  }
  const firings = [...totals]
    .map(([name, tally]) => ({
      name,
      count: tally.count,
      lastFiredAt: tally.last > 0 ? new Date(tally.last).toISOString() : null,
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, MAX_RULES);
  return { firings, sessions: counted, partial };
}

export function resolveListOmpRuleFirings(input: RpcInput<typeof listOmpRuleFirings>) {
  return readRuleFirings(input);
}
