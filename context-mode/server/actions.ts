import type { PluginSettings } from "@getpaseo/plugin/server";
import {
  CONTEXT_MODE_TARGET_VERSION,
  type ContextModeAction,
  type ContextModeActionInput,
  type DoctorReport,
  type DoctorStatusRow,
} from "../shared/actions";
import type { ContextModeSettings, contextModeSettings } from "../shared/settings";
import { type BinaryResolution, type LaunchDescriptor, resolveContextModeBinary } from "./binary";
import { contextModeEnvironmentFor, contextModePlatformFor } from "./knowledge";
import {
  callContextModeTool,
  inspectContextMode,
  type McpInspection,
  type McpProcessDependencies,
  type McpToolArguments,
} from "./mcp-process";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;

type ActionToolCaller = (
  launch: LaunchDescriptor,
  name: "ctx_doctor",
  arguments_: McpToolArguments,
  dependencies: McpProcessDependencies,
) => Promise<string>;

export interface ActionHandlerDependencies {
  osPlatform?: NodeJS.Platform;
  resolveBinary?: (settings: ContextModeSettings) => Promise<BinaryResolution>;
  inspect?: (
    launch: LaunchDescriptor,
    dependencies?: McpProcessDependencies,
  ) => Promise<McpInspection>;
  callTool?: ActionToolCaller;
}

export interface ContextModeActionHandlers {
  doctor(input: ContextModeActionInput): Promise<DoctorReport>;
  install(input: ContextModeActionInput): Promise<ContextModeAction>;
  upgrade(input: ContextModeActionInput): Promise<ContextModeAction>;
}

export function parseContextModeDoctorOutput(rawOutput: string): DoctorStatusRow[] {
  const rows: DoctorStatusRow[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const match = /^\[(OK|WARN|FAIL)\]\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const body = match[2] ?? "";
    const separator = body.indexOf(":");
    const check = (separator < 0 ? body : body.slice(0, separator)).trim().slice(0, 256);
    if (!check) continue;
    const detail = (separator < 0 ? "" : body.slice(separator + 1).trim()).slice(0, 4_096);
    rows.push({
      status: match[1] === "OK" ? "ok" : match[1] === "WARN" ? "warning" : "error",
      check,
      detail,
    });
    if (rows.length === 64) break;
  }
  return rows;
}

export function createContextModeActionHandlers(
  settingsHandle: SettingsHandle,
  dependencies: ActionHandlerDependencies = {},
): ContextModeActionHandlers {
  const resolveBinary = dependencies.resolveBinary ?? resolveContextModeBinary;
  const inspect = dependencies.inspect ?? inspectContextMode;
  const callTool = dependencies.callTool ?? callContextModeTool;
  const osPlatform = dependencies.osPlatform ?? process.platform;

  async function resolvedBinary(): Promise<Extract<BinaryResolution, { state: "found" }>> {
    const settings = await settingsHandle.read();
    if (settings.status !== "ready") {
      throw new Error(`Context Mode settings are invalid: ${settings.error}`.slice(0, 4_096));
    }
    const binary = await resolveBinary(settings.values);
    if (binary.state === "missing") throw new Error(binary.message.slice(0, 4_096));
    return binary;
  }

  async function currentVersion(input: ContextModeActionInput): Promise<string | null> {
    try {
      const binary = await resolvedBinary();
      const inspection = await inspect(binary.launch, {
        env: contextModeEnvironmentFor(input.provider),
      });
      return inspection.version?.slice(0, 128) ?? null;
    } catch {
      return null;
    }
  }

  return {
    async doctor(input) {
      const binary = await resolvedBinary();
      const rawOutput = await callTool(
        binary.launch,
        "ctx_doctor",
        {},
        {
          env: contextModeEnvironmentFor(input.provider),
        },
      );
      return {
        platform: contextModePlatformFor(input.provider),
        rows: parseContextModeDoctorOutput(rawOutput),
        rawOutput,
      };
    },
    async install(input) {
      const platform = contextModePlatformFor(input.provider);
      return {
        program: osPlatform === "win32" ? "npm.cmd" : "npm",
        args: [
          "install",
          "-g",
          `context-mode@${CONTEXT_MODE_TARGET_VERSION}`,
          "--no-audit",
          "--no-fund",
        ],
        currentVersion: await currentVersion(input),
        targetVersion: CONTEXT_MODE_TARGET_VERSION,
        platform,
        requiresRestart: true,
      };
    },
    async upgrade(input) {
      const platform = contextModePlatformFor(input.provider);
      const binary = await resolvedBinary();
      const inspection = await inspect(binary.launch, {
        env: contextModeEnvironmentFor(input.provider),
      });
      return {
        program: binary.launch.program,
        args: [...binary.launch.args, "upgrade", "--platform", platform],
        currentVersion: inspection.version?.slice(0, 128) ?? null,
        targetVersion: "latest",
        platform,
        requiresRestart: true,
      };
    },
  };
}
