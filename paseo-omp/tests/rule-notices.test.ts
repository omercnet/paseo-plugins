import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ompRuleNoticeRow, readOmpRuleNotice } from "../server/rule-notices";
import { registerOmpTurnRows } from "../server/turn-rows";

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

  test.each([
    ["0.14 host with only on()", hostWithOnOnly],
    ["0.15 host with on() and addHook()", hostWithAddHook],
  ])(
    "on a %s, registers both turn hooks and appends one row per bundled omp turn",
    async (_, makeHost) => {
      const turnStart = Date.parse("2026-11-05T09:10:00.000Z");
      const file = await sessionFile(
        injection("fired", new Date(turnStart + 1_000).toISOString(), ["no-canary"]),
      );
      const host = makeHost();
      const append = vi.fn(async () => ({ seq: 1, epoch: "epoch" }));
      const paseo = {
        agents: {
          ref: () => ({
            refresh: async () => ({ agent: { persistence: { nativeHandle: file } } }),
            timeline: { append },
          }),
        },
      };
      const remove = registerOmpTurnRows(host.server, [ompRuleNoticeRow]);

      expect(host.handlers.size).toBe(2);
      expect(host.handlers.get(host.started)).toHaveLength(1);
      expect(host.handlers.get(host.ended)).toHaveLength(1);
      const fire = async (hook: string, agent: { id: string; provider: string }) => {
        for (const handler of host.handlers.get(hook) ?? []) {
          await handler({ agent, turnId: "turn" }, { paseo });
        }
      };

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        for (const provider of ["claude", "omp"]) {
          const agent = { id: provider, provider };
          vi.setSystemTime(turnStart);
          await fire(host.started, agent);
          // A tool or retry iteration reports another start for the same Paseo turn.
          vi.setSystemTime(turnStart + 5_000);
          await fire(host.started, agent);
          await fire(host.ended, agent);
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

      remove();
      expect([...host.handlers.values()].flat()).toEqual([]);
    },
  );
});

type TurnHookHandler = (payload: unknown, context: unknown) => Promise<void>;

interface TurnHookHost {
  server: Pick<PluginServerContext, "on">;
  /** Registered handlers by the name the host dispatches them under. */
  handlers: Map<string, TurnHookHandler[]>;
  started: string;
  ended: string;
}

function registry(): {
  handlers: Map<string, TurnHookHandler[]>;
  register: (name: string, handler: TurnHookHandler) => () => void;
} {
  const handlers = new Map<string, TurnHookHandler[]>();
  const register = (name: string, handler: TurnHookHandler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return () => {
      const rest = (handlers.get(name) ?? []).filter((entry) => entry !== handler);
      if (rest.length > 0) handlers.set(name, rest);
      else handlers.delete(name);
    };
  };
  return { handlers, register };
}

/** Paseo 0.14: only the legacy event names, no `addHook`. */
function hostWithOnOnly(): TurnHookHost {
  const { handlers, register } = registry();
  const server = { on: register, before: () => () => {} };
  return {
    server: server as unknown as Pick<PluginServerContext, "on">,
    handlers,
    started: "agent.turn_started",
    ended: "agent.turn_ended",
  };
}

/** Paseo 0.15: `on` routes the legacy names to the canonical hooks, as the SDK adapter does. */
function hostWithAddHook(): TurnHookHost {
  const { handlers, register } = registry();
  const legacy: Record<string, string> = {
    "agent.turn_started": "agent.turn.before",
    "agent.turn_ended": "agent.turn.after",
  };
  const server = {
    addHook: register,
    on: (name: string, handler: TurnHookHandler) => {
      const hook = legacy[name];
      if (!hook) throw new Error(`Unknown lifecycle event: ${name}`);
      return register(hook, handler);
    },
    before: () => () => {},
  };
  return {
    server: server as unknown as Pick<PluginServerContext, "on">,
    handlers,
    started: "agent.turn.before",
    ended: "agent.turn.after",
  };
}
