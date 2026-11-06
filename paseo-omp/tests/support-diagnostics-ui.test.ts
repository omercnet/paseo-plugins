import { describe, expect, test } from "vitest";
import { resolveSurfaceView, surfaceViewsForScope } from "../client/omp-config-views";
import {
  refreshSupportReport,
  supportDiagnosticsViewState,
} from "../client/support-diagnostics-state";
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

  test("explicit refresh forces a new RPC collection and returns its fresh report", async () => {
    const requests: Array<{ force?: boolean; cwd?: string }> = [];
    const reports = [
      { report: "collected_at_utc: 2026-09-19T12:00:00.000Z\nomp.version: 18.2.0\n" },
      { report: "collected_at_utc: 2026-09-19T12:01:00.000Z\nomp.version: 18.3.0\n" },
    ];
    const loadReport = async (input: { force?: boolean; cwd?: string }) => {
      requests.push(input);
      const report = reports[requests.length - 1];
      if (!report) throw new Error("unexpected request");
      return report;
    };

    const initial = await loadReport({ cwd: "/workspace" });
    const refreshed = await refreshSupportReport(loadReport, { cwd: "/workspace" });

    expect(requests).toEqual([{ cwd: "/workspace" }, { cwd: "/workspace", force: true }]);
    expect(initial.report).toContain("12:00:00.000Z");
    expect(refreshed.report).toContain("12:01:00.000Z");
    expect(refreshed.report).toContain("omp.version: 18.3.0");
  });

  test("links directly to the dedicated template without report contents", () => {
    expect(OMP_SUPPORT_ISSUE_URL).toBe(
      "https://github.com/omercnet/paseo-plugins/issues/new?template=omp-plugin.yml",
    );
    expect(OMP_SUPPORT_ISSUE_URL).not.toContain("body=");
  });

  test("adds Help without changing existing global and workspace tabs", () => {
    expect(
      surfaceViewsForScope({ workspaceScoped: false, pluginProviderEnabled: true }).map(
        (view) => view.id,
      ),
    ).toEqual([
      "overview",
      "accounts",
      "mcps",
      "plugin",
      "plugins",
      "rules",
      "skills",
      "extensions",
      "composer",
      "configuration",
      "diagnostics",
      "help",
    ]);
    expect(
      surfaceViewsForScope({ workspaceScoped: true, pluginProviderEnabled: true }).map(
        (view) => view.id,
      ),
    ).toEqual([
      "overview",
      "plugin",
      "plugins",
      "rules",
      "skills",
      "extensions",
      "security",
      "configuration",
      "diagnostics",
      "help",
    ]);
  });

  test("hides the Plugin provider tab, and only it, while the plugin provider is off", () => {
    for (const workspaceScoped of [false, true]) {
      const on = surfaceViewsForScope({ workspaceScoped, pluginProviderEnabled: true });
      const off = surfaceViewsForScope({ workspaceScoped, pluginProviderEnabled: false });
      expect(on.find((view) => view.id === "plugin")?.label).toBe("Plugin provider");
      expect(off).toEqual(on.filter((view) => view.id !== "plugin"));
    }
  });

  test("a selected view the scope hides falls back to Overview, a visible one is kept", () => {
    const off = surfaceViewsForScope({ workspaceScoped: false, pluginProviderEnabled: false });
    expect(resolveSurfaceView(off, "plugin")).toBe("overview");
    expect(resolveSurfaceView(off, "rules")).toBe("rules");
    const on = surfaceViewsForScope({ workspaceScoped: false, pluginProviderEnabled: true });
    expect(resolveSurfaceView(on, "plugin")).toBe("plugin");
  });
});
