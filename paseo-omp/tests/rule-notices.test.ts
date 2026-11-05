import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readOmpRuleNotice, registerOmpRuleNotices } from "../server/rule-notices";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function sessionFile(entries: object[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-rule-notices-"));
  directories.push(directory);
  const file = join(directory, "2026-11-05T09-04-17-959Z_session.jsonl");
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

function injection(
  id: string,
  timestamp: string,
  rules: string[],
  matched?: Record<string, string>,
) {
  return [
    {
      type: "custom_message",
      customType: "ttsr-injection",
      display: false,
      details: { rules, ...(matched ? { matched } : {}) },
      id: `${id}-message`,
      timestamp,
    },
    { type: "ttsr_injection", id, timestamp, injectedRules: rules },
  ];
}

describe("OMP rule notices", () => {
  test("reports only rules injected during the turn, with their matched text", async () => {
    const file = await sessionFile([
      { type: "session", id: "session", cwd: "/repo" },
      ...injection("old", "2026-11-05T09:00:00.000Z", ["earlier-rule"]),
      { type: "message", timestamp: "2026-11-05T09:10:00.000Z", message: { role: "user" } },
      ...injection("first", "2026-11-05T09:10:01.000Z", ["no-canary"], { "no-canary": "CANARY" }),
      ...injection("second", "2026-11-05T09:10:02.000Z", ["no-canary", "tool-only"]),
      ...injection("next", "2026-11-05T09:11:00.000Z", ["next-turn-rule"]),
    ]);

    expect(
      await readOmpRuleNotice(
        file,
        Date.parse("2026-11-05T09:10:00.000Z"),
        Date.parse("2026-11-05T09:10:30.000Z"),
      ),
    ).toEqual({
      id: "first",
      notice: {
        rules: [
          { name: "no-canary", matched: "CANARY" },
          { name: "tool-only", matched: null },
        ],
      },
    });
  });

  test("reports nothing for a turn without rule injections or a non-session path", async () => {
    const file = await sessionFile([...injection("old", "2026-11-05T09:00:00.000Z", ["rule"])]);

    const turnStart = Date.parse("2026-11-05T09:10:00.000Z");
    expect(await readOmpRuleNotice(file, turnStart, turnStart + 1_000)).toBeUndefined();
    expect(await readOmpRuleNotice("relative/session.jsonl", 0, turnStart)).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "does not follow a symlinked session path",
    async () => {
      const turnStart = Date.parse("2026-11-05T09:10:00.000Z");
      const target = await sessionFile(
        injection("fired", new Date(turnStart + 1_000).toISOString(), ["no-canary"]),
      );
      const link = join(directories[0] ?? "", "link_session.jsonl");
      await symlink(target, link);

      expect(await readOmpRuleNotice(target, turnStart, turnStart + 5_000)).toBeDefined();
      expect(await readOmpRuleNotice(link, turnStart, turnStart + 5_000)).toBeUndefined();
    },
  );

  test("appends one row per bundled omp turn from its first start, ignoring other providers", async () => {
    const turnStart = Date.parse("2026-11-05T09:10:00.000Z");
    const file = await sessionFile(
      injection("fired", new Date(turnStart + 1_000).toISOString(), ["no-canary"]),
    );
    const hooks = new Map<string, (payload: unknown, context: unknown) => Promise<void>>();
    const server = {
      addHook: (name: string, handler: (payload: unknown, context: unknown) => Promise<void>) => {
        hooks.set(name, handler);
        return () => hooks.delete(name);
      },
    } as unknown as Pick<PluginServerContext, "addHook">;
    const append = vi.fn(async () => ({ seq: 1, epoch: "epoch" }));
    const paseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { persistence: { nativeHandle: file } } }),
          timeline: { append },
        }),
      },
    };
    registerOmpRuleNotices(server);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const provider of ["claude", "omp"]) {
        const agent = { id: provider, provider };
        vi.setSystemTime(turnStart);
        await hooks.get("agent.turn.before")?.({ agent, turnId: "turn" }, { paseo });
        // A tool or retry iteration reports another start for the same Paseo turn.
        vi.setSystemTime(turnStart + 5_000);
        await hooks.get("agent.turn.before")?.({ agent, turnId: "turn" }, { paseo });
        await hooks.get("agent.turn.after")?.({ agent, turnId: "turn" }, { paseo });
      }
    } finally {
      vi.useRealTimers();
    }

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({
      type: "plugin",
      id: "rule-notice:fired",
      kind: "omp-rule-notice",
      version: 1,
      data: { rules: [{ name: "no-canary", matched: null }] },
    });
  });
});
