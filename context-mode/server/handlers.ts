import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type {
  BinaryStatus,
  CommandReport,
  ContextModeRefreshInput,
  ContextModeSettings,
  contextModeSettings,
  IntegrationAudit,
} from "../shared";
import { type BinaryResolution, type LaunchDescriptor, resolveContextModeBinary } from "./binary";
import {
  createIntegrationAudit,
  type IntegrationDependencies,
  type ProviderConfigSource,
  readProviderOverrides,
} from "./integration";
import {
  callContextModeTool,
  inspectContextMode,
  type McpInspection,
  ProcessFailure,
} from "./mcp-process";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;
type ToolName = "ctx_doctor" | "ctx_stats";
type FailureReport = Extract<CommandReport, { state: "unavailable" }>;

interface ProbeOptions {
  env: NodeJS.ProcessEnv;
}

/**
 * Panel probes belong to no provider. Without an explicit storage root Context Mode falls back to
 * whichever provider config directory exists, and writes its sidecar and content store there.
 */
function contextModeProbeOptions(env: NodeJS.ProcessEnv = process.env): ProbeOptions {
  const home = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return { env: { CONTEXT_MODE_DIR: join(home, "plugin-data", "context-mode", "probe") } };
}

export interface ContextModeHandlerDependencies {
  now?: () => Date;
  resolveBinary?: (settings: ContextModeSettings) => Promise<BinaryResolution>;
  inspect?: (launch: LaunchDescriptor, options: ProbeOptions) => Promise<McpInspection>;
  callTool?: (
    launch: LaunchDescriptor,
    name: ToolName,
    arguments_: Record<string, never>,
    options: ProbeOptions,
  ) => Promise<string>;
  createAudit?: (
    settings: ContextModeSettings,
    runtime: { path: string; version: string | null },
    dependencies?: IntegrationDependencies,
  ) => Promise<IntegrationAudit>;
}

export interface ContextModeHandlers {
  status(input: ContextModeRefreshInput): Promise<BinaryStatus>;
  doctor(input: ContextModeRefreshInput): Promise<CommandReport>;
  stats(input: ContextModeRefreshInput): Promise<CommandReport>;
  audit(
    input: ContextModeRefreshInput,
    context?: { paseo?: ProviderConfigSource },
  ): Promise<IntegrationAudit>;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

function failureResult(error: unknown, checkedAt: string): FailureReport {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.slice(0, 4_096);
  if (error instanceof ProcessFailure) {
    return { state: "unavailable", code: error.code, message, checkedAt };
  }
  return { state: "unavailable", code: "command-failed", message, checkedAt };
}

export function createContextModeHandlers(
  settingsHandle: SettingsHandle,
  dependencies: ContextModeHandlerDependencies = {},
): ContextModeHandlers {
  const now = dependencies.now ?? (() => new Date());
  const resolveBinary = dependencies.resolveBinary ?? resolveContextModeBinary;
  const inspect = dependencies.inspect ?? inspectContextMode;
  const callTool = dependencies.callTool ?? callContextModeTool;
  const buildAudit = dependencies.createAudit ?? createIntegrationAudit;
  const cache = new Map<string, CacheEntry<BinaryStatus | CommandReport>>();
  const probe = contextModeProbeOptions();

  async function settingsAndBinary(): Promise<
    | {
        state: "ready";
        settings: ContextModeSettings;
        binary: Extract<BinaryResolution, { state: "found" }>;
      }
    | { state: "unavailable"; report: FailureReport }
  > {
    const checkedAt = now().toISOString();
    try {
      const settings = await settingsHandle.read();
      if (settings.status !== "ready") {
        return {
          state: "unavailable",
          report: {
            state: "unavailable",
            code: "invalid-settings",
            message: `Context Mode settings are invalid: ${settings.error}`.slice(0, 4_096),
            checkedAt,
          },
        };
      }
      const binary = await resolveBinary(settings.values);
      if (binary.state === "missing") {
        return {
          state: "unavailable",
          report: {
            state: "unavailable",
            code: binary.code,
            message: binary.message.slice(0, 4_096),
            checkedAt,
          },
        };
      }
      return { state: "ready", settings: settings.values, binary };
    } catch (error) {
      return {
        state: "unavailable",
        report: {
          state: "unavailable",
          code: "invalid-settings",
          message: `Could not read Context Mode settings: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 4_096),
          checkedAt,
        },
      };
    }
  }

  async function cached<T extends BinaryStatus | CommandReport>(
    key: string,
    ttlMs: number,
    fresh: boolean,
    load: () => Promise<T>,
  ): Promise<T> {
    const timestamp = now().getTime();
    const existing = cache.get(key) as CacheEntry<T> | undefined;
    if (!fresh && existing && existing.expiresAt > timestamp) return existing.value;
    const value = load();
    cache.set(key, { expiresAt: timestamp + ttlMs, value });
    const result = await value;
    if (result.state === "unavailable" && result.code !== "not-installed") cache.delete(key);
    return result;
  }

  async function status({ fresh }: ContextModeRefreshInput): Promise<BinaryStatus> {
    const resolved = await settingsAndBinary();
    if (resolved.state === "unavailable") return resolved.report;
    const cacheKey = `status:${resolved.binary.source}:${resolved.binary.path}`;
    return cached(cacheKey, 10_000, fresh, async () => {
      const checkedAt = now().toISOString();
      try {
        const inspection = await inspect(resolved.binary.launch, probe);
        return {
          state: "ready",
          binaryPath: resolved.binary.path,
          source: resolved.binary.source,
          version: inspection.version,
          supportsDoctor: inspection.tools.includes("ctx_doctor"),
          supportsStats: inspection.tools.includes("ctx_stats"),
          checkedAt,
        };
      } catch (error) {
        return failureResult(error, checkedAt);
      }
    });
  }

  async function report(name: ToolName, ttlMs: number, fresh: boolean): Promise<CommandReport> {
    const resolved = await settingsAndBinary();
    if (resolved.state === "unavailable") return resolved.report;
    return cached(`${name}:${resolved.binary.path}`, ttlMs, fresh, async () => {
      const checkedAt = now().toISOString();
      try {
        return {
          state: "ready",
          binaryPath: resolved.binary.path,
          output: await callTool(resolved.binary.launch, name, {}, probe),
          checkedAt,
        };
      } catch (error) {
        return failureResult(error, checkedAt);
      }
    });
  }

  async function audit(
    _input: ContextModeRefreshInput,
    context?: { paseo?: ProviderConfigSource },
  ): Promise<IntegrationAudit> {
    const resolved = await settingsAndBinary();
    if (resolved.state === "unavailable") {
      return {
        runtimePath: "",
        runtimeVersion: null,
        injectionEnabled: false,
        providers: [],
        checkedAt: resolved.report.checkedAt,
      };
    }
    const inspection = await inspect(resolved.binary.launch, probe).catch(() => ({
      version: null,
      tools: [],
    }));
    return buildAudit(
      resolved.settings,
      { path: resolved.binary.path, version: inspection.version },
      { providers: await readProviderOverrides(context?.paseo) },
    );
  }

  return {
    status,
    doctor: ({ fresh }) => report("ctx_doctor", 10_000, fresh),
    stats: ({ fresh }) => report("ctx_stats", 5_000, fresh),
    audit,
  };
}
