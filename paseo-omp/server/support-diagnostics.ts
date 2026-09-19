import { arch, platform } from "node:os";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { OmpProviderHealth, OmpVersion } from "../shared/provider-diagnostics";
import {
  type getOmpSupportReport,
  OMP_SUPPORT_REPORT_MAX_BYTES,
  OMP_SUPPORT_REPORT_SCHEMA_VERSION,
  supportReportByteLength,
} from "../shared/support-diagnostics";
import type {
  OmpOperationalFailureCollector,
  OmpOperationalFailureSummary,
} from "./operational-failure-diagnostics";
import type {
  OmpProtocolViolationCollector,
  OmpProtocolViolationSummary,
} from "./protocol-violation-diagnostics";
import { resolveGetOmpProviderHealth } from "./provider-diagnostics";

const PACKAGE_VERSION = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/u)
  .max(64);
const PASEO_OMP_BUILD_VERSION = "0.3.0";
const NODE_VERSION = z
  .string()
  .regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/u)
  .max(64);
const KNOWN_PLATFORMS: Record<string, true> = {
  aix: true,
  android: true,
  darwin: true,
  freebsd: true,
  linux: true,
  openbsd: true,
  sunos: true,
  win32: true,
};
const KNOWN_ARCHITECTURES: Record<string, true> = {
  arm: true,
  arm64: true,
  ia32: true,
  loong64: true,
  mips: true,
  mipsel: true,
  ppc: true,
  ppc64: true,
  riscv64: true,
  s390: true,
  s390x: true,
  x64: true,
};

export interface OmpSupportReportData {
  collectedAt: string;
  pluginVersion: string;
  platform: string;
  architecture: string;
  nodeVersion: string;
  scope: "global" | "workspace";
  store: "default" | "named-profile" | "custom-directory";
  health: OmpProviderHealth | null;
  violations: readonly OmpProtocolViolationSummary[];
  operationalFailures: readonly OmpOperationalFailureSummary[];
}

function finiteCount(value: number | null | undefined, maximum = Number.MAX_SAFE_INTEGER): string {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? String(Math.min(value, maximum))
    : "unknown";
}

function formatVersion(version: OmpVersion | null): string {
  if (!version) return "unavailable";
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

function formatHealth(health: OmpProviderHealth | null): string[] {
  if (!health) {
    return [
      "provider_health.status: unavailable",
      "omp.installed: unknown",
      "omp.version: unavailable",
      "omp.version_probe: unavailable",
      "omp.process_cleanup: unknown",
      "compatibility.rpc_ui: unknown",
      "compatibility.lsp: unknown",
      "mcp.status: unknown",
      "mcp.server_count: unknown",
      "storage.agent_root: unknown",
      "storage.config: unknown",
      "storage.session_root: unknown",
      "storage.agent_database: unknown",
      "storage.history_database: unknown",
      "storage.memory_backend: unknown",
      "hub.status: unknown",
      "hub.tracked_count: unknown",
      "hub.active_count: unknown",
      "hub.historical_count: unknown",
      "hub.unknown_count: unknown",
    ];
  }
  return [
    "provider_health.status: available",
    `omp.installed: ${health.binary.installed}`,
    `omp.version: ${formatVersion(health.binary.version)}`,
    `omp.version_probe: ${health.binary.versionStatus}`,
    `omp.process_cleanup: ${health.binary.processCleanupFailed ? "failed" : "ok"}`,
    `compatibility.rpc_ui: ${!health.rpcUi.checked || health.rpcUi.supported === null ? "unknown" : health.rpcUi.supported ? "supported" : "not-advertised"}`,
    `compatibility.lsp: ${health.lsp.status}`,
    `mcp.status: ${health.mcp.status}`,
    `mcp.server_count: ${finiteCount(health.mcp.serverCount, 4_096)}`,
    `storage.agent_root: ${health.roots.agentRootState}`,
    `storage.config: ${health.roots.configState}`,
    `storage.session_root: ${health.roots.sessionRootState}`,
    `storage.agent_database: ${health.databases.agentDbState}`,
    `storage.history_database: ${health.databases.historyDbState}`,
    `storage.memory_backend: ${health.memoryBackend ?? "unknown"}`,
    `hub.status: ${health.process.status}`,
    `hub.tracked_count: ${finiteCount(health.process.trackedCount, 100_000)}`,
    `hub.active_count: ${finiteCount(health.process.activeCount, 100_000)}`,
    `hub.historical_count: ${finiteCount(health.process.historicalCount, 100_000)}`,
    `hub.unknown_count: ${finiteCount(health.process.unknownCount, 100_000)}`,
  ];
}

/** Stable line ordering is part of the pasted support-report contract. */
export function formatOmpSupportReport(data: OmpSupportReportData): string {
  const lines = [
    "OMP support diagnostics",
    `schema_version: ${OMP_SUPPORT_REPORT_SCHEMA_VERSION}`,
    `collected_at_utc: ${data.collectedAt}`,
    `paseo_omp.version: ${data.pluginVersion}`,
    `runtime.platform: ${data.platform}`,
    `runtime.architecture: ${data.architecture}`,
    `runtime.node: ${data.nodeVersion}`,
    `selection.scope: ${data.scope}`,
    `selection.store: ${data.store}`,
    ...formatHealth(data.health),
  ];
  for (const violation of data.violations) {
    const prefix = `protocol.${violation.category}`;
    lines.push(
      `${prefix}.occurrence_count: ${finiteCount(violation.occurrenceCount)}`,
      `${prefix}.batch_count: ${finiteCount(violation.batchCount)}`,
      `${prefix}.max_batch_count: ${finiteCount(violation.maxOccurrenceCount)}`,
      `${prefix}.first_at_utc: ${violation.firstAt ?? "unavailable"}`,
      `${prefix}.last_at_utc: ${violation.lastAt ?? "unavailable"}`,
      `${prefix}.latest_frame_type: ${violation.latestFrameType ?? "unknown"}`,
      `${prefix}.max_byte_size: ${finiteCount(violation.maxByteSize)}`,
    );
  }
  for (const failure of data.operationalFailures) {
    const prefix = `operational.${failure.category}.${failure.stage}`;
    lines.push(
      `${prefix}.occurrence_count: ${finiteCount(failure.occurrenceCount)}`,
      `${prefix}.first_at_utc: ${failure.firstAt ?? "unavailable"}`,
      `${prefix}.last_at_utc: ${failure.lastAt ?? "unavailable"}`,
    );
  }
  const report = `${lines.join("\n")}\n`;
  if (supportReportByteLength(report) > OMP_SUPPORT_REPORT_MAX_BYTES) {
    return [
      "OMP support diagnostics",
      `schema_version: ${OMP_SUPPORT_REPORT_SCHEMA_VERSION}`,
      `collected_at_utc: ${data.collectedAt}`,
      "collection_status: unavailable",
      "collection_error: report-size-limit",
      "",
    ].join("\n");
  }
  return report;
}

function collectedAt(now: () => Date): string {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function resolveGetOmpSupportReport(
  input: RpcInput<typeof getOmpSupportReport>,
  violations: OmpProtocolViolationCollector,
  operationalFailures: OmpOperationalFailureCollector,
  dependencies: {
    loadHealth?: typeof resolveGetOmpProviderHealth;
    loadPluginVersion?: () => Promise<string>;
    now?: () => Date;
    platform?: () => string;
    architecture?: () => string;
    nodeVersion?: string;
  } = {},
): Promise<{ report: string }> {
  const timestamp = collectedAt(dependencies.now ?? (() => new Date()));
  try {
    const [healthResult, pluginVersionResult] = await Promise.allSettled([
      (dependencies.loadHealth ?? resolveGetOmpProviderHealth)(input),
      (dependencies.loadPluginVersion ?? (() => Promise.resolve(PASEO_OMP_BUILD_VERSION)))(),
    ]);
    const platformValue = (dependencies.platform ?? platform)();
    const architectureValue = (dependencies.architecture ?? arch)();
    const nodeVersionValue = dependencies.nodeVersion ?? process.version;
    return {
      report: formatOmpSupportReport({
        collectedAt: timestamp,
        pluginVersion:
          pluginVersionResult.status === "fulfilled" &&
          PACKAGE_VERSION.safeParse(pluginVersionResult.value).success
            ? pluginVersionResult.value
            : "unavailable",
        platform: KNOWN_PLATFORMS[platformValue] ? platformValue : "unknown",
        architecture: KNOWN_ARCHITECTURES[architectureValue] ? architectureValue : "unknown",
        nodeVersion: NODE_VERSION.safeParse(nodeVersionValue).success
          ? nodeVersionValue
          : "unavailable",
        scope: input.cwd ? "workspace" : "global",
        store: input.store?.profile
          ? "named-profile"
          : input.store?.agentDir
            ? "custom-directory"
            : "default",
        health: healthResult.status === "fulfilled" ? healthResult.value : null,
        violations: violations.snapshot(),
        operationalFailures: operationalFailures.snapshot(),
      }),
    };
  } catch {
    return {
      report: formatOmpSupportReport({
        collectedAt: timestamp,
        pluginVersion: "unavailable",
        platform: "unknown",
        architecture: "unknown",
        nodeVersion: "unavailable",
        scope: input.cwd ? "workspace" : "global",
        store: input.store?.profile
          ? "named-profile"
          : input.store?.agentDir
            ? "custom-directory"
            : "default",
        health: null,
        violations: violations.snapshot(),
        operationalFailures: operationalFailures.snapshot(),
      }),
    };
  }
}
