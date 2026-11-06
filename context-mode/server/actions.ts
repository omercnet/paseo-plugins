import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { ContextModeActionInput, DoctorReport, DoctorStatusRow } from "../shared/actions";
import type { contextModeSettings } from "../shared/settings";
import { type BinaryResolution, resolveContextModeBinary } from "./binary";
import { contextModeProbeOptions } from "./handlers";
import type { ProviderConfigSource } from "./integration";
import { contextModePlatformFor } from "./knowledge";
import { callContextModeTool } from "./mcp-process";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;

export interface ActionHandlerDependencies {
  resolveBinary?: typeof resolveContextModeBinary;
  callTool?: typeof callContextModeTool;
  probeOptions?: typeof contextModeProbeOptions;
}

type ActionContext = { paseo?: ProviderConfigSource };

export interface ContextModeActionHandlers {
  doctor(input: ContextModeActionInput, context?: ActionContext): Promise<DoctorReport>;
}

const DOCTOR_STATUS = { PASS: "ok", WARN: "warning", FAIL: "error", UNKNOWN: "error" } as const;

/**
 * D3 compares the agent's own host config with Context Mode's setup. Paseo injects the MCP server
 * instead, so D3 fails for every injected agent; it is advice, not a fault.
 */
const INFORMATIONAL_CHECK = /^D3\b/;

/**
 * Parses the `| Check | Status | Detail | Fix |` table that `ctx_doctor` prints. Upstream does not
 * escape pipes, so the first two cells are check and status, the last is the fix, and whatever is
 * between them is the detail. The fix cell leads with a restatement; only the command after the
 * last `Fix:` is kept.
 */
export function parseContextModeDoctorOutput(rawOutput: string): DoctorStatusRow[] {
  const rows: DoctorStatusRow[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const check = cells[0] ?? "";
    const status = cells[1] ?? "";
    if (!Object.hasOwn(DOCTOR_STATUS, status) || !check) continue;
    const detail = cells.slice(2, -1).join(" | ");
    const fix = (cells.at(-1) ?? "").split("Fix:").at(-1)?.trim() ?? "";
    const mapped = DOCTOR_STATUS[status as keyof typeof DOCTOR_STATUS];
    rows.push({
      status: mapped === "error" && INFORMATIONAL_CHECK.test(check) ? "warning" : mapped,
      check: check.slice(0, 256),
      detail: detail.slice(0, 4_096),
      ...(fix ? { fix: fix.slice(0, 4_096) } : {}),
    });
    if (rows.length === 64) break;
  }
  return rows;
}

/** ctx_doctor writes a report file per failing check and nothing prunes them; the panel keeps none. */
async function discardDoctorReport(output: string, dataDir: string): Promise<void> {
  const reported = /^Report file: (.+)$/m.exec(output)?.[1]?.trim();
  if (reported && resolve(reported).startsWith(resolve(dataDir) + sep)) {
    await rm(reported, { force: true });
  }
}

export function createContextModeActionHandlers(
  settingsHandle: SettingsHandle,
  dependencies: ActionHandlerDependencies = {},
): ContextModeActionHandlers {
  const resolveBinary = dependencies.resolveBinary ?? resolveContextModeBinary;
  const callTool = dependencies.callTool ?? callContextModeTool;
  const probeOptions = dependencies.probeOptions ?? contextModeProbeOptions;

  async function resolvedBinary(
    paseo: ProviderConfigSource | undefined,
  ): Promise<Extract<BinaryResolution, { state: "found" }>> {
    const settings = await settingsHandle.read();
    if (settings.status !== "ready") {
      throw new Error(`Context Mode settings are invalid: ${settings.error}`.slice(0, 4_096));
    }
    const binary = await resolveBinary(settings.values, { paseo });
    if (binary.state === "missing") throw new Error(binary.message.slice(0, 4_096));
    return binary;
  }

  return {
    async doctor(input, context) {
      const platform = contextModePlatformFor(input.provider);
      const binary = await resolvedBinary(context?.paseo);
      // ctx_doctor writes a report and index rows, so it runs against the plugin-owned probe store.
      const options = await probeOptions(platform);
      const rawOutput = await callTool(binary.launch, "ctx_doctor", {}, {}, options);
      await discardDoctorReport(rawOutput, options.dataDir);
      return { platform, rows: parseContextModeDoctorOutput(rawOutput), rawOutput };
    },
  };
}
