import type { PluginSettings } from "@getpaseo/plugin/server";
import { describe, expect, test } from "vitest";
import { createContextModeActionHandlers, parseContextModeDoctorOutput } from "../server/actions";
import {
  ContextModeActionSchema,
  getContextModeDoctorReport,
  getContextModeInstallAction,
  getContextModeUpgradeAction,
} from "../shared/actions";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  type contextModeSettings,
} from "../shared/settings";

function settingsHandle(
  values: ContextModeSettings,
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

describe("action RPC contracts", () => {
  test("requires a known provider and rejects unrelated input", () => {
    for (const contract of [
      getContextModeDoctorReport,
      getContextModeInstallAction,
      getContextModeUpgradeAction,
    ]) {
      expect(contract.input.safeParse({ provider: "codex" }).success).toBe(true);
      expect(contract.input.safeParse({ provider: "unknown" }).success).toBe(false);
      expect(contract.input.safeParse({ provider: "codex", execute: true }).success).toBe(false);
    }
  });

  test("accepts argv descriptors and rejects shell command strings", () => {
    const descriptor = {
      program: "node",
      args: ["/opt/context-mode/cli.bundle.mjs", "upgrade", "--platform", "codex"],
      currentVersion: "1.0.168",
      targetVersion: "1.0.169",
      platform: "codex",
      requiresRestart: true,
    };
    expect(ContextModeActionSchema.safeParse(descriptor).success).toBe(true);
    expect(
      ContextModeActionSchema.safeParse({
        ...descriptor,
        command: "node /opt/context-mode/cli.bundle.mjs upgrade",
      }).success,
    ).toBe(false);
    expect(
      ContextModeActionSchema.safeParse({ ...descriptor, args: ["x".repeat(4_097)] }).success,
    ).toBe(false);
  });
});

describe("structured actions", () => {
  test("parses doctor status rows and retains the raw report", async () => {
    const rawOutput = [
      "context-mode doctor",
      "",
      "[OK] Runtimes: 8/11 available",
      "[WARN] Performance: install Bun",
      "[FAIL] FTS5 / SQLite: unavailable",
    ].join("\n");
    expect(parseContextModeDoctorOutput(rawOutput)).toEqual([
      { status: "ok", check: "Runtimes", detail: "8/11 available" },
      { status: "warning", check: "Performance", detail: "install Bun" },
      { status: "error", check: "FTS5 / SQLite", detail: "unavailable" },
    ]);

    const handlers = createContextModeActionHandlers(
      settingsHandle(ContextModeSettingsSchema.parse({})),
      {
        resolveBinary: async () => ({
          state: "found",
          path: "/bin/context-mode",
          source: "path",
          launch: { program: "/bin/context-mode", args: [] },
        }),
        callTool: async (_launch, _name, arguments_, dependencies) => {
          expect(arguments_).toEqual({});
          expect(dependencies.env?.CONTEXT_MODE_PLATFORM).toBe("claude-code");
          return rawOutput;
        },
      },
    );
    await expect(handlers.doctor({ provider: "claude" })).resolves.toEqual({
      platform: "claude-code",
      rows: [
        { status: "ok", check: "Runtimes", detail: "8/11 available" },
        { status: "warning", check: "Performance", detail: "install Bun" },
        { status: "error", check: "FTS5 / SQLite", detail: "unavailable" },
      ],
      rawOutput,
    });
  });

  test("returns install and provider-specific upgrade argv without executing either", async () => {
    let toolCalls = 0;
    const handlers = createContextModeActionHandlers(
      settingsHandle(ContextModeSettingsSchema.parse({})),
      {
        osPlatform: "linux",
        resolveBinary: async () => ({
          state: "found",
          path: "/opt/context-mode",
          source: "path",
          launch: { program: "/usr/bin/node", args: ["/opt/context-mode/cli.bundle.mjs"] },
        }),
        inspect: async (_launch, dependencies) => {
          expect(dependencies?.env?.CONTEXT_MODE_PLATFORM).toBe("copilot-cli");
          return { version: "1.0.168", tools: ["ctx_doctor"] };
        },
        callTool: async () => {
          toolCalls += 1;
          return "unexpected";
        },
      },
    );

    await expect(handlers.install({ provider: "copilot" })).resolves.toEqual({
      program: "npm",
      args: ["install", "-g", "context-mode@1.0.169", "--no-audit", "--no-fund"],
      currentVersion: "1.0.168",
      targetVersion: "1.0.169",
      platform: "copilot-cli",
      requiresRestart: true,
    });
    await expect(handlers.upgrade({ provider: "copilot" })).resolves.toEqual({
      program: "/usr/bin/node",
      args: ["/opt/context-mode/cli.bundle.mjs", "upgrade", "--platform", "copilot-cli"],
      currentVersion: "1.0.168",
      targetVersion: "latest",
      platform: "copilot-cli",
      requiresRestart: true,
    });
    expect(toolCalls).toBe(0);
  });

  test("still returns an install descriptor when Context Mode is absent", async () => {
    const handlers = createContextModeActionHandlers(
      settingsHandle(ContextModeSettingsSchema.parse({})),
      {
        osPlatform: "win32",
        resolveBinary: async () => ({
          state: "missing",
          code: "not-installed",
          message: "not installed",
        }),
      },
    );
    await expect(handlers.install({ provider: "omp" })).resolves.toMatchObject({
      program: "npm.cmd",
      currentVersion: null,
      platform: "omp",
      targetVersion: "1.0.169",
    });
  });
});
