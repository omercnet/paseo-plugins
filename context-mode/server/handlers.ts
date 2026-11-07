import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { BinaryStatus, ContextModeRefreshInput, IntegrationAudit } from "../shared/contracts";
import { type ContextModePlatform, PANEL_PLATFORM } from "../shared/providers";
import type { ContextModeSettings, contextModeSettings } from "../shared/settings";
import { type BinaryResolution, type LaunchDescriptor, resolveContextModeBinary } from "./binary";
import {
  createIntegrationAudit,
  type ProviderConfigSource,
  readProviderOverrides,
} from "./integration";
import {
  type ContextModeProcessOptions,
  inspectContextMode,
  type McpInspection,
  ProcessFailure,
} from "./mcp-process";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;
type FailureReport = Extract<BinaryStatus, { state: "unavailable" }>;

/**
 * Panel probes belong to no project. Context Mode records every tool call (doctor and stats
 * included) in the store of its cwd, so probes run in a plugin-owned data dir and cwd to keep
 * the user's stats clean.
 */
export async function contextModeProbeOptions(
  platform: ContextModePlatform = PANEL_PLATFORM,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Required<ContextModeProcessOptions>> {
  const home = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  const dataDir = join(home, "plugin-data", "context-mode", "probe");
  const cwd = join(dataDir, "cwd");
  await mkdir(cwd, { recursive: true });
  return { platform, cwd, dataDir };
}

export interface ContextModeHandlerDependencies {
  now?: () => Date;
  resolveBinary?: typeof resolveContextModeBinary;
  probeOptions?: () => Promise<ContextModeProcessOptions>;
  inspect?: (
    launch: LaunchDescriptor,
    options: ContextModeProcessOptions,
  ) => Promise<McpInspection>;
  createAudit?: typeof createIntegrationAudit;
}

type HandlerContext = { paseo?: ProviderConfigSource };

export interface ContextModeHandlers {
  status(input: ContextModeRefreshInput, context?: HandlerContext): Promise<BinaryStatus>;
  audit(input: Record<string, never>, context?: HandlerContext): Promise<IntegrationAudit>;
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
  const inspect =
    dependencies.inspect ??
    ((launch: LaunchDescriptor, options: ContextModeProcessOptions) =>
      inspectContextMode(launch, {}, options));
  const probeOptions = dependencies.probeOptions ?? (() => contextModeProbeOptions());
  const buildAudit = dependencies.createAudit ?? createIntegrationAudit;
  const cache = new Map<string, CacheEntry<BinaryStatus>>();

  async function settingsAndBinary(paseo: ProviderConfigSource | undefined): Promise<
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
      const binary = await resolveBinary(settings.values, { paseo });
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

  async function cached(
    key: string,
    ttlMs: number,
    fresh: boolean,
    load: () => Promise<BinaryStatus>,
  ): Promise<BinaryStatus> {
    const timestamp = now().getTime();
    const existing = cache.get(key);
    if (!fresh && existing && existing.expiresAt > timestamp) return existing.value;
    const value = load();
    cache.set(key, { expiresAt: timestamp + ttlMs, value });
    const result = await value;
    if (result.state === "unavailable" && result.code !== "not-installed") cache.delete(key);
    return result;
  }

  async function status(
    { fresh }: ContextModeRefreshInput,
    context?: HandlerContext,
  ): Promise<BinaryStatus> {
    const resolved = await settingsAndBinary(context?.paseo);
    if (resolved.state === "unavailable") return resolved.report;
    const cacheKey = `status:${resolved.binary.source}:${resolved.binary.path}`;
    return cached(cacheKey, 10_000, fresh, async () => {
      const checkedAt = now().toISOString();
      try {
        const inspection = await inspect(resolved.binary.launch, await probeOptions());
        return {
          state: "ready",
          binaryPath: resolved.binary.path,
          source: resolved.binary.source,
          version: inspection.version,
          checkedAt,
        };
      } catch (error) {
        return failureResult(error, checkedAt);
      }
    });
  }

  /** Provider activation only: no Context Mode process is started, so polling it is cheap. */
  async function audit(context?: HandlerContext): Promise<IntegrationAudit> {
    const resolved = await settingsAndBinary(context?.paseo);
    if (resolved.state === "unavailable") return { providers: [] };
    return buildAudit(resolved.settings, {
      providers: await readProviderOverrides(context?.paseo),
    });
  }

  return { status, audit: (_input, context) => audit(context) };
}
