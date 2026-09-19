import { describe, expect, test } from "vitest";
import { surfaceViewsForScope } from "../client/omp-config-views";
import { supportDiagnosticsViewState } from "../client/support-diagnostics-state";
import { OMP_SUPPORT_ISSUE_URL } from "../shared/support-diagnostics";

describe("OMP Help surface state", () => {
  test("shows clear loading, refresh, copy success, copy error, and report error feedback", () => {
    expect(
      supportDiagnosticsViewState({
        loading: true,
        refreshing: false,
        hasReport: false,
        reportFailed: false,
        copyState: "idle",
      }),
    ).toMatchObject({
      refreshLabel: "Refresh",
      copyLabel: "Copy report",
      copyDisabled: true,
      loadingMessage: "Collecting OMP diagnostics…",
    });
    expect(
      supportDiagnosticsViewState({
        loading: false,
        refreshing: true,
        hasReport: true,
        reportFailed: false,
        copyState: "copying",
      }),
    ).toMatchObject({ refreshLabel: "Refreshing…", copyLabel: "Copying…", copyDisabled: true });
    expect(
      supportDiagnosticsViewState({
        loading: false,
        refreshing: false,
        hasReport: true,
        reportFailed: false,
        copyState: "copied",
      }).copyFeedback,
    ).toBe("Report copied.");
    expect(
      supportDiagnosticsViewState({
        loading: false,
        refreshing: false,
        hasReport: true,
        reportFailed: false,
        copyState: "error",
      }).copyFeedback,
    ).toContain("Select the report text");
    expect(
      supportDiagnosticsViewState({
        loading: false,
        refreshing: false,
        hasReport: false,
        reportFailed: true,
        copyState: "idle",
      }).reportError,
    ).toBe("Could not collect OMP diagnostics.");
  });

  test("links directly to the dedicated template without report contents", () => {
    expect(OMP_SUPPORT_ISSUE_URL).toBe(
      "https://github.com/omercnet/paseo-plugins/issues/new?template=omp-plugin.yml",
    );
    expect(OMP_SUPPORT_ISSUE_URL).not.toContain("body=");
  });

  test("adds Help without changing existing global and workspace tabs", () => {
    expect(surfaceViewsForScope(false).map((view) => view.id)).toEqual([
      "overview",
      "plugin",
      "plugins",
      "composer",
      "configuration",
      "diagnostics",
      "help",
    ]);
    expect(surfaceViewsForScope(true).map((view) => view.id)).toEqual([
      "overview",
      "plugin",
      "plugins",
      "configuration",
      "diagnostics",
      "help",
    ]);
  });
});
