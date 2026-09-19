import type { OmpStore } from "../shared/omp-store";

type SupportReportInput = { store?: OmpStore; cwd?: string; force?: boolean };
type SupportReportOutput = { report: string };

export async function refreshSupportReport(
  loadReport: (input: SupportReportInput) => Promise<SupportReportOutput>,
  input: Omit<SupportReportInput, "force">,
): Promise<SupportReportOutput> {
  return await loadReport({ ...input, force: true });
}

export type SupportReportCopyState = "idle" | "copying" | "copied" | "error";

export interface SupportDiagnosticsViewState {
  refreshLabel: string;
  copyLabel: string;
  copyDisabled: boolean;
  loadingMessage: string | null;
  reportError: string | null;
  copyFeedback: string | null;
}

/** Maps request and copy state to the exact accessible feedback rendered by the Help tab. */
export function supportDiagnosticsViewState(input: {
  loading: boolean;
  refreshing: boolean;
  hasReport: boolean;
  reportFailed: boolean;
  copyState: SupportReportCopyState;
}): SupportDiagnosticsViewState {
  return {
    refreshLabel: input.refreshing ? "Refreshing…" : "Refresh",
    copyLabel: input.copyState === "copying" ? "Copying…" : "Copy report",
    copyDisabled: !input.hasReport || input.copyState === "copying",
    loadingMessage: input.loading ? "Collecting OMP diagnostics…" : null,
    reportError: input.reportFailed ? "Could not collect OMP diagnostics." : null,
    copyFeedback:
      input.copyState === "copied"
        ? "Report copied."
        : input.copyState === "error"
          ? "Could not copy. Select the report text and copy it manually."
          : null,
  };
}
