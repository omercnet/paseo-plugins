import { readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { HISTORY_EVERY_MS, HISTORY_LENGTH, type Sample } from "../shared/usage";
import { type ProcInfo, readProcs, trackSessions } from "./processes";

export interface CpuTimes {
  idle: number;
  total: number;
}

export function readCpuTimes(cpus: ReadonlyArray<Pick<os.CpuInfo, "times">> = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Busy share between two readings, or null when no time elapsed, the counters went backwards or are not numbers. */
export function cpuPercent(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle)) return null;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return (1 - idle / total) * 100;
}

/** The filesystem holding the daemon user's home, the one agent checkouts normally fill up. */
export function diskPercent(
  path = os.homedir(),
  stat: (path: string) => { blocks: number; bfree: number; bavail: number } = statfsSync,
): number | null {
  try {
    const { blocks, bfree, bavail } = stat(path);
    const used = blocks - bfree;
    const usable = used + bavail;
    const percent = (used / usable) * 100;
    return usable > 0 && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
  } catch {
    return null;
  }
}

/**
 * Whole-disk bytes read plus written since boot (Linux only). Null where /proc is unavailable, and
 * when any whole disk has a malformed counter: a partial total would show up as a throughput spike
 * once the counter reads again.
 */
export function readDiskBytes(
  sysBlock = "/sys/block",
  diskstats = "/proc/diskstats",
): number | null {
  try {
    // Partitions, RAID, device-mapper and loop devices would count the same bytes twice.
    const disks = new Set(
      readdirSync(sysBlock).filter((name) => !/^(loop|ram|dm-|zram|md)/.test(name)),
    );
    let sectors = 0;
    let matched = false;
    for (const line of readFileSync(diskstats, "utf8").split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (!disks.has(fields[2] ?? "")) continue;
      const read = Number(fields[5]);
      const written = Number(fields[9]);
      if (!(Number.isFinite(read) && read >= 0 && Number.isFinite(written) && written >= 0)) {
        return null;
      }
      sectors += read + written;
      matched = true;
    }
    return matched && Number.isFinite(sectors) ? sectors * 512 : null;
  } catch {
    return null;
  }
}

/** Bytes per second between two readings, or null when a counter is missing, not finite, or went backwards. */
export function bytesPerSecond(
  previous: number | null,
  current: number | null,
  elapsedMs: number,
): number | null {
  if (previous === null || current === null) return null;
  if (!(Number.isFinite(previous) && Number.isFinite(current) && Number.isFinite(elapsedMs))) {
    return null;
  }
  if (current < previous || elapsedMs <= 0) return null;
  const rate = ((current - previous) * 1000) / elapsedMs;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Used share of memory, clamped to 0-100; null when the host reports no usable total. Linux reports
 * reclaimable cache as free, so this is memory programs cannot get back.
 */
export function memoryPercent(total = os.totalmem(), free = os.freemem()): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  return Math.min(100, Math.max(0, (1 - free / total) * 100));
}

interface SamplerOptions {
  intervalMs?: number;
  readCpu?: () => CpuTimes;
  readIo?: () => number | null;
  readMemory?: () => number | null;
  readDisk?: () => number | null;
  /** Lists processes, or returns null where that is not possible. */
  scan?: () => ProcInfo[] | null;
  totalMemory?: () => number;
  now?: () => number;
}

/**
 * CPU and disk I/O are rates, so a timer keeps the latest ones, and a ring of past samples gives
 * every client a timeline no matter when it connected. The RPC only reads this.
 */
export function startSampler({
  intervalMs = 2000,
  readCpu = readCpuTimes,
  readIo = readDiskBytes,
  readMemory = memoryPercent,
  readDisk = diskPercent,
  scan = defaultScan(),
  totalMemory = os.totalmem,
  now = Date.now,
}: SamplerOptions = {}) {
  let previousCpu = readCpu();
  let previousIo = readIo();
  let previousAt = now();
  let lastHistoryAt = Number.NEGATIVE_INFINITY;
  let cpu: number | null = null;
  let io: number | null = null;
  const history: Sample[] = [];
  const sessions = trackSessions(scan, previousAt);
  const current = (): Sample => ({ cpu, memory: readMemory(), disk: readDisk(), io });

  const timer = setInterval(() => {
    const currentCpu = readCpu();
    const currentIo = readIo();
    const at = now();
    cpu = cpuPercent(previousCpu, currentCpu) ?? cpu;
    io = bytesPerSecond(previousIo, currentIo, at - previousAt) ?? io;
    previousCpu = currentCpu;
    previousIo = currentIo;
    previousAt = at;
    sessions.update(at);
    if (at - lastHistoryAt >= HISTORY_EVERY_MS) {
      lastHistoryAt = at;
      history.push(current());
      if (history.length > HISTORY_LENGTH) history.shift();
    }
  }, intervalMs);
  timer.unref();

  return {
    usage: () => {
      const total = totalMemory();
      return { ...current(), history: [...history], totalMemory: total, ...sessions.read(total) };
    },
    stop: () => clearInterval(timer),
  };
}

/** Reads /proc; returns null for a scan where it cannot be listed. */
function defaultScan(): () => ProcInfo[] | null {
  return () => {
    try {
      return readProcs();
    } catch {
      return null;
    }
  };
}
