import type { PluginSettings } from "@getpaseo/plugin/server";
import { describe, expect, test } from "vitest";
import { createContextModeActionHandlers, parseContextModeDoctorOutput } from "../server/actions";
import {
  ContextModeActionSchema,
  getContextModeDoctorReport,
  getContextModeInstallAction,
  getContextModeUpgradeAction,
} from "../shared/actions";
import type { ContextModePlatform } from "../shared/knowledge";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  type contextModeSettings,
} from "../shared/settings";

function settingsHandle(
  values: ContextModeSettings = ContextModeSettingsSchema.parse({}),
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

const PROBE = { cwd: "/paseo/plugin-data/context-mode/probe/cwd", dataDir: "/paseo/probe" };
const probeOptions = async (platform: ContextModePlatform = "claude-code") => ({
  platform,
  ...PROBE,
});

/** Cells as upstream prints them: unescaped pipes, and a Fix cell that restates the failure. */
const DOCTOR_OUTPUT = [
  "Environment: context-mode 2.1.4 (b496e20), agent claude-code 0 (client paseo-context-mode)",
  "Environment: linux-x64, Node v24.15.0, shell sh",
  "| Check | Status | Detail | Fix |",
  "|---|---|---|---|",
  "| D1 version | UNKNOWN | 2.1.4 (b496e20): latest unknown, npm registry: fetch failed | Fix: npm view context-mode dist-tags |",
  "| D3 host config | FAIL | wrong: MCP entry, hook entries | FAIL claude-code: D3 — wrong: MCP entry, hook entries. Fix: context-mode setup --agents claude-code |",
  "| D4 old entries | WARN | a | b |  |",
  "| D5b double-fire | PASS | ok |  |",
  "Run in a terminal: context-mode setup --agents claude-code",
].join("\n");

const DOCTOR_ROWS = [
  {
    status: "error",
    check: "D1 version",
    detail: "2.1.4 (b496e20): latest unknown, npm registry: fetch failed",
    fix: "npm view context-mode dist-tags",
  },
  {
    status: "warning",
    check: "D3 host config",
    detail: "wrong: MCP entry, hook entries",
    fix: "context-mode setup --agents claude-code",
  },
  { status: "warning", check: "D4 old entries", detail: "a | b" },
  { status: "ok", check: "D5b double-fire", detail: "ok" },
];

describe("action RPC contracts", () => {
  test("accepts only the four supported providers and rejects unrelated input", () => {
    for (const contract of [
      getContextModeDoctorReport,
      getContextModeInstallAction,
      getContextModeUpgradeAction,
    ]) {
      for (const provider of ["claude", "codex", "copilot", "opencode"]) {
        expect(contract.input.safeParse({ provider }).success).toBe(true);
      }
      for (const provider of ["cursor", "pi", "omp", "omp-plugin", "unknown"]) {
        expect(contract.input.safeParse({ provider }).success).toBe(false);
      }
      expect(contract.input.safeParse({ provider: "codex", execute: true }).success).toBe(false);
    }
  });

  test("accepts argv descriptors with an optional follow-up and rejects shell strings", () => {
    const descriptor = {
      program: "npm",
      args: ["install", "-g", "context-mode@2.1.4", "--no-audit", "--no-fund"],
      followUp: { program: "context-mode", args: ["setup", "--agents", "codex"] },
      currentVersion: null,
      targetVersion: "2.1.4",
      platform: "codex",
      requiresRestart: true,
    };
    expect(ContextModeActionSchema.safeParse(descriptor).success).toBe(true);
    expect(ContextModeActionSchema.safeParse({ ...descriptor, followUp: undefined }).success).toBe(
      true,
    );
    expect(
      ContextModeActionSchema.safeParse({ ...descriptor, command: "npm install -g context-mode" })
        .success,
    ).toBe(false);
    expect(
      ContextModeActionSchema.safeParse({
        ...descriptor,
        followUp: { ...descriptor.followUp, command: "context-mode setup" },
      }).success,
    ).toBe(false);
    expect(
      ContextModeActionSchema.safeParse({ ...descriptor, args: ["x".repeat(4_097)] }).success,
    ).toBe(false);
    expect(
      ContextModeActionSchema.safeParse({ ...descriptor, targetVersion: "1.0.169" }).success,
    ).toBe(false);
  });
});

describe("structured actions", () => {
  test("parses the v2 doctor table and ignores everything else", () => {
    expect(parseContextModeDoctorOutput(DOCTOR_OUTPUT)).toEqual(DOCTOR_ROWS);
    expect(parseContextModeDoctorOutput("[OK] Runtimes: 8/11 available")).toEqual([]);
  });

  test("runs ctx_doctor against the plugin-owned probe store", async () => {
    const handlers = createContextModeActionHandlers(settingsHandle(), {
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: { program: "/bin/context-mode", args: [] },
      }),
      probeOptions,
      callTool: async (_launch, name, arguments_, _dependencies, options) => {
        expect(name).toBe("ctx_doctor");
        expect(arguments_).toEqual({});
        expect(options).toEqual({ platform: "codex", ...PROBE });
        return DOCTOR_OUTPUT;
      },
    });
    await expect(handlers.doctor({ provider: "codex" })).resolves.toEqual({
      platform: "codex",
      rows: DOCTOR_ROWS,
      rawOutput: DOCTOR_OUTPUT,
    });
  });

  test("returns install and upgrade argv for review without executing either", async () => {
    let toolCalls = 0;
    const handlers = createContextModeActionHandlers(settingsHandle(), {
      osPlatform: "linux",
      resolveBinary: async () => ({
        state: "found",
        path: "/opt/context-mode/cli.mjs",
        source: "bundled",
        launch: { program: "/usr/bin/node", args: ["/opt/context-mode/cli.mjs"] },
      }),
      probeOptions,
      inspect: async (_launch, _dependencies, options) => {
        expect(options).toEqual({ platform: "copilot-cli", ...PROBE });
        return { version: "2.1.3", tools: ["ctx_doctor"] };
      },
      callTool: async () => {
        toolCalls += 1;
        return "unexpected";
      },
    });

    await expect(handlers.install({ provider: "copilot" })).resolves.toEqual({
      program: "npm",
      args: ["install", "-g", "context-mode@2.1.4", "--no-audit", "--no-fund"],
      followUp: { program: "context-mode", args: ["setup", "--agents", "copilot-cli"] },
      currentVersion: "2.1.3",
      targetVersion: "2.1.4",
      platform: "copilot-cli",
      requiresRestart: true,
    });
    await expect(handlers.upgrade({ provider: "copilot" })).resolves.toEqual({
      program: "/usr/bin/node",
      args: ["/opt/context-mode/cli.mjs", "upgrade", "--agents", "copilot-cli"],
      currentVersion: "2.1.3",
      targetVersion: "latest",
      platform: "copilot-cli",
      requiresRestart: true,
    });
    expect(toolCalls).toBe(0);
  });

  test("still returns an install descriptor when Context Mode is absent or unsupported", async () => {
    const absent = createContextModeActionHandlers(settingsHandle(), {
      osPlatform: "win32",
      resolveBinary: async () => ({
        state: "missing",
        code: "not-installed",
        message: "not installed",
      }),
    });
    await expect(absent.install({ provider: "opencode" })).resolves.toMatchObject({
      program: "npm.cmd",
      followUp: { program: "context-mode", args: ["setup", "--agents", "opencode"] },
      currentVersion: null,
      platform: "opencode",
      targetVersion: "2.1.4",
    });

    const legacy = createContextModeActionHandlers(settingsHandle(), {
      osPlatform: "linux",
      resolveBinary: async () => ({
        state: "found",
        path: "/usr/bin/context-mode",
        source: "path",
        launch: { program: "/usr/bin/context-mode", args: [] },
      }),
      probeOptions,
      inspect: async () => {
        throw new Error("Context Mode 1.x is unsupported");
      },
    });
    await expect(legacy.upgrade({ provider: "claude" })).resolves.toMatchObject({
      program: "/usr/bin/context-mode",
      args: ["upgrade", "--agents", "claude-code"],
      currentVersion: null,
    });
  });
});
