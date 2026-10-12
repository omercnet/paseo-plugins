import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cpuPercent,
  diskPercent,
  memoryPercent,
  readCpuTimes,
  readDiskBytes,
} from "../server/usage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake /sys/block (one directory per whole device) and /proc/diskstats. */
function fakeDisks(devices: string[], stats: Record<string, [read: number, written: number]>) {
  const root = mkdtempSync(join(tmpdir(), "top-disks-"));
  roots.push(root);
  mkdirSync(join(root, "block"));
  for (const device of devices) mkdirSync(join(root, "block", device));
  const lines = Object.entries(stats).map(
    ([name, [read, written]]) => `   8       0 ${name} 1 0 ${read} 0 1 0 ${written} 0 0 0 0`,
  );
  writeFileSync(join(root, "diskstats"), `${lines.join("\n")}\n`);
  return { sysBlock: join(root, "block"), diskstats: join(root, "diskstats") };
}

describe("readDiskBytes", () => {
  it("adds up sectors read and written on every whole disk, at 512 bytes each", () => {
    const { sysBlock, diskstats } = fakeDisks(["sda", "sdb"], {
      sda: [20, 40],
      sdb: [7, 11],
    });
    expect(readDiskBytes(sysBlock, diskstats)).toBe((20 + 40 + 7 + 11) * 512);
  });

  it("does not count the same bytes twice through partitions, RAID, mappers or virtual devices", () => {
    const { sysBlock, diskstats } = fakeDisks(["sda", "md0", "dm-0", "loop0", "ram0", "zram0"], {
      sda: [20, 40],
      sda1: [999, 999],
      md0: [100, 100],
      "dm-0": [100, 100],
      loop0: [100, 100],
      ram0: [100, 100],
      zram0: [100, 100],
    });
    expect(readDiskBytes(sysBlock, diskstats)).toBe(60 * 512);
  });

  it("is null, not zero, when the counters cannot be read", () => {
    expect(readDiskBytes("/nonexistent/block", "/nonexistent/diskstats")).toBeNull();
  });

  it("ignores a malformed line of something that is not a whole disk", () => {
    const { sysBlock, diskstats } = fakeDisks(["sda"], { sda: [20, 40] });
    appendFileSync(diskstats, "   8       1 sda1 bad\n   8       0 sdz 1 0 x 0 1 0 y 0 0 0 0\n");
    expect(readDiskBytes(sysBlock, diskstats)).toBe(60 * 512);
  });

  it("is null, not a partial total, when a whole disk has a malformed or negative counter", () => {
    const { sysBlock, diskstats } = fakeDisks(["sda", "sdb"], { sda: [20, 40] });
    appendFileSync(diskstats, "   8      16 sdb bad\n");
    expect(readDiskBytes(sysBlock, diskstats)).toBeNull();
    writeFileSync(
      diskstats,
      "   8 0 sda 1 0 x 0 1 0 5 0 0 0 0\n   8 16 sdb 1 0 5 0 1 0 -3 0 0 0 0\n",
    );
    expect(readDiskBytes(sysBlock, diskstats)).toBeNull();
  });

  it("is null, not zero or NaN, when no disk has a usable line", () => {
    const { sysBlock, diskstats } = fakeDisks(["sda"], {});
    writeFileSync(diskstats, "   8       0 sda bad\n");
    expect(readDiskBytes(sysBlock, diskstats)).toBeNull();
  });
});

describe("readCpuTimes", () => {
  it("sums busy and idle time across cores, with I/O wait counted as neither", () => {
    const cpus = [
      { times: { user: 1, nice: 2, sys: 3, idle: 4, irq: 5 } },
      { times: { user: 10, nice: 0, sys: 0, idle: 20, irq: 0 } },
    ];
    expect(readCpuTimes(cpus)).toEqual({ idle: 24, total: 45 });
  });

  it("gives a share of null for counters that are not numbers", () => {
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: Number.NaN, total: 10 })).toBeNull();
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: 5, total: Number.NaN })).toBeNull();
  });
});

describe("memoryPercent", () => {
  it("is the used share of memory", () => {
    expect(memoryPercent(1000, 250)).toBe(75);
  });

  it("is clamped to 0-100 when the host reports more free than total, or negative free", () => {
    expect(memoryPercent(1000, 2000)).toBe(0);
    expect(memoryPercent(1000, -5)).toBe(100);
  });

  it("is null, never a false zero, when the readings are unusable", () => {
    expect(memoryPercent(0, 0)).toBeNull();
    expect(memoryPercent(Number.NaN, 5)).toBeNull();
    expect(memoryPercent(1000, Number.NaN)).toBeNull();
    expect(memoryPercent(Number.POSITIVE_INFINITY, 5)).toBeNull();
  });
});

describe("diskPercent", () => {
  it("is used space over what is usable to the daemon's user, like df", () => {
    const stat = () => ({ blocks: 1000, bfree: 200, bavail: 100 });
    expect(diskPercent("/x", stat)).toBeCloseTo(88.889, 2);
  });

  it("is null for a filesystem with nothing usable, and for one that cannot be read", () => {
    expect(diskPercent("/x", () => ({ blocks: 0, bfree: 0, bavail: 0 }))).toBeNull();
    expect(
      diskPercent("/x", () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });

  it("stays within 0-100, and is null when the counters are not numbers", () => {
    expect(diskPercent("/x", () => ({ blocks: 10, bfree: 20, bavail: 50 }))).toBe(0);
    expect(diskPercent("/x", () => ({ blocks: Number.NaN, bfree: 0, bavail: 0 }))).toBeNull();
    expect(
      diskPercent("/x", () => ({ blocks: Number.POSITIVE_INFINITY, bfree: 0, bavail: 0 })),
    ).toBeNull();
  });
});
