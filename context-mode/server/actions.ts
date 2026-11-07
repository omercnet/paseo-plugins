import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { ContextModeActionInput, DoctorReport, DoctorStatusRow } from "../shared/actions";
import { contextModePlatformFor } from "../shared/providers";
import type { contextModeSettings } from "../shared/settings";
import { type BinaryResolution, resolveContextModeBinary } from "./binary";
import { contextModeProbeOptions } from "./handlers";
import type { ProviderConfigSource } from "./integration";
import { callContextModeTool } from "./mcp-process";

type BinarySource = Extract<BinaryResolution, { state: "found" }>["source"];

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

const DOCTOR_STATUS: Readonly<Record<string, DoctorStatusRow["status"]>> = {
  PASS: "ok",
  WARN: "warning",
  FAIL: "error",
  UNKNOWN: "error",
};

/**
 * D3 compares the agent's own host config with Context Mode's setup and D5 exercises its hooks.
 * Paseo injects only the MCP server, so both fail for every injected agent: advice, not a fault,
 * and their `context-mode setup` fix would replace Paseo's injection with a native install.
 */
const INFORMATIONAL_CHECK = /^D(3|5b?)\b/;

/** Upstream's fix for an outdated runtime; the plugin offers no in-place upgrade. */
const UPGRADE_FIX = "run ctx_upgrade";

const UPGRADE_ADVICE: Readonly<Record<BinarySource, string>> = {
  bundled: "Update the Context Mode plugin in Paseo",
  settings: "Upgrade the Context Mode install configured in settings",
};

function doctorRow(
  check: string,
  status: DoctorStatusRow["status"],
  detail: string,
  upstreamFix: string,
  runtime: BinarySource,
): DoctorStatusRow {
  const row = { check: check.slice(0, 256), detail: detail.slice(0, 4_096) };
  if (INFORMATIONAL_CHECK.test(check)) {
    return { ...row, status: status === "ok" ? "ok" : "warning" };
  }
  if (upstreamFix === UPGRADE_FIX) {
    // A bundled runtime that trails npm is expected until the next plugin release.
    const upgradeStatus = runtime === "bundled" ? "warning" : status;
    return { ...row, status: upgradeStatus, fix: UPGRADE_ADVICE[runtime] };
  }
  return upstreamFix ? { ...row, status, fix: upstreamFix.slice(0, 4_096) } : { ...row, status };
}

/**
 * Parses the `| Check | Status | Detail | Fix |` table that `ctx_doctor` prints. Upstream does not
 * escape pipes, so the first two cells are check and status, the last is the fix, and whatever is
 * between them is the detail. The fix cell leads with a restatement; only the command after the
 * last `Fix:` is kept, and advice the plugin cannot act on is rewritten for `runtime`.
 */
export function parseContextModeDoctorOutput(
  rawOutput: string,
  runtime: BinarySource,
): DoctorStatusRow[] {
  const rows: DoctorStatusRow[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const [check = "", statusCell = ""] = cells;
    const status = Object.hasOwn(DOCTOR_STATUS, statusCell) ? DOCTOR_STATUS[statusCell] : null;
    if (cells.length < 4 || !check || !status) continue;
    const detail = cells.slice(2, -1).join(" | ");
    const fix = (cells.at(-1) ?? "").split("Fix:").at(-1)?.trim() ?? "";
    rows.push(doctorRow(check, status, detail, fix, runtime));
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
      return {
        platform,
        rows: parseContextModeDoctorOutput(rawOutput, binary.source),
        rawOutput,
      };
    },
  };
}
