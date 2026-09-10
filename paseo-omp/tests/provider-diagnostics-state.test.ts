import { describe, expect, test } from "bun:test";
import {
  selectKnownOmpProviders,
  summarizeBinaryHealth,
  summarizeRpcUiSupport,
} from "../client/provider-diagnostics-state";
import type { OmpProviderHealth } from "../shared/provider-diagnostics";

function binary(overrides: Partial<OmpProviderHealth["binary"]>): OmpProviderHealth["binary"] {
  return {
    installed: true,
    resolvedPath: "/usr/local/bin/omp",
    version: "18.1.15",
    versionStatus: "ok",
    ...overrides,
  };
}

describe("summarizeBinaryHealth", () => {
  test("includes the parsed version in the label when the probe succeeds", () => {
    expect(summarizeBinaryHealth(binary({}))).toEqual({
      label: "Installed (18.1.15)",
      tone: "ok",
    });
  });

  test("reports a danger tone when the binary could not be found at all", () => {
    expect(
      summarizeBinaryHealth(
        binary({ installed: false, resolvedPath: null, version: null, versionStatus: "not-found" }),
      ),
    ).toEqual({ label: "Not installed", tone: "danger" });
  });

  test("reports a warning tone for a timed-out version probe", () => {
    expect(summarizeBinaryHealth(binary({ version: null, versionStatus: "timeout" }))).toEqual({
      label: "Version check timed out",
      tone: "warning",
    });
  });

  test("reports a warning tone for an unparsable version response", () => {
    expect(summarizeBinaryHealth(binary({ version: null, versionStatus: "malformed" }))).toEqual({
      label: "Unrecognized version output",
      tone: "warning",
    });
  });
});

describe("summarizeRpcUiSupport", () => {
  test("distinguishes an unchecked probe from a checked-but-unsupported one", () => {
    expect(summarizeRpcUiSupport({ checked: false, supported: null })).toBe(
      "Unknown (omp binary unavailable)",
    );
    expect(summarizeRpcUiSupport({ checked: true, supported: null })).toBe(
      "Unknown (probe failed)",
    );
    expect(summarizeRpcUiSupport({ checked: true, supported: false })).toBe(
      "Not advertised by this build",
    );
    expect(summarizeRpcUiSupport({ checked: true, supported: true })).toBe("Supported");
  });
});

describe("selectKnownOmpProviders", () => {
  test("keeps only the bundled and canary OMP identities, dropping unrelated providers", () => {
    const result = selectKnownOmpProviders([
      { provider: "omp", status: "unavailable", enabled: false, label: "OMP" },
      { provider: "omp-plugin", status: "ready", enabled: true, label: "OMP (Plugin Preview)" },
      { provider: "claude", status: "ready", enabled: true, label: "Claude" },
    ]);

    expect(result).toEqual([
      { id: "omp", label: "OMP", kind: "bundled", status: "unavailable", enabled: false },
      {
        id: "omp-plugin",
        label: "OMP (Plugin Preview)",
        kind: "canary",
        status: "ready",
        enabled: true,
      },
    ]);
  });

  test("defaults enabled to true and falls back to the provider id as a label", () => {
    const result = selectKnownOmpProviders([{ provider: "omp-plugin", status: "loading" }]);

    expect(result).toEqual([
      { id: "omp-plugin", label: "omp-plugin", kind: "canary", status: "loading", enabled: true },
    ]);
  });

  test("returns an empty list when no known OMP provider is present", () => {
    expect(selectKnownOmpProviders([{ provider: "codex", status: "ready" }])).toEqual([]);
  });
});
