import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, formatCores, formatPercent, formatRate, loadLevel } from "../client/format";
import { bytesPerSecond, cpuPercent, startSampler } from "../server/usage";
import { getUsage, HISTORY_EVERY_MS, HISTORY_LENGTH } from "../shared/usage";

afterEach(() => vi.useRealTimers());

describe("cpuPercent", () => {
  it("is the busy share of the elapsed ticks", () => {
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50);
  });

  it("is null when nothing elapsed or the counters went backwards", () => {
    expect(cpuPercent({ idle: 10, total: 20 }, { idle: 10, total: 20 })).toBeNull();
    expect(cpuPercent({ idle: 10, total: 20 }, { idle: 5, total: 8 })).toBeNull();
    expect(cpuPercent({ idle: 10, total: 20 }, { idle: 5, total: 30 })).toBeNull();
  });
});

describe("bytesPerSecond", () => {
  it("is the counter delta over the elapsed time", () => {
    expect(bytesPerSecond(1000, 5000, 2000)).toBe(2000);
  });

  it("is null without two readings, after a counter reset, or with no elapsed time", () => {
    expect(bytesPerSecond(null, 5, 1000)).toBeNull();
    expect(bytesPerSecond(5, null, 1000)).toBeNull();
    expect(bytesPerSecond(9, 5, 1000)).toBeNull();
    expect(bytesPerSecond(1, 5, 0)).toBeNull();
  });

  it("is null for counters or times that are not finite, never Infinity or NaN", () => {
    expect(bytesPerSecond(0, Number.POSITIVE_INFINITY, 1000)).toBeNull();
    expect(bytesPerSecond(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1000)).toBeNull();
    expect(bytesPerSecond(Number.NaN, 5, 1000)).toBeNull();
    expect(bytesPerSecond(1, 5, Number.NaN)).toBeNull();
    expect(bytesPerSecond(0, Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull();
  });
});

/** Ticks advance a fake clock one second at a time, so history cadence is countable in ticks. */
function sampler(options: Parameters<typeof startSampler>[0] = {}) {
  vi.useFakeTimers();
  let clock = 0;
  return startSampler({
    intervalMs: 1000,
    readCpu: () => ({ idle: clock, total: clock * 2 }),
    readIo: () => clock * 1000,
    readMemory: () => 40,
    readDisk: () => 60,
    scan: () => [],
    totalMemory: () => 8 * 1024 ** 3,
    now: () => (clock += 1000),
    ...options,
  });
}

describe("startSampler", () => {
  it("reports no rates until a second reading, then keeps the last good values", () => {
    const cpu = [
      { idle: 0, total: 0 },
      { idle: 50, total: 100 },
    ];
    const io = [0, 4000, 3000];
    const s = sampler({
      readCpu: () => cpu.shift() ?? { idle: 50, total: 100 },
      readIo: () => io.shift() ?? 3000,
    });
    expect(s.usage()).toMatchObject({ cpu: null, io: null, memory: 40, disk: 60 });
    vi.advanceTimersByTime(1000);
    expect(s.usage()).toMatchObject({ cpu: 50, io: 4000 });
    // The next readings are unusable (no CPU ticks elapsed, I/O counter went backwards).
    vi.advanceTimersByTime(1000);
    expect(s.usage()).toMatchObject({ cpu: 50, io: 4000 });
    s.stop();
  });

  it("records one history point per cadence, starting with the first tick", () => {
    const s = sampler();
    expect(s.usage().history).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(s.usage().history).toHaveLength(1);
    vi.advanceTimersByTime(HISTORY_EVERY_MS - 1000);
    expect(s.usage().history).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(s.usage().history).toHaveLength(2);
    s.stop();
  });

  it("keeps only the newest points, oldest first, and hands out copies", () => {
    let memory = 0;
    const s = sampler({ readMemory: () => ++memory });
    vi.advanceTimersByTime((HISTORY_LENGTH + 5) * HISTORY_EVERY_MS);
    const { history } = s.usage();
    expect(history).toHaveLength(HISTORY_LENGTH);
    const values = history
      .map((point) => point.memory)
      .filter((value): value is number => value !== null);
    expect(values).toHaveLength(HISTORY_LENGTH); // no point is unknown
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[0]).toBeGreaterThan(1);
    history.length = 0;
    expect(s.usage().history).toHaveLength(HISTORY_LENGTH);
    s.stop();
  });

  it("stops sampling when stopped", () => {
    const s = sampler();
    s.stop();
    vi.advanceTimersByTime(HISTORY_EVERY_MS * 3);
    expect(s.usage().history).toEqual([]);
  });

  it("produces output the RPC contract accepts, with every reading present or null", () => {
    const s = sampler();
    vi.advanceTimersByTime(HISTORY_EVERY_MS);
    expect(() => getUsage.output.parse(s.usage())).not.toThrow();
    s.stop();
    const unknown = sampler({ readMemory: () => null, readDisk: () => null, readIo: () => null });
    vi.advanceTimersByTime(HISTORY_EVERY_MS);
    const output = getUsage.output.parse(unknown.usage());
    expect(output).toMatchObject({ memory: null, disk: null, io: null });
    expect(output.history[0]).toMatchObject({ memory: null });
    unknown.stop();
  });
});

describe("footer formatting", () => {
  it("escalates at 70 and 90 percent", () => {
    expect([null, 69.9, 70, 89.9, 90].map(loadLevel)).toEqual(["ok", "ok", "warn", "warn", "hot"]);
  });

  it("rounds, and shows a placeholder for an unknown value", () => {
    expect(formatPercent(41.6)).toBe("42%");
    expect(formatPercent(null)).toBe("--");
  });

  it("formats throughput with a short unit", () => {
    expect([null, 0, 850, 12_400, 1_500_000, 2_000_000_000].map(formatRate)).toEqual([
      "--",
      "0/s",
      "850/s",
      "12K/s",
      "1.5M/s",
      "2.0G/s",
    ]);
  });

  it("formats sizes in binary units, with one decimal below ten", () => {
    expect([0, 850, 1024, 1536, 12 * 1024 ** 2, 2.5 * 1024 ** 3].map(formatBytes)).toEqual([
      "0B",
      "850B",
      "1.0K",
      "1.5K",
      "12M",
      "2.5G",
    ]);
  });

  it("formats cores with one decimal below ten", () => {
    expect([0, 0.04, 2.04, 12.4].map(formatCores)).toEqual([
      "0.0 cores",
      "0.0 cores",
      "2.0 cores",
      "12 cores",
    ]);
  });

  it("never shows a unit's worth of the smaller unit, nor ten as a one-decimal number", () => {
    // Rounding can carry a value over a boundary: 1023.6K is 1.0M, and 9.96 is 10, not 10.0.
    expect([9.94, 9.96, 10, 99.5].map(formatCores)).toEqual([
      "9.9 cores",
      "10 cores",
      "10 cores",
      "100 cores",
    ]);
    expect([1023, 1024 ** 2 - 1, 9.96 * 1024, 1023.6 * 1024].map(formatBytes)).toEqual([
      "1023B",
      "1.0M",
      "10K",
      "1.0M",
    ]);
    expect([999, 999.6, 999_999, 9960].map(formatRate)).toEqual([
      "999/s",
      "1.0K/s",
      "1.0M/s",
      "10K/s",
    ]);
  });
});
