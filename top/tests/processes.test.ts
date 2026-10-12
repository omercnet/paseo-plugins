import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attribute,
  HEAVY_MEMORY_SHARE,
  HEAVY_SCANS,
  PAGE_BYTES,
  type ProcInfo,
  parseAgentId,
  parseStat,
  readPageSize,
  readProcs,
  SCAN_EVERY_MS,
  trackSessions,
} from "../server/processes";

const GIB = 1024 ** 3;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
const tmpdir = os.tmpdir;

/**
 * A /proc/<pid>/stat line. Fields we do not read hold distinct non-zero decoys (children's CPU,
 * thread count, virtual size), so reading the wrong field fails a test instead of passing by luck.
 */
function statLine(pid: number, comm: string, ppid: number, ticks: number, start = 1, rssPages = 0) {
  const utime = Math.floor(ticks / 2);
  return `${pid} (${comm}) S ${ppid} 101 102 103 104 105 106 107 108 109 ${utime} ${ticks - utime} 777 888 20 0 555 0 ${start} 999999 ${rssPages} 424242 0`;
}

function proc(
  pid: number,
  ppid: number,
  agentId: string | null,
  ticks: number,
  extra: Partial<ProcInfo> = {},
): ProcInfo {
  return { key: `${pid}:1`, pid, ppid, ticks, rss: 0, comm: `p${pid}`, agentId, ...extra };
}

/** The ticks of every process, as the previous scan would have recorded them. */
const baseline = (procs: ProcInfo[], ticks = 0) => new Map(procs.map((p) => [p.key, ticks]));

describe("parseStat", () => {
  it("reads parent, CPU ticks, start time and resident bytes, and nothing else", () => {
    expect(parseStat(statLine(7, "node", 3, 150, 99, 10))).toEqual({
      comm: "node",
      ppid: 3,
      ticks: 150,
      start: 99,
      rss: 10 * PAGE_BYTES,
    });
  });

  it("reads a line the way the kernel writes it, trailing newline and all", () => {
    const kernel =
      "1234 (bash) S 1200 1234 1234 34816 1234 4194560 12345 67890 0 0 150 30 5 2 20 0 1 0 98765 12345678 2345 18446744073709551615 1 1 0 0 0 0 65536 3670020 1266777851 0 0 0 17 3 0 0 0 0 0\n";
    expect(parseStat(kernel)).toEqual({
      comm: "bash",
      ppid: 1200,
      ticks: 180,
      start: 98765,
      rss: 2345 * PAGE_BYTES,
    });
  });

  it("survives a command name with spaces and parentheses", () => {
    expect(parseStat(statLine(7, "my (odd) tool", 3, 10))).toMatchObject({
      comm: "my (odd) tool",
      ppid: 3,
    });
  });

  it("rejects a line it cannot make sense of", () => {
    expect(parseStat("garbage")).toBeNull();
    expect(parseStat("1 (x) S")).toBeNull();
    expect(parseStat("1 )x( S 1")).toBeNull();
    expect(parseStat(statLine(7, "x", 3, 10).replace(" S 3 ", " S abc "))).toBeNull();
  });

  it("clamps a negative resident size to zero rather than poisoning the reading", () => {
    expect(parseStat(statLine(7, "x", 3, 10, 1, -1))?.rss).toBe(0);
  });
});

describe("readPageSize", () => {
  const little = os.endianness() === "LE";
  /** An auxiliary vector of (type, value) pairs. */
  function auxv(...pairs: Array<[number, number]>) {
    const buffer = Buffer.alloc(pairs.length * 16);
    pairs.forEach(([type, value], index) => {
      if (little) {
        buffer.writeBigUInt64LE(BigInt(type), index * 16);
        buffer.writeBigUInt64LE(BigInt(value), index * 16 + 8);
      } else {
        buffer.writeBigUInt64BE(BigInt(type), index * 16);
        buffer.writeBigUInt64BE(BigInt(value), index * 16 + 8);
      }
    });
    const path = join(tmp("top-auxv-"), "auxv");
    writeFileSync(path, buffer);
    return path;
  }

  it("uses the kernel's page size, which is 16K or 64K on some arm64 and ppc64 kernels", () => {
    expect(readPageSize(auxv([33, 1], [6, 16384], [0, 0]))).toBe(16384);
    expect(readPageSize(auxv([6, 65536]))).toBe(65536);
  });

  it("falls back to 4096 when it is missing, implausible, or unreadable", () => {
    expect(readPageSize(auxv([33, 1], [0, 0]))).toBe(4096);
    expect(readPageSize(auxv([6, 5000]))).toBe(4096);
    expect(readPageSize(auxv([6, 0]))).toBe(4096);
    expect(readPageSize(auxv([6, 2 ** 30]))).toBe(4096);
    expect(readPageSize("/nonexistent/auxv")).toBe(4096);
  });
});

describe("parseAgentId", () => {
  it("finds the agent id and nothing else in the environment", () => {
    const environ = [
      "PATH=/bin",
      "PASEO_AGENT_ID=abc",
      "PASEO_AGENT_CWD=/x",
      "SECRET=hunter2",
    ].join("\0");
    expect(parseAgentId(environ)).toBe("abc");
  });

  it("is null when absent, empty, or only a lookalike name", () => {
    expect(parseAgentId("PATH=/bin\0HOME=/h")).toBeNull();
    expect(parseAgentId("PASEO_AGENT_ID=")).toBeNull();
    expect(parseAgentId("NOT_PASEO_AGENT_ID=abc")).toBeNull();
  });
});

describe("readProcs", () => {
  function fakeProc(entries: Record<string, { stat: string; environ?: string }>) {
    const root = tmp("top-proc-");
    for (const [pid, { stat, environ }] of Object.entries(entries)) {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, "stat"), stat);
      if (environ !== undefined) writeFileSync(join(root, pid, "environ"), environ);
    }
    return root;
  }

  it("tags processes by their environment and tolerates unreadable ones", () => {
    const root = fakeProc({
      "10": { stat: statLine(10, "claude", 1, 5), environ: "PASEO_AGENT_ID=a1\0X=1" },
      "11": { stat: statLine(11, "other-user", 1, 5) }, // environ is unreadable
      self: { stat: "ignored" },
    });
    const procs = readProcs(root);
    expect(procs.map((p) => [p.pid, p.agentId]).sort()).toEqual([
      [10, "a1"],
      [11, null],
    ]);
  });

  it("reads the agent id again on every scan, so an exec that replaced the environment is seen", () => {
    const root = fakeProc({
      "10": { stat: statLine(10, "a", 1, 5, 100), environ: "PASEO_AGENT_ID=old\0SECRET=hunter2" },
    });
    expect(readProcs(root)[0]).toMatchObject({ key: "10:100", agentId: "old" });
    // Same pid and start time: exec keeps both and swaps the environment.
    writeFileSync(join(root, "10", "environ"), "PASEO_AGENT_ID=new");
    expect(readProcs(root)[0]).toMatchObject({ key: "10:100", agentId: "new" });
    writeFileSync(join(root, "10", "environ"), "PATH=/bin");
    expect(readProcs(root)[0]?.agentId).toBeNull();
  });

  it("keeps nothing of the environment but the agent id", () => {
    const root = fakeProc({
      "10": { stat: statLine(10, "a", 1, 5), environ: "PASEO_AGENT_ID=a1\0SECRET=hunter2" },
    });
    expect(JSON.stringify(readProcs(root))).not.toContain("hunter2");
  });

  it("forgets processes that exited", () => {
    const root = fakeProc({
      "10": { stat: statLine(10, "a", 1, 5), environ: "PASEO_AGENT_ID=a1" },
      "11": { stat: statLine(11, "b", 1, 5), environ: "PASEO_AGENT_ID=a2" },
    });
    rmSync(join(root, "11"), { recursive: true });
    expect(readProcs(root).map((p) => p.pid)).toEqual([10]);
  });

  it("does not confuse a reused pid with the process that had it before", () => {
    const root = fakeProc({
      "10": { stat: statLine(10, "a", 1, 5, 100), environ: "PASEO_AGENT_ID=old" },
    });
    expect(readProcs(root)[0]).toMatchObject({ key: "10:100", agentId: "old" });
    writeFileSync(join(root, "10", "stat"), statLine(10, "b", 1, 5, 200));
    writeFileSync(join(root, "10", "environ"), "PASEO_AGENT_ID=new");
    expect(readProcs(root)[0]).toMatchObject({ key: "10:200", agentId: "new" });
  });
});

describe("attribute", () => {
  it("charges a tool launched without the tag to the agent above it", () => {
    // agent a1 (tagged) -> shell (scrubbed env) -> compiler (scrubbed env)
    const procs = [
      proc(1, 0, "a1", 0),
      proc(2, 1, null, 0),
      proc(3, 2, null, 400, { comm: "rustc", rss: GIB }),
    ];
    const { sessions, other } = attribute(procs, baseline(procs), 2);
    expect(sessions).toEqual([
      { agentId: "a1", cores: 2, rss: GIB, command: "rustc", processes: 3 },
    ]);
    expect(other).toEqual({ cores: 0, rss: 0 });
  });

  it("keeps a tagged child under a differently tagged parent with its own agent", () => {
    const procs = [proc(1, 0, "a1", 100), proc(2, 1, "a2", 100)];
    const { sessions } = attribute(procs, baseline(procs), 1);
    expect(sessions.map((s) => [s.agentId, s.processes]).sort()).toEqual([
      ["a1", 1],
      ["a2", 1],
    ]);
  });

  it("keeps processes that belong to no agent separate", () => {
    const procs = [proc(1, 0, null, 200, { rss: 5 }), proc(2, 1, null, 0)];
    const result = attribute(procs, baseline(procs), 1);
    expect(result.sessions).toEqual([]);
    expect(result.other).toEqual({ cores: 2, rss: 5 });
  });

  it("accounts for every process exactly once", () => {
    const procs = [proc(1, 0, "a", 100), proc(2, 1, null, 100), proc(3, 0, null, 100)];
    const { sessions, other } = attribute(procs, baseline(procs), 1);
    const total = sessions.reduce((sum, s) => sum + s.cores, 0) + other.cores;
    expect(total).toBeCloseTo(3);
  });

  it("charges nothing on the very first scan, which has nothing to diff against", () => {
    const procs = [proc(1, 0, "a", 99999, { rss: 4 })];
    const { sessions, other } = attribute(procs, null, 0);
    expect(sessions).toEqual([{ agentId: "a", cores: 0, rss: 4, command: "p1", processes: 1 }]);
    expect(other.cores).toBe(0);
    expect(attribute(procs, null, 10).sessions[0]?.cores).toBe(0);
  });

  it("charges a process that started since the last scan for everything it has used", () => {
    // Born and busy for 5 of the 10 seconds: a build step. Its whole counter is this interval's.
    const born = [proc(1, 0, "a", 500)];
    expect(attribute(born, new Map([["9:1", 0]]), 10).sessions[0]?.cores).toBe(0.5);
  });

  it("never charges a new process more than every CPU could have given", () => {
    const missed = [proc(1, 0, "a", 1e9)];
    const cores = attribute(missed, new Map([["9:1", 0]]), 10).sessions[0]?.cores ?? 0;
    expect(cores).toBeLessThanOrEqual(os.availableParallelism());
  });

  it("charges nothing for a process whose counter went backwards, or when no time passed", () => {
    const procs = [proc(1, 0, "a", 10)];
    expect(attribute(procs, new Map([["1:1", 50]]), 1).sessions[0]?.cores).toBe(0);
    expect(attribute(procs, new Map([["1:1", 0]]), 0).sessions[0]?.cores).toBe(0);
  });

  it("puts a parent cycle's load in other and does not loop", () => {
    const procs = [proc(1, 2, null, 100), proc(2, 1, null, 100)];
    const { sessions, other } = attribute(procs, baseline(procs), 1);
    expect(sessions).toEqual([]);
    expect(other.cores).toBeCloseTo(2);
  });

  it("names the busiest process, using memory only to break exact ties", () => {
    const procs = [
      proc(1, 0, "a", 0, { comm: "agent", rss: 10 }),
      proc(2, 1, null, 0, { comm: "idle-big", rss: 9000 }),
      proc(3, 1, null, 100, { comm: "busy-small", rss: 1 }),
    ];
    expect(attribute(procs, baseline(procs), 1).sessions[0]?.command).toBe("busy-small");
    const idle = procs.map((p) => ({ ...p, ticks: 0 }));
    expect(attribute(idle, baseline(procs), 1).sessions[0]?.command).toBe("idle-big");
  });

  it("does not let a huge idle process outrank a barely busy one", () => {
    // One tick in ten seconds against 8 GiB of memory: CPU decides, not a weighted sum.
    const procs = [
      proc(1, 0, "a", 0, { comm: "agent" }),
      proc(2, 1, null, 0, { comm: "idle-8g", rss: 8 * GIB }),
      proc(3, 1, null, 1, { comm: "ticking", rss: 1 }),
    ];
    expect(attribute(procs, baseline(procs), 10).sessions[0]?.command).toBe("ticking");
  });
});

describe("trackSessions", () => {
  /** One agent whose tree burns the given number of cores during each successive scan interval. */
  function scripted(coresPerScan: number[], rss = 0) {
    let ticks = 0;
    let scans = 0;
    return () => {
      if (scans > 0) ticks += (coresPerScan[scans - 1] ?? 0) * (SCAN_EVERY_MS / 1000) * 100;
      scans++;
      return [proc(1, 0, "a1", ticks, { rss })];
    };
  }

  /** Runs scans at every interval and reports whether the session is flagged after each. */
  function flags(scan: () => ProcInfo[] | null, scans: number, total = 16 * GIB) {
    const tracker = trackSessions(scan, 0);
    const out: boolean[] = [];
    for (let n = 1; n <= scans; n++) {
      tracker.update(n * SCAN_EVERY_MS);
      out.push(tracker.read(total).sessions?.[0]?.heavy ?? false);
    }
    return out;
  }

  it("reports no sessions until the first full interval", () => {
    const tracker = trackSessions(scripted([4]), 0);
    expect(tracker.read(16 * GIB).sessions).toEqual([]);
    tracker.update(SCAN_EVERY_MS - 1);
    expect(tracker.read(16 * GIB).sessions).toEqual([]);
    tracker.update(SCAN_EVERY_MS);
    expect(tracker.read(16 * GIB).sessions?.[0]?.cores).toBeCloseTo(4);
  });

  it("flags a session only once it has held a core for the whole window", () => {
    expect(flags(scripted([1.5, 1.5, 1.5]), 3)).toEqual([false, false, true]);
    // Exactly one core counts as held.
    expect(flags(scripted([1, 1, 1]), 3)).toEqual([false, false, true]);
  });

  it("does not flag one burst, even a huge one, or a session that averages a core", () => {
    expect(flags(scripted([0, 0, 4]), 3)).toEqual([false, false, false]);
    expect(flags(scripted([0, 4, 0, 0, 4]), 5)).toEqual([false, false, false, false, false]);
    expect(flags(scripted([1.5, 1.5, 0.5]), 3)).toEqual([false, false, false]);
  });

  it("clears the flag when a session stops being busy", () => {
    expect(flags(scripted([1.5, 1.5, 1.5, 0, 0]), 5)).toEqual([false, false, true, false, false]);
  });

  it("flags a memory hog straight away", () => {
    const total = 16 * GIB;
    const tracker = trackSessions(scripted([0], HEAVY_MEMORY_SHARE * total), 0);
    tracker.update(SCAN_EVERY_MS);
    expect(tracker.read(total).sessions?.[0]?.heavy).toBe(true);
  });

  it("forgets a session's history when it disappears for a scan", () => {
    let present = true;
    let ticks = 0;
    const scan = () => {
      ticks += 1500;
      return present ? [proc(1, 0, "a1", ticks)] : [proc(2, 0, null, 0)];
    };
    const tracker = trackSessions(scan, 0);
    const heavy = () => tracker.read(16 * GIB).sessions?.[0]?.heavy ?? false;
    tracker.update(10_000);
    tracker.update(20_000);
    present = false;
    tracker.update(30_000);
    present = true;
    tracker.update(40_000);
    tracker.update(50_000);
    expect(heavy()).toBe(false); // only two scans since it came back
    tracker.update(60_000);
    expect(heavy()).toBe(true);
  });

  it("is unsupported for good when processes cannot be listed from the start", () => {
    let listable = false;
    const tracker = trackSessions(() => (listable ? [proc(1, 0, "a1", 0)] : null), 0);
    tracker.update(SCAN_EVERY_MS);
    expect(tracker.read(GIB)).toEqual({ sessions: null, other: { cores: 0, rss: 0 } });
    listable = true;
    tracker.update(2 * SCAN_EVERY_MS);
    expect(tracker.read(GIB).sessions).toBeNull();
  });

  it("keeps its readings through one failed scan and measures the longer gap on recovery", () => {
    const script = [0, 1000, null, 3000];
    let call = 0;
    const scan = () => {
      const ticks = script[call++];
      return ticks === null || ticks === undefined ? null : [proc(1, 0, "a1", ticks)];
    };
    const tracker = trackSessions(scan, 0);
    tracker.update(10_000);
    expect(tracker.read(GIB).sessions?.[0]?.cores).toBeCloseTo(1);
    tracker.update(20_000);
    expect(tracker.read(GIB).sessions?.[0]?.cores).toBeCloseTo(1); // last good readings
    tracker.update(30_000);
    // 2000 ticks over the 20 seconds since the last good scan, not over 10.
    expect(tracker.read(GIB).sessions?.[0]?.cores).toBeCloseTo(1);
  });

  it("goes quiet, not unsupported, when scans keep failing", () => {
    let fail = false;
    const tracker = trackSessions(() => (fail ? null : [proc(1, 0, "a1", 0)]), 0);
    tracker.update(10_000);
    expect(tracker.read(GIB).sessions).toHaveLength(1);
    fail = true;
    for (let n = 2; n <= 1 + HEAVY_SCANS; n++) tracker.update(n * 10_000);
    expect(tracker.read(GIB).sessions).toEqual([]);
  });

  it("lists every session, flagged ones first even when they are not the busiest", () => {
    const total = 16 * GIB;
    let scans = 0;
    // Fifteen sessions each burn half a core (not heavy); agent-1 burns nothing but holds a quarter
    // of memory, so it is flagged yet ranks last on CPU.
    const scan = () => {
      const ticks = scans++ === 0 ? 0 : 0.5 * (SCAN_EVERY_MS / 1000) * 100;
      return Array.from({ length: 15 }, (_, index) =>
        index === 0
          ? proc(1, 0, "agent-1", 0, { rss: HEAVY_MEMORY_SHARE * total })
          : proc(index + 1, 0, `agent-${index + 1}`, ticks),
      );
    };
    const tracker = trackSessions(scan, 0);
    tracker.update(SCAN_EVERY_MS);
    const sessions = tracker.read(total).sessions ?? [];
    expect(sessions).toHaveLength(15);
    expect(sessions[0]).toMatchObject({ agentId: "agent-1", heavy: true });
  });

  it("orders sessions by flag, then CPU, then memory", () => {
    const total = 16 * GIB;
    let scans = 0;
    const scan = () => {
      const busy = scans++ === 0 ? 0 : 1000;
      return [
        proc(1, 0, "small-cpu-small-mem", busy / 2, { rss: 1 }),
        proc(2, 0, "small-cpu-big-mem", busy / 2, { rss: 5 }),
        proc(3, 0, "big-cpu", busy, { rss: 1 }),
        proc(4, 0, "hog", 0, { rss: HEAVY_MEMORY_SHARE * total }),
      ];
    };
    const tracker = trackSessions(scan, 0);
    tracker.update(SCAN_EVERY_MS);
    expect(tracker.read(total).sessions?.map((s) => s.agentId)).toEqual([
      "hog",
      "big-cpu",
      "small-cpu-big-mem",
      "small-cpu-small-mem",
    ]);
  });
});
