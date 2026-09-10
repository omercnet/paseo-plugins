import type { OmpProviderHealth, OmpVersionStatus } from "../shared/provider-diagnostics";

export type ProviderHealthTone = "ok" | "warning" | "danger" | "muted";

const VERSION_STATUS_LABELS: Record<OmpVersionStatus, string> = {
  ok: "Installed",
  "not-found": "Not installed",
  timeout: "Version check timed out",
  malformed: "Unrecognized version output",
};

const VERSION_STATUS_TONES: Record<OmpVersionStatus, ProviderHealthTone> = {
  ok: "ok",
  "not-found": "danger",
  timeout: "warning",
  malformed: "warning",
};

export interface BinaryHealthSummary {
  label: string;
  tone: ProviderHealthTone;
}

/** Combines version status and parsed version into one display-ready label and severity tone. */
export function summarizeBinaryHealth(binary: OmpProviderHealth["binary"]): BinaryHealthSummary {
  const label =
    binary.versionStatus === "ok" && binary.version
      ? `${VERSION_STATUS_LABELS.ok} (${binary.version})`
      : VERSION_STATUS_LABELS[binary.versionStatus];
  return { label, tone: VERSION_STATUS_TONES[binary.versionStatus] };
}

/** Distinguishes "not supported" from "we could not tell" so the UI never overclaims. */
export function summarizeRpcUiSupport(rpcUi: OmpProviderHealth["rpcUi"]): string {
  if (!rpcUi.checked) return "Unknown (omp binary unavailable)";
  if (rpcUi.supported === null) return "Unknown (probe failed)";
  return rpcUi.supported ? "Supported" : "Not advertised by this build";
}

export type KnownOmpProviderKind = "bundled" | "canary";

const KNOWN_OMP_PROVIDER_KINDS: Record<string, KnownOmpProviderKind> = {
  omp: "bundled",
  "omp-plugin": "canary",
};

export interface ProviderSnapshotEntryLike {
  provider: string;
  status: string;
  enabled?: boolean;
  label?: string;
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
  entries: readonly ProviderSnapshotEntryLike[],
): KnownOmpProviderSummary[] {
  return entries.flatMap((entry) => {
    const kind = KNOWN_OMP_PROVIDER_KINDS[entry.provider];
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
