import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { pluginProvidersRequireConfiguration } from "../server/provider/opt-in";

let home: string;
const decide = () => pluginProvidersRequireConfiguration({ PASEO_HOME: home });
const markerPath = () => join(home, "plugin-data", "paseo-omp", "provider-opt-in.json");

function write(relative: string, content: unknown): void {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "paseo-omp-opt-in-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("plugin providers are opt-in for new installs", () => {
  test("a fresh home requires configuration and records nothing", () => {
    expect(decide()).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
  });

  test("agents on the bundled omp provider are not use of the plugin provider", () => {
    write("agents/project/a.json", { id: "a", provider: "omp" });
    write("config.json", { agents: { providers: { omp: { enabled: true } } } });
    expect(decide()).toBe(true);
  });

  describe.each([
    ["an agent record in a project folder", "agents/project/a.json", { provider: "omp-plugin" }],
    ["an agent record at the root", "agents/a.json", { provider: "omp-plugin" }],
    ["a profile agent record", "agents/project/a.json", { provider: "omp-plugin-work" }],
    [
      "a schedule that creates plugin agents",
      "schedules/s.json",
      { target: { type: "new-agent", config: { provider: "omp-plugin-work", cwd: "/x" } } },
    ],
    [
      "a config entry for the provider",
      "config.json",
      { agents: { providers: { "omp-plugin": { enabled: false } } } },
    ],
    [
      "a config provider extending the plugin provider",
      "config.json",
      { agents: { providers: { mine: { extends: "omp-plugin", label: "Mine" } } } },
    ],
    [
      "a saved agent profile",
      "config.json",
      { daemon: { agentProfiles: [{ provider: "omp-plugin" }] } },
    ],
    [
      "a metadata generation provider",
      "config.json",
      { agents: { metadataGeneration: { providers: [{ provider: "omp-plugin-work" }] } } },
    ],
  ])("existing use via %s", (_name, file, content) => {
    test("keeps the providers available", () => {
      write(file, content);
      expect(decide()).toBe(false);
    });
  });

  test("a schedule that targets an existing agent is not evidence", () => {
    write("schedules/s.json", { target: { type: "agent", agentId: "x" } });
    expect(decide()).toBe(true);
  });

  test("unreadable or malformed evidence keeps the providers available", () => {
    write("agents/project/a.json", "{ not json");
    expect(decide()).toBe(false);
  });

  test("an agents path that cannot be listed keeps the providers available", () => {
    write("agents", "a file where the folder should be");
    expect(decide()).toBe(false);
  });

  test("agent use is latched: removing the last agent does not hide the providers", () => {
    write("agents/project/a.json", { provider: "omp-plugin" });
    expect(decide()).toBe(false);
    expect(JSON.parse(readFileSync(markerPath(), "utf8"))).toEqual({
      version: 1,
      legacyUse: true,
    });
    rmSync(join(home, "agents"), { recursive: true });
    expect(decide()).toBe(false);
  });

  test("a new install that later uses the providers keeps them", () => {
    expect(decide()).toBe(true);
    write("schedules/s.json", {
      target: { type: "new-agent", config: { provider: "omp-plugin", cwd: "/x" } },
    });
    expect(decide()).toBe(false);
  });

  test("config references are read on every start, never latched", () => {
    expect(decide()).toBe(true);
    write("config.json", { agents: { providers: { mine: { extends: "omp-plugin" } } } });
    expect(decide()).toBe(false);
    rmSync(join(home, "config.json"));
    expect(decide()).toBe(true);
  });

  test("a malformed marker keeps the providers available and is left alone", () => {
    write("plugin-data/paseo-omp/provider-opt-in.json", "garbage");
    expect(decide()).toBe(false);
    expect(readFileSync(markerPath(), "utf8")).toBe("garbage");
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked record is not silently ignored and is not latched",
    () => {
      write("elsewhere/a.json", { provider: "omp-plugin" });
      mkdirSync(join(home, "agents", "project"), { recursive: true });
      symlinkSync(join(home, "elsewhere", "a.json"), join(home, "agents", "project", "a.json"));
      expect(decide()).toBe(false);
      expect(existsSync(markerPath())).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a FIFO where config.json should be cannot block startup",
    () => {
      execFileSync("mkfifo", [join(home, "config.json")]);
      const script = `import { pluginProvidersRequireConfiguration as decide } from ${JSON.stringify(
        join(import.meta.dirname, "../server/provider/opt-in.ts"),
      )}; console.log(decide({ PASEO_HOME: process.env.OPT_IN_HOME }));`;
      const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
        env: { ...process.env, OPT_IN_HOME: home },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.stdout.trim()).toBe("false");
    },
  );

  test("more records than the startup bound keeps the providers on without claiming use", () => {
    const schedules = join(home, "schedules");
    mkdirSync(schedules, { recursive: true });
    for (let index = 0; index <= 10_000; index += 1) {
      writeFileSync(join(schedules, `${index}.json`), "{}");
    }
    expect(decide()).toBe(false);
    expect(existsSync(markerPath())).toBe(false);
  });
});

describe("registration", () => {
  function registered(): Array<{ id: string; requiresConfiguration?: boolean }> {
    vi.stubEnv("PASEO_HOME", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CONFIG_DIR", ".omp");
    mkdirSync(join(home, ".omp", "profiles", "work"), { recursive: true });
    const providers: Array<{ id: string; requiresConfiguration?: boolean }> = [];
    const cleanup = contribute({
      handle: () => {},
      addHook: () => () => {},
      before: () => () => {},
      registerSettings: () => ({ subscribe: () => () => {}, read: async () => ({ status: "x" }) }),
      registerProvider: (provider: { id: string; requiresConfiguration?: boolean }) => {
        providers.push(provider);
      },
    } as unknown as PluginServerContext);
    if (typeof cleanup === "function") cleanup();
    return providers;
  }
  afterEach(() => vi.unstubAllEnvs());

  test("new installs register the plugin and profile providers as config-required", () => {
    const providers = registered();
    expect(providers.map((provider) => provider.id).sort()).toEqual([
      "omp-plugin",
      "omp-plugin-work",
    ]);
    expect(providers.every((provider) => provider.requiresConfiguration === true)).toBe(true);
  });

  test("existing users keep every plugin provider registered without configuration", () => {
    write("agents/project/a.json", { provider: "omp-plugin-work" });
    const providers = registered();
    expect(providers).toHaveLength(2);
    expect(providers.some((provider) => provider.requiresConfiguration)).toBe(false);
  });
});
