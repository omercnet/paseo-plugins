import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import type {
  OmpLspDiagnostics,
  OmpMcpDiagnostics,
  OmpProcessDiagnostics,
  OmpProviderHealth,
  OmpVersion,
  OmpVersionStatus,
  PathState,
} from "../shared/provider-diagnostics";

export type ProviderHealthTone = "ok" | "warning" | "danger" | "muted";

const VERSION_STATUS_LABELS: Record<OmpVersionStatus, string> = {
  ok: "Installed",
  "not-found": "Not installed",
  unrunnable: "Found but could not run",
  timeout: "Version check timed out",
  "probe-failed": "Version check failed",
  malformed: "Unrecognized version output",
};

const VERSION_STATUS_TONES: Record<OmpVersionStatus, ProviderHealthTone> = {
  ok: "ok",
  "not-found": "danger",
  unrunnable: "danger",
  timeout: "warning",
  "probe-failed": "warning",
  malformed: "warning",
};

export function formatOmpVersion(version: OmpVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

export interface BinaryHealthSummary {
  label: string;
  tone: ProviderHealthTone;
}

/** Combines version status and the parsed version into one display-ready label and tone. */
export function summarizeBinaryHealth(binary: OmpProviderHealth["binary"]): BinaryHealthSummary {
  const label =
    binary.versionStatus === "ok" && binary.version
      ? `${VERSION_STATUS_LABELS.ok} (${formatOmpVersion(binary.version)})`
      : VERSION_STATUS_LABELS[binary.versionStatus];
  return { label, tone: VERSION_STATUS_TONES[binary.versionStatus] };
}

/** Distinguishes "not supported" from "we could not tell" so the UI never overclaims. */
export function summarizeRpcUiSupport(rpcUi: OmpProviderHealth["rpcUi"]): string {
  if (!rpcUi.checked) return "Unknown (omp binary unavailable)";
  if (rpcUi.supported === null) return "Unknown (probe failed, empty, or truncated)";
  return rpcUi.supported ? "Supported" : "Not advertised by this build";
}

export function rpcUiTone(rpcUi: OmpProviderHealth["rpcUi"]): ProviderHealthTone {
  if (!rpcUi.checked || rpcUi.supported === null) return "muted";
  return rpcUi.supported ? "ok" : "muted";
}

export function summarizeLspSupport(lsp: OmpLspDiagnostics): string {
  if (lsp.status === "supported") return "Supported";
  if (lsp.status === "not-advertised") return "Not advertised by this build";
  return "Unknown (probe failed, empty, or truncated)";
}

export function lspTone(lsp: OmpLspDiagnostics): ProviderHealthTone {
  return lsp.status === "supported" ? "ok" : "muted";
}

export function summarizeMcpDiagnostics(mcp: OmpMcpDiagnostics): string {
  if (mcp.status === "configured") {
    const names = mcp.serverNames ?? [];
    if (names.length === 0) return "0 configured";
    return `${mcp.serverCount} configured (${names.join(", ")})`;
  }
  return `${mcp.status === "invalid" ? "Invalid" : "Unavailable"} (${mcp.reason ?? "no detail"})`;
}

export function mcpTone(mcp: OmpMcpDiagnostics): ProviderHealthTone {
  if (mcp.status === "configured") return "ok";
  if (mcp.status === "invalid") return "warning";
  return "muted";
}

export function summarizeProcessDiagnostics(diagnostics: OmpProcessDiagnostics): string {
  if (diagnostics.status === "unavailable") return "No hub run directory found";
  if (diagnostics.status === "unknown") return "Unknown (could not read the hub run directory)";
  const count = diagnostics.trackedCount ?? 0;
  if (diagnostics.status === "partial") return `${count} tracked (partial: some inaccessible)`;
  return `${count} tracked`;
}

export function processTone(diagnostics: OmpProcessDiagnostics): ProviderHealthTone {
  if (diagnostics.status === "unknown") return "warning";
  if (diagnostics.status === "partial") return "warning";
  if (diagnostics.status === "unavailable") return "muted";
  return diagnostics.trackedCount && diagnostics.trackedCount > 0 ? "ok" : "muted";
}

const PATH_STATE_LABELS: Record<PathState, string> = {
  available: "Found",
  missing: "Missing",
  invalid: "Invalid or unreadable",
  "wrong-type": "Wrong type on disk",
};

const PATH_STATE_TONES: Record<PathState, ProviderHealthTone> = {
  available: "ok",
  missing: "danger",
  invalid: "warning",
  "wrong-type": "warning",
};

export interface PathStateSummary {
  label: string;
  tone: ProviderHealthTone;
}

/** Never collapses "invalid"/"wrong-type" into "missing" — each state gets its own label. */
export function summarizePathState(state: PathState): PathStateSummary {
  return { label: PATH_STATE_LABELS[state], tone: PATH_STATE_TONES[state] };
}

/**
 * A null memory backend is ambiguous on its own: the config could be genuinely unset, or simply
 * unavailable/invalid/wrong-type. Only a truly "available" config licenses "Not configured";
 * every other state reports its own unavailability instead of guessing.
 */
export function summarizeMemoryBackend(health: OmpProviderHealth): string {
  if (health.roots.configState !== "available") {
    return `Unknown (config ${PATH_STATE_LABELS[health.roots.configState].toLowerCase()})`;
  }
  return health.memoryBackend ?? "Not configured";
}

export type KnownOmpProviderKind = "bundled" | "canary";

/** Explicit switch, not an object-keyed lookup: a provider id can never be coerced into an
 * inherited `Object.prototype` member (e.g. "constructor", "toString"). */
function knownOmpProviderKind(provider: string): KnownOmpProviderKind | null {
  switch (provider) {
    case "omp":
      return "bundled";
    case "omp-plugin":
      return "canary";
    default:
      return null;
  }
}

export interface KnownOmpProviderSummary {
  id: string;
  label: string;
  kind: KnownOmpProviderKind;
  status: string;
  enabled: boolean;
}

/**
 * Narrows a full provider snapshot down to the two OMP identities this plugin ships (the
 * first-class bundled adapter and this plugin's canary), so an unrelated provider's status or
 * label never reaches the diagnostics section.
 */
export function selectKnownOmpProviders(
  entries: readonly PaseoProviderSnapshotResult["entries"][number][],
): KnownOmpProviderSummary[] {
  return entries.flatMap((entry) => {
    const kind = knownOmpProviderKind(entry.provider);
    if (!kind) return [];
    return [
      {
        id: entry.provider,
        label: entry.label ?? entry.provider,
        kind,
        status: entry.status,
        enabled: entry.enabled ?? true,
      },
    ];
  });
}
