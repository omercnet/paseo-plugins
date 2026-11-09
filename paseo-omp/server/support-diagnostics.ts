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
import { PASEO_OMP_PACKAGE_VERSION } from "./package-version";
import type {
  OmpProtocolViolationCollector,
  OmpProtocolViolationSummary,
} from "./protocol-violation-diagnostics";
import { resolveGetOmpProviderHealth } from "./provider-diagnostics";

const PACKAGE_VERSION = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/u)
  .max(64);
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

const EXPECTATION_LABELS: Record<
  NonNullable<OmpProtocolViolationSummary["latestExpected"]>,
  string
> = {
  "complete-json-line": "newline-terminated JSON frame",
  "within-byte-limit": "byte length within negotiated limit",
  "valid-json": "valid UTF-8 JSON",
  "object-envelope": "JSON object envelope",
  "bounded-frame-type": "frame type string up to 64 bytes",
  "valid-response-frame": "valid response envelope",
  "valid-ready-frame": "valid ready handshake",
  "single-ready-frame": "one ready handshake",
  "valid-event-frame": "valid event payload",
  "valid-event-state-transition": "event valid for current stream state",
  "valid-message-event": "valid message event payload",
  "valid-tool-event": "valid tool event payload",
  "valid-lifecycle-event": "valid lifecycle event payload",
  "valid-subagent-event": "valid subagent event payload",
  "valid-configuration-event": "valid configuration event payload",
  "valid-extension-ui-event": "valid extension UI event payload",
  "known-event-type": "supported event type",
  "notice-level-enum": "info, warning, or error",
  "notice-message-string": "bounded string",
  "valid-chunk-frame": "valid chunk metadata",
  "valid-base64-chunk": "valid base64 chunk",
  "first-chunk-index-zero": "first chunk index 0",
  "contiguous-chunk-sequence": "contiguous chunk sequence",
  "declared-chunk-byte-count": "decoded bytes equal declared byte length",
  "chunk-before-deadline": "next chunk before timeout",
  "no-interleaved-frame": "no interleaved frame during chunk assembly",
  "no-remote-frame-error": "no remote frame error",
};

function finiteCount(value: number | null | undefined, maximum = Number.MAX_SAFE_INTEGER): string {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? String(Math.min(value, maximum))
    : "unknown";
}

function usefulReportLine(line: string): boolean {
  return !line.endsWith(": unavailable") && !line.endsWith(": unknown") && !line.endsWith(": 0");
}

function formatVersion(version: OmpVersion | null): string {
  if (!version) return "unavailable";
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

function formatHealth(health: OmpProviderHealth | null): string[] {
  if (!health) return ["collection.provider_health: failed"];
  return [
    "collection.provider_health: complete",
    `omp.installed: ${health.binary.installed}`,
    `omp.version: ${formatVersion(health.binary.version)}`,
    `omp.version_probe: ${health.binary.versionStatus}`,
    `omp.process_cleanup: ${health.binary.processCleanupFailed ? "failed" : "ok"}`,
    `compatibility.rpc_ui: ${!health.rpcUi.checked || health.rpcUi.supported === null ? "unknown" : health.rpcUi.supported ? "supported" : "not-advertised"}`,
    `compatibility.lsp: ${health.lsp.status}`,
    `mcp.status: ${health.mcp.status}`,
    `mcp.server_count: ${finiteCount(health.mcp.serverCount, 4_096)}`,
    `mcp.reason: ${health.mcp.reason ?? "unknown"}`,
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
    "selection.applies_to: provider-health",
    "diagnostic_counters.scope: plugin-process-all-stores-workspaces",
    "diagnostic_counters.lifetime: since-plugin-load",
    ...formatHealth(data.health),
  ];
  for (const violation of data.violations) {
    if (violation.occurrenceCount === 0) continue;
    const prefix = `protocol.${violation.category}`;
    lines.push(
      `${prefix}.occurrence_count: ${finiteCount(violation.occurrenceCount)}`,
      `${prefix}.batch_count: ${finiteCount(violation.batchCount)}`,
      `${prefix}.max_batch_count: ${finiteCount(violation.maxOccurrenceCount)}`,
    );
    for (const [reason, count] of Object.entries(violation.reasonCounts)) {
      if (count > 0) lines.push(`${prefix}.reason.${reason}.occurrence_count: ${count}`);
    }
    lines.push(
      `${prefix}.latest_reason: ${violation.latestReason ?? "unknown"}`,
      `${prefix}.latest_phase: ${violation.latestPhase ?? "unknown"}`,
      `${prefix}.latest_event_type: ${violation.latestEventType ?? "unknown"}`,
      `${prefix}.first_at_utc: ${violation.firstAt ?? "unavailable"}`,
      `${prefix}.last_at_utc: ${violation.lastAt ?? "unavailable"}`,
      `${prefix}.latest_frame_type: ${violation.latestFrameType ?? "unknown"}`,
      `${prefix}.latest_field: ${violation.latestField ?? "unknown"}`,
      `${prefix}.latest_expected: ${violation.latestExpected ? EXPECTATION_LABELS[violation.latestExpected] : "unknown"}`,
      `${prefix}.latest_actual_type: ${violation.latestActualType ?? "unknown"}`,
      `${prefix}.max_byte_size: ${finiteCount(violation.maxByteSize)}`,
      `${prefix}.latest_limit_bytes: ${finiteCount(violation.latestLimitBytes)}`,
    );
  }
  for (const failure of data.operationalFailures) {
    if (failure.occurrenceCount === 0) continue;
    const prefix = `operational.${failure.category}.${failure.stage}`;
    lines.push(
      `${prefix}.occurrence_count: ${finiteCount(failure.occurrenceCount)}`,
      `${prefix}.first_at_utc: ${failure.firstAt ?? "unavailable"}`,
      `${prefix}.last_at_utc: ${failure.lastAt ?? "unavailable"}`,
    );
  }
  const report = `${lines.filter(usefulReportLine).join("\n")}\n`;
  if (supportReportByteLength(report) > OMP_SUPPORT_REPORT_MAX_BYTES) {
    return [
      "OMP support diagnostics",
      `schema_version: ${OMP_SUPPORT_REPORT_SCHEMA_VERSION}`,
      `collected_at_utc: ${data.collectedAt}`,
      "collection_status: failed",
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
      (dependencies.loadPluginVersion ?? (() => Promise.resolve(PASEO_OMP_PACKAGE_VERSION)))(),
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
