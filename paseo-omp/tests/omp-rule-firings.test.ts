import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_FIRING_LIMITS,
  type FiringLimits,
  readRuleFirings,
} from "../server/omp-rule-firings";

const LIMITS: FiringLimits = {
  sessions: 50,
  fileBytes: 1_000_000,
  totalBytes: 10_000_000,
  ms: 5_000,
};

let root: string;
let sequence = 0;

function injection(time: string, ...rules: string[]): string {
  return JSON.stringify({
    type: "ttsr_injection",
    id: `i${sequence++}`,
    parentId: null,
    timestamp: time,
    injectedRules: rules,
  });
}

/** One OMP session file, as OMP lays them out: a folder per workspace, a `session` header first. */
async function session(cwd: string, lines: string[]): Promise<string> {
  const id = `sess-${String(sequence++).padStart(6, "0")}`;
  const folder = join(root, cwd.replaceAll("/", "-"));
  await mkdir(folder, { recursive: true });
  const file = join(folder, `2026-11-05T21-00-00-000Z_${id}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id, cwd });
  await writeFile(file, `${[header, ...lines].join("\n")}\n`);
  return file;
}

function count(cwd?: string, limits: FiringLimits = LIMITS, now?: () => number) {
  return readRuleFirings({ ...(cwd ? { cwd } : {}), sessionDir: root }, {}, limits, now);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-rule-firings-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("counting rule firings from session files", () => {
  test("counts every injection per rule, with the latest time, noisiest first", async () => {
    await session("/work/a", [
      injection("2026-11-01T10:00:00.000Z", "no-canary"),
      injection("2026-11-02T10:00:00.000Z", "no-canary", "no-todo"),
    ]);
    await session("/work/b", [injection("2026-11-03T10:00:00.000Z", "no-canary")]);
    const result = await count();
    expect(result).toEqual({
      sessions: 2,
      partial: false,
      firings: [
        { name: "no-canary", count: 3, lastFiredAt: "2026-11-03T10:00:00.000Z" },
        { name: "no-todo", count: 1, lastFiredAt: "2026-11-02T10:00:00.000Z" },
      ],
    });
  });

  test("a workspace counts only its own sessions", async () => {
    await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "mine")]);
    await session("/work/b", [injection("2026-11-01T10:00:00.000Z", "theirs")]);
    const result = await count("/work/a");
    expect(result.firings.map((firing) => firing.name)).toEqual(["mine"]);
    expect(result.sessions).toBe(1);
  });

  test("lines that only mention the marker, or are damaged, are not counted", async () => {
    await session("/work/a", [
      JSON.stringify({ type: "message", message: { text: '"ttsr_injection" is a marker' } }),
      '{"type":"ttsr_injection","injectedRules":["cut off',
      JSON.stringify({ type: "ttsr_injection", injectedRules: "not-a-list" }),
      injection("not a time", "real"),
    ]);
    const result = await count();
    expect(result.firings).toEqual([{ name: "real", count: 1, lastFiredAt: null }]);
  });

  test("a session that has not changed is not read again, and a changed one is", async () => {
    const file = await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "first")]);
    // Whole-second times survive a round trip through utimes exactly.
    const pinned = new Date("2026-11-01T10:00:00.000Z");
    await utimes(file, pinned, pinned);
    await count();
    const size = (await stat(file)).size;

    // Same size and mtime, different content: only a cache hit can still report the old count.
    await writeFile(file, (await readFile(file, "utf8")).replace('"first"', '"other"'));
    await utimes(file, pinned, pinned);
    expect((await stat(file)).size).toBe(size);
    expect((await count()).firings.map((firing) => firing.name)).toEqual(["first"]);

    await appendFile(file, `${injection("2026-11-04T10:00:00.000Z", "second")}\n`);
    expect((await count()).firings.map((firing) => firing.name)).toEqual(["other", "second"]);
  });

  test("a session longer than the per-file bound is counted in part and flagged", async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      injection(`2026-11-01T10:00:${String(index).padStart(2, "0")}.000Z`, "noisy"),
    );
    await session("/work/a", lines);
    const result = await count(undefined, { ...LIMITS, fileBytes: 1_500 });
    expect(result.partial).toBe(true);
    const noisy = result.firings[0];
    expect(noisy?.name).toBe("noisy");
    expect(noisy?.count).toBeGreaterThan(0);
    expect(noisy?.count).toBeLessThan(40);
  });

  test("the total byte bound stops at the newest sessions and flags the rest", async () => {
    for (let index = 0; index < 4; index += 1) {
      await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "r")]);
    }
    const result = await count(undefined, { ...LIMITS, totalBytes: 400 });
    expect(result.partial).toBe(true);
    expect(result.sessions).toBeGreaterThan(0);
    expect(result.sessions).toBeLessThan(4);
  });

  test("the time bound stops the count and flags it", async () => {
    for (let index = 0; index < 3; index += 1) {
      await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "slow")]);
    }
    let clock = 0;
    const result = await count(undefined, { ...LIMITS, ms: 100 }, () => {
      clock += 60;
      return clock;
    });
    expect(result.partial).toBe(true);
    expect(result.sessions).toBeLessThan(3);
  });

  test("more sessions than the session bound are flagged, not silently dropped", async () => {
    await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "r")]);
    await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "r")]);
    const result = await count(undefined, { ...LIMITS, sessions: 1 });
    expect(result.sessions).toBe(1);
    expect(result.partial).toBe(true);
  });

  test("with the default bounds, a store larger than the session bound is flagged", async () => {
    const extra = DEFAULT_FIRING_LIMITS.sessions + 1;
    for (let index = 0; index < extra; index += 1) {
      await session("/work/a", [injection("2026-11-01T10:00:00.000Z", "r")]);
    }
    const result = await readRuleFirings({ sessionDir: root }, {});
    expect(result.sessions).toBe(DEFAULT_FIRING_LIMITS.sessions);
    expect(result.partial).toBe(true);
  });

  test("more distinct rules than the list holds are flagged", async () => {
    const names = Array.from({ length: 501 }, (_, index) => `rule-${index}`);
    await session("/work/a", [injection("2026-11-01T10:00:00.000Z", ...names)]);
    const result = await count();
    expect(result.firings).toHaveLength(500);
    expect(result.partial).toBe(true);
  });

  test("a count made under a smaller per-file bound is redone under a larger one", async () => {
    const lines = Array.from({ length: 6 }, () => injection("2026-11-01T10:00:00.000Z", "again"));
    await session("/work/a", lines);
    const small = await count(undefined, { ...LIMITS, fileBytes: 500 });
    expect(small.partial).toBe(true);
    const full = await count();
    expect(full.partial).toBe(false);
    expect(full.firings[0]?.count).toBe(6);
  });

  test("a read cut off by the time bound is flagged and counted in full the next time", async () => {
    const lines = Array.from({ length: 2_500 }, () =>
      injection("2026-11-01T10:00:00.000Z", "long"),
    );
    await session("/work/a", lines);
    let calls = 0;
    const cutOff = await count(undefined, LIMITS, () => {
      calls += 1;
      return calls <= 2 ? 0 : 1_000_000;
    });
    expect(cutOff).toEqual({ firings: [], sessions: 0, partial: true });
    const full = await count();
    expect(full.firings[0]?.count).toBe(2_500);
  });

  test("no sessions gives an empty, complete result", async () => {
    expect(await count()).toEqual({ firings: [], sessions: 0, partial: false });
  });
});
