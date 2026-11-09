import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { detectHostHookApi } from "../server/hook-compat";
import { OmpOperationalFailureCollector } from "../server/operational-failure-diagnostics";
import { OmpProtocolViolationCollector } from "../server/protocol-violation-diagnostics";
import { resolveGetOmpSupportReport } from "../server/support-diagnostics";
import { registerOmpTurnRows } from "../server/turn-rows";

type HookHandler = (payload: unknown, context: unknown) => Promise<void>;

interface RecordedServer {
  handlers: Map<string, (input: unknown) => unknown>;
  hooks: Map<string, HookHandler>;
  beforeHooks: Map<string, HookHandler>;
  providers: number;
}

const homes: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "paseo-omp-hook-compat-"));
  homes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CONFIG_DIR", ".omp");
  vi.stubEnv("PASEO_OMP_AGENT_DIR", join(home, ".omp", "agent"));
  delete process.env.OMP_PROFILE;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** The pre-0.15 plugin host: lifecycle registration has `on`/`before` only. */
function server014(): { server: PluginServerContext; recorded: RecordedServer } {
  const recorded = emptyServer();
  const settings = {
    read: async () => ({ status: "invalid" as const, revision: "0", error: "test" }),
    subscribe: () => () => {},
  };
  const server = {
    handle(contract: { name: string }, handler: (input: unknown) => unknown) {
      recorded.handlers.set(contract.name, handler);
    },
    on(name: string, handler: HookHandler) {
      recorded.hooks.set(name, handler);
      return () => recorded.hooks.delete(name);
    },
    before(name: string, handler: HookHandler) {
      recorded.beforeHooks.set(name, handler);
      return () => recorded.beforeHooks.delete(name);
    },
    registerSettings: () => settings,
    registerUsageSource: () => {},
    registerProvider: () => {
      recorded.providers += 1;
    },
  } as unknown as PluginServerContext;
  return { server, recorded };
}

/** The 0.15 plugin host: `addHook` with canonical names, plus the deprecated aliases. */
function server015(): { server: PluginServerContext; recorded: RecordedServer } {
  const recorded = emptyServer();
  const settings = {
    read: async () => ({ status: "invalid" as const, revision: "0", error: "test" }),
    subscribe: () => () => {},
  };
  const mapHook = (map: Map<string, HookHandler>) => (name: string, handler: HookHandler) => {
    map.set(name, handler);
    return () => map.delete(name);
  };
  const server = {
    handle(contract: { name: string }, handler: (input: unknown) => unknown) {
      recorded.handlers.set(contract.name, handler);
    },
    addHook: mapHook(recorded.hooks),
    on: mapHook(new Map()),
    before: mapHook(recorded.beforeHooks),
    registerSettings: () => settings,
    registerUsageSource: () => {},
    registerProvider: () => {
      recorded.providers += 1;
    },
  } as unknown as PluginServerContext;
  return { server, recorded };
}

/** A host that offers neither lifecycle API; only the mandatory registration calls. */
function serverWithoutLifecycle(): { server: PluginServerContext; recorded: RecordedServer } {
  const recorded = emptyServer();
  const settings = {
    read: async () => ({ status: "invalid" as const, revision: "0", error: "test" }),
    subscribe: () => () => {},
  };
  const server = {
    handle(contract: { name: string }, handler: (input: unknown) => unknown) {
      recorded.handlers.set(contract.name, handler);
    },
    before: (name: string, handler: HookHandler) => {
      recorded.beforeHooks.set(name, handler);
      return () => recorded.beforeHooks.delete(name);
    },
    registerSettings: () => settings,
    registerUsageSource: () => {},
    registerProvider: () => {
      recorded.providers += 1;
    },
  } as unknown as PluginServerContext;
  return { server, recorded };
}

function emptyServer(): RecordedServer {
  return { handlers: new Map(), hooks: new Map(), beforeHooks: new Map(), providers: 0 };
}

async function supportReport(): Promise<string> {
  const result = await resolveGetOmpSupportReport(
    {},
    new OmpProtocolViolationCollector(() => new Date(), vi.fn()),
    new OmpOperationalFailureCollector(() => new Date()),
    {
      loadHealth: async () => {
        throw new Error("skip provider health");
      },
      loadPluginVersion: async () => "0.0.0-test",
      nodeVersion: "v24.8.0",
    },
  );
  return result.report;
}

describe("host lifecycle compatibility", () => {
  test("detects the lifecycle API without reading a version", () => {
    expect(detectHostHookApi({ addHook: () => () => {}, on: () => () => {} })).toBe("addHook");
    expect(detectHostHookApi({ on: () => () => {}, before: () => () => {} })).toBe("legacy-events");
    expect(detectHostHookApi({ before: () => () => {} })).toBe("not-supported");
  });

  test("registers the full plugin against a 0.14 host without addHook", async () => {
    const { server, recorded: host } = server014();
    const cleanup = contribute(server);
    try {
      expect(host.handlers.size).toBeGreaterThan(40);
      expect(host.hooks.has("agent.turn_started")).toBe(true);
      expect(host.hooks.has("agent.turn_ended")).toBe(true);
      expect(host.hooks.has("agent.turn.before")).toBe(false);
      expect(host.beforeHooks.has("agent.session_open")).toBe(true);
      expect(host.providers).toBeGreaterThan(0);
    } finally {
      cleanup();
    }

    const report = await supportReport();
    expect(report).toContain("compatibility.plugin_hooks: legacy-events");
    expect(report).toContain("compatibility.turn_rows: supported");
  });

  test("registers canonical turn hooks against a 0.15 host", async () => {
    const { server, recorded: host } = server015();
    const cleanup = contribute(server);
    try {
      expect(host.hooks.has("agent.turn.before")).toBe(true);
      expect(host.hooks.has("agent.turn.after")).toBe(true);
      expect(host.hooks.has("agent.turn_started")).toBe(false);
    } finally {
      cleanup();
    }

    const report = await supportReport();
    expect(report).toContain("compatibility.plugin_hooks: addHook");
    expect(report).toContain("compatibility.turn_rows: supported");
  });

  test("loads fully on a host without lifecycle hooks and reports the missing feature", async () => {
    const { server, recorded: host } = serverWithoutLifecycle();
    const cleanup = contribute(server);
    try {
      expect(host.handlers.size).toBeGreaterThan(40);
      expect(host.hooks.size).toBe(0);
      expect(host.providers).toBeGreaterThan(0);
    } finally {
      cleanup();
    }

    const report = await supportReport();
    expect(report).toContain("compatibility.plugin_hooks: not-supported");
    expect(report).toContain("compatibility.turn_rows: not-supported");
  });

  test("appends turn rows through the legacy events on a 0.14 host", async () => {
    const { server, recorded: host } = server014();
    const appended: unknown[] = [];
    const paseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: {
              persistence: { nativeHandle: "/sessions/2026-11-05T09-10-00.000Z_session.jsonl" },
            },
          }),
          timeline: {
            append: async (item: unknown) => {
              appended.push(item);
              return { seq: 1, epoch: "epoch" };
            },
          },
        }),
      },
    };
    const reader = vi.fn(async () => ({ id: "row", kind: "omp-rule-notice", data: { rules: [] } }));
    // The plugin's own readers are covered elsewhere; here only the hook plumbing matters.
    const remove = registerOmpTurnRows(server, [reader]);
    try {
      const agent = { id: "agent", provider: "omp" };
      await host.hooks.get("agent.turn_started")?.({ agent, turnId: "turn" }, { paseo });
      await host.hooks.get("agent.turn_ended")?.({ agent, turnId: "turn" }, { paseo });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(appended).toEqual([
        { type: "plugin", id: "row", kind: "omp-rule-notice", version: 1, data: { rules: [] } },
      ]);
    } finally {
      remove();
    }
  });
});
