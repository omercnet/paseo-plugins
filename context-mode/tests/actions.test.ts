import type { PluginSettings } from "@getpaseo/plugin/server";
import { describe, expect, test } from "vitest";
import { createContextModeActionHandlers, parseContextModeDoctorOutput } from "../server/actions";
import { getContextModeDoctorReport } from "../shared/actions";
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
  test("doctor accepts only the four supported providers and rejects unrelated input", () => {
    for (const provider of ["claude", "codex", "copilot", "opencode"]) {
      expect(getContextModeDoctorReport.input.safeParse({ provider }).success).toBe(true);
    }
    for (const provider of ["cursor", "pi", "omp", "omp-plugin", "unknown"]) {
      expect(getContextModeDoctorReport.input.safeParse({ provider }).success).toBe(false);
    }
    expect(
      getContextModeDoctorReport.input.safeParse({ provider: "codex", execute: true }).success,
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
});
