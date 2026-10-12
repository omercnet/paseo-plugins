import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import type { Session } from "../shared/usage";

const CLOCK_TICKS = 100;
const CPUS = Math.max(1, os.availableParallelism());
const MAX_DEPTH = 64;
const DEFAULT_PAGE_BYTES = 4096;
const AT_PAGESZ = 6;

/** The kernel's page size from the auxiliary vector; arm64 and ppc64 kernels often use 16K or 64K. */
export function readPageSize(auxvPath = "/proc/self/auxv"): number {
  try {
    const auxv = readFileSync(auxvPath);
    const little = os.endianness() === "LE";
    // Entries are (type, value) pairs of machine words; 64-bit hosts are the only ones in practice.
    for (let at = 0; at + 16 <= auxv.length; at += 16) {
      const type = Number(little ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at));
      if (type !== AT_PAGESZ) continue;
      const value = Number(little ? auxv.readBigUInt64LE(at + 8) : auxv.readBigUInt64BE(at + 8));
      const power = value > 0 && (value & (value - 1)) === 0;
      return power && value >= DEFAULT_PAGE_BYTES && value <= 2 ** 20 ? value : DEFAULT_PAGE_BYTES;
    }
  } catch {
    // Not Linux, or not readable.
  }
  return DEFAULT_PAGE_BYTES;
}

export const PAGE_BYTES = readPageSize();

export interface ProcInfo {
  /** `pid:starttime`, unique even after the kernel reuses a pid. */
  key: string;
  pid: number;
  ppid: number;
  /** User plus system CPU time so far, in ticks. */
  ticks: number;
  rss: number;
  comm: string;
  /** Agent that launched this process, from the environment Paseo gave it, if any. */
  agentId: string | null;
}

export interface Stat {
  ppid: number;
  ticks: number;
  start: number;
  rss: number;
  comm: string;
}

/** Parses /proc/<pid>/stat. The command may contain spaces and parentheses, so split at the last `)`. */
export function parseStat(text: string): Stat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  // Fields after the command start at number 3, so field n is at index n - 3.
  const fields = text.slice(close + 2).split(" ");
  const numbers = {
    ppid: Number(fields[1]),
    ticks: Number(fields[11]) + Number(fields[12]),
    start: Number(fields[19]),
    rss: Number(fields[21]) * PAGE_BYTES,
  };
  if (!Object.values(numbers).every(Number.isFinite)) return null;
  // The kernel reports rss as a signed number; a negative one must not poison the whole reading.
  return { comm: text.slice(open + 1, close), ...numbers, rss: Math.max(0, numbers.rss) };
}

/** The whole environment is read, but only the agent id is kept; the rest can hold secrets and is dropped. */
export function parseAgentId(environ: string): string | null {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith("PASEO_AGENT_ID=")) return entry.slice("PASEO_AGENT_ID=".length) || null;
  }
  return null;
}

/**
 * Every process listed under /proc, which includes other users' that are readable. The environment
 * is read whole but only `PASEO_AGENT_ID` is kept, and it is read again on every scan, because a
 * process can replace its environment when it execs without changing its pid or start time. A
 * process whose environment cannot be read (another user's) has no agent.
 */
export function readProcs(root = "/proc"): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = parseStat(readFileSync(`${root}/${name}/stat`, "utf8"));
      if (!stat) continue;
      let agentId: string | null;
      try {
        agentId = parseAgentId(readFileSync(`${root}/${name}/environ`, "utf8"));
      } catch {
        agentId = null;
      }
      procs.push({ key: `${name}:${stat.start}`, pid: Number(name), agentId, ...stat });
    } catch {
      // The process exited while it was being read.
    }
  }
  return procs;
}

export interface SessionLoad {
  agentId: string;
  cores: number;
  rss: number;
  command: string;
  processes: number;
}

export interface Attribution {
  sessions: SessionLoad[];
  other: { cores: number; rss: number };
  /** CPU ticks per process, to diff against on the next scan. */
  ticks: Map<string, number>;
}

/**
 * Charges each process to the agent that launched it. Tools often scrub or reset their
 * environment, so an untagged process inherits from its nearest tagged ancestor.
 *
 * `previous` is the last scan's ticks, or null for the very first scan, which has nothing to diff
 * against and so charges no CPU. After that, a process that is new since the last scan is charged
 * all the CPU it has used, bounded by what every CPU could have given in the interval.
 */
export function attribute(
  procs: readonly ProcInfo[],
  previous: ReadonlyMap<string, number> | null,
  elapsedSeconds: number,
): Attribution {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const ticks = new Map<string, number>();
  const sessions = new Map<string, SessionLoad & { topCores: number; topRss: number }>();
  const other = { cores: 0, rss: 0 };
  const budget = elapsedSeconds * CLOCK_TICKS * CPUS;

  for (const proc of procs) {
    ticks.set(proc.key, proc.ticks);
    let owner = proc;
    for (let depth = 0; !owner.agentId && depth < MAX_DEPTH; depth++) {
      const parent = byPid.get(owner.ppid);
      if (!parent || parent === owner) break;
      owner = parent;
    }
    let cores = 0;
    if (previous && elapsedSeconds > 0) {
      const earlier = previous.get(proc.key);
      // A process seen before has a monotonic counter. One that is new since the last scan has used
      // all its ticks within the interval; the bound only guards against a process missed earlier.
      const used = earlier === undefined ? Math.min(proc.ticks, budget) : proc.ticks - earlier;
      cores = Math.max(0, used) / CLOCK_TICKS / elapsedSeconds;
    }

    if (!owner.agentId) {
      other.cores += cores;
      other.rss += proc.rss;
      continue;
    }
    let session = sessions.get(owner.agentId);
    if (!session) {
      session = {
        agentId: owner.agentId,
        cores: 0,
        rss: 0,
        command: proc.comm,
        processes: 0,
        topCores: -1,
        topRss: -1,
      };
      sessions.set(owner.agentId, session);
    }
    session.cores += cores;
    session.rss += proc.rss;
    session.processes++;
    // The busiest process names the load; memory breaks ties between equally busy ones.
    if (cores > session.topCores || (cores === session.topCores && proc.rss > session.topRss)) {
      session.topCores = cores;
      session.topRss = proc.rss;
      session.command = proc.comm;
    }
  }

  return {
    sessions: [...sessions.values()].map(
      ({ topCores: _cores, topRss: _rss, ...session }) => session,
    ),
    other,
    ticks,
  };
}

export const SCAN_EVERY_MS = 10_000;
/** A session is heavy at one busy core held for three scans (30 seconds), or a quarter of memory. */
export const HEAVY_CORES = 1;
export const HEAVY_SCANS = 3;
export const HEAVY_MEMORY_SHARE = 0.25;

/**
 * Rescans every `SCAN_EVERY_MS` and remembers a short window of each session's CPU, so a one-scan
 * spike does not flag it. `scan` returns null where processes cannot be listed: for good on a host
 * that cannot do it at all (not Linux), and for one scan on a host that failed once.
 */
export function trackSessions(scan: () => ProcInfo[] | null, startedAt: number) {
  const first = scan();
  const supported = first !== null;
  let previous = first ? attribute(first, null, 0).ticks : new Map<string, number>();
  let latest: Pick<Attribution, "sessions" | "other"> = {
    sessions: [],
    other: { cores: 0, rss: 0 },
  };
  let scannedAt = startedAt;
  let failures = 0;
  let recent = new Map<string, number[]>();

  return {
    update(at: number) {
      if (!supported || at - scannedAt < SCAN_EVERY_MS) return;
      const procs = scan();
      if (!procs) {
        // Keep the last readings through a hiccup, but not through a lasting failure. The next
        // good scan diffs against the last good one, over the longer interval.
        if (++failures >= HEAVY_SCANS) {
          latest = { sessions: [], other: { cores: 0, rss: 0 } };
          recent = new Map();
        }
        return;
      }
      failures = 0;
      const next = attribute(procs, previous, (at - scannedAt) / 1000);
      previous = next.ticks;
      scannedAt = at;
      latest = { sessions: next.sessions, other: next.other };
      recent = new Map(
        next.sessions.map(({ agentId, cores }) => [
          agentId,
          [...(recent.get(agentId) ?? []), cores].slice(-HEAVY_SCANS),
        ]),
      );
    },
    read(totalMemory: number): {
      sessions: Session[] | null;
      other: { cores: number; rss: number };
    } {
      if (!supported) return { sessions: null, other: { cores: 0, rss: 0 } };
      const sessions = latest.sessions
        .map((session): Session => {
          const window = recent.get(session.agentId) ?? [];
          // Held for the whole window, not averaged, so one burst does not flag a session.
          const sustained = window.length === HEAVY_SCANS && window.every((c) => c >= HEAVY_CORES);
          const heavy = sustained || session.rss >= HEAVY_MEMORY_SHARE * totalMemory;
          return { ...session, title: null, workspace: null, heavy };
        })
        .sort((a, b) => Number(b.heavy) - Number(a.heavy) || b.cores - a.cores || b.rss - a.rss);
      return { sessions, other: latest.other };
    },
  };
}
