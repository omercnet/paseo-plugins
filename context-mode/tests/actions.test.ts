import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { describe, expect, test } from "vitest";
import { createContextModeActionHandlers, parseContextModeDoctorOutput } from "../server/actions";
import { getContextModeDoctorReport } from "../shared/actions";
import type { ContextModePlatform } from "../shared/providers";
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
  { status: "warning", check: "D3 host config", detail: "wrong: MCP entry, hook entries" },
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
    expect(parseContextModeDoctorOutput(DOCTOR_OUTPUT, "settings")).toEqual(DOCTOR_ROWS);
    expect(parseContextModeDoctorOutput("[OK] Runtimes: 8/11 available", "settings")).toEqual([]);
  });

  test("never offers ctx_upgrade or setup, and fits upgrade advice to the runtime", () => {
    const outdated = [
      "| D1 version | FAIL | 2.1.4 (b496e20): update available, latest on npm is 2.1.5 | Fix: run ctx_upgrade |",
      "| D5 hook round trip | FAIL | hook output is not the agent's native shape | Fix: run ctx_upgrade |",
    ].join("\n");
    expect(parseContextModeDoctorOutput(outdated, "bundled")).toEqual([
      {
        status: "warning",
        check: "D1 version",
        detail: "2.1.4 (b496e20): update available, latest on npm is 2.1.5",
        fix: "Update the Context Mode plugin in Paseo",
      },
      {
        status: "warning",
        check: "D5 hook round trip",
        detail: "hook output is not the agent's native shape",
      },
    ]);
    expect(parseContextModeDoctorOutput(outdated, "settings")[0]).toMatchObject({
      status: "error",
      fix: "Upgrade the Context Mode install configured in settings",
    });
  });

  test("runs ctx_doctor against the plugin-owned probe store", async () => {
    const handlers = createContextModeActionHandlers(settingsHandle(), {
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "settings",
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

  test("deletes the doctor report even when upstream prints its path with ~", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "paseo-context-mode-doctor-"));
    const reports = join(dataDir, "reports");
    await mkdir(reports);
    const name = "doctor-2026-11-07T09-30-00-000Z.md";
    const outside = join(dataDir, "keep.md");
    await writeFile(join(reports, name), "report");
    await writeFile(outside, "not a report");
    try {
      const handlers = createContextModeActionHandlers(settingsHandle(), {
        resolveBinary: async () => ({
          state: "found",
          path: "/bin/context-mode",
          source: "bundled",
          launch: { program: "/bin/context-mode", args: [] },
        }),
        probeOptions: async (platform: ContextModePlatform = "claude-code") => ({
          platform,
          cwd: dataDir,
          dataDir,
        }),
        callTool: async () => `${DOCTOR_OUTPUT}\nReport file: ~/.paseo/probe/reports/${name}`,
      });
      await handlers.doctor({ provider: "codex" });
      expect(await readdir(reports)).toEqual([]);

      // A reported path that is not a doctor report name is never deleted.
      const crafted = createContextModeActionHandlers(settingsHandle(), {
        resolveBinary: async () => ({
          state: "found",
          path: "/bin/context-mode",
          source: "bundled",
          launch: { program: "/bin/context-mode", args: [] },
        }),
        probeOptions: async (platform: ContextModePlatform = "claude-code") => ({
          platform,
          cwd: dataDir,
          dataDir,
        }),
        callTool: async () => `${DOCTOR_OUTPUT}\nReport file: ${outside}`,
      });
      await crafted.doctor({ provider: "codex" });
      expect(await readFile(outside, "utf8")).toBe("not a report");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
