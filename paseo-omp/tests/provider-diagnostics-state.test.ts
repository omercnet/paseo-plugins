import { describe, expect, test } from "bun:test";
import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import {
  formatOmpVersion,
  lspTone,
  mcpTone,
  processTone,
  rpcUiTone,
  selectKnownOmpProviders,
  summarizeBinaryHealth,
  summarizeLspSupport,
  summarizeMcpDiagnostics,
  summarizeMemoryBackend,
  summarizePathState,
  summarizeProcessDiagnostics,
  summarizeRpcUiSupport,
} from "../client/provider-diagnostics-state";
import type { OmpProviderHealth } from "../shared/provider-diagnostics";

function health(overrides: Partial<OmpProviderHealth> = {}): OmpProviderHealth {
  return {
    binary: {
      installed: true,
      resolvedPath: "/usr/local/bin/omp",
      version: { major: 18, minor: 1, patch: 15, prerelease: null },
      versionStatus: "ok",
      processCleanupFailed: false,
    },
    rpcUi: { checked: true, supported: true },
    lsp: { status: "supported" },
    mcp: { status: "unavailable", serverCount: null, serverNames: null, reason: "No mcp.json." },
    process: { status: "ok", trackedCount: 2 },
    roots: {
      agentRoot: "/home/test/.omp/agent",
      agentRootState: "available",
      configPath: "/home/test/.omp/agent/config.yml",
      configState: "available",
      sessionRoot: "/home/test/.omp/agent/sessions",
      sessionRootState: "available",
    },
    databases: { agentDbState: "available", historyDbState: "available" },
    memoryBackend: "mnemopi",
    checkedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("version health summaries", () => {
  test("formats normalized versions and includes them on successful probes", () => {
    const version = { major: 18, minor: 1, patch: 15, prerelease: "beta.1" };

    expect(formatOmpVersion(version)).toBe("18.1.15-beta.1");
    expect(
      summarizeBinaryHealth({
        installed: true,
        resolvedPath: "/usr/local/bin/omp",
        version,
        versionStatus: "ok",
        processCleanupFailed: false,
      }),
    ).toEqual({ label: "Installed (18.1.15-beta.1)", tone: "ok" });
  });

  test("distinguishes not-found, unrunnable, timeout, failed, and malformed outcomes", () => {
    const base = health().binary;
    const cases = [
      ["not-found", "Not installed", "danger"],
      ["unrunnable", "Found but could not run", "danger"],
      ["timeout", "Version check timed out", "warning"],
      ["probe-failed", "Version check failed", "warning"],
      ["malformed", "Unrecognized version output", "warning"],
    ] as const;

    for (const [versionStatus, label, tone] of cases) {
      expect(summarizeBinaryHealth({ ...base, version: null, versionStatus })).toEqual({
        label,
        tone,
      });
    }
  });
});

describe("compatibility and process summaries", () => {
  test("never turns unknown rpc-ui/LSP probes into unsupported claims", () => {
    expect(summarizeRpcUiSupport({ checked: false, supported: null })).toBe(
      "Unknown (omp binary unavailable)",
    );
    expect(summarizeRpcUiSupport({ checked: true, supported: null })).toBe(
      "Unknown (probe failed, empty, or truncated)",
    );
    expect(rpcUiTone({ checked: true, supported: null })).toBe("muted");

    expect(summarizeLspSupport({ status: "unknown" })).toBe(
      "Unknown (probe failed, empty, or truncated)",
    );
    expect(lspTone({ status: "not-advertised" })).toBe("muted");
  });

  test("renders honest MCP and process availability states", () => {
    expect(
      summarizeMcpDiagnostics({
        status: "unavailable",
        serverCount: null,
        serverNames: null,
        reason: "No signal.",
      }),
    ).toBe("Unavailable (No signal.)");
    expect(
      summarizeMcpDiagnostics({
        status: "configured",
        serverCount: 2,
        serverNames: ["alpha", "beta"],
        reason: null,
      }),
    ).toBe("2 configured (alpha, beta)");
    const configuredMcp = {
      status: "configured" as const,
      serverCount: 1,
      serverNames: ["a"],
      reason: null,
    };
    expect(mcpTone(configuredMcp)).toBe("ok");
    expect(summarizeProcessDiagnostics({ status: "ok", trackedCount: 3 })).toBe("3 tracked");
    expect(processTone({ status: "ok", trackedCount: 3 })).toBe("ok");
    expect(summarizeProcessDiagnostics({ status: "unavailable", trackedCount: null })).toBe(
      "No hub run directory found",
    );
    expect(summarizeProcessDiagnostics({ status: "partial", trackedCount: 1 })).toBe(
      "1 tracked (partial: some inaccessible)",
    );
    expect(processTone({ status: "partial", trackedCount: 1 })).toBe("warning");
  });
});

describe("storage summaries", () => {
  test("keeps missing, invalid, and wrong-type states distinct", () => {
    expect(summarizePathState("missing")).toEqual({ label: "Missing", tone: "danger" });
    expect(summarizePathState("invalid")).toEqual({
      label: "Invalid or unreadable",
      tone: "warning",
    });
    expect(summarizePathState("wrong-type")).toEqual({
      label: "Wrong type on disk",
      tone: "warning",
    });
  });

  test("does not call unavailable memory not configured", () => {
    expect(summarizeMemoryBackend(health({ memoryBackend: null }))).toBe("Not configured");
    expect(
      summarizeMemoryBackend(
        health({
          memoryBackend: null,
          roots: { ...health().roots, configState: "invalid" },
        }),
      ),
    ).toBe("Unknown (config invalid or unreadable)");
  });
});

describe("selectKnownOmpProviders", () => {
  test("keeps only explicit bundled and canary ids, including prototype-like ids safely", () => {
    const entries: PaseoProviderSnapshotResult["entries"] = [
      { provider: "omp", status: "unavailable", enabled: false, label: "OMP" },
      {
        provider: "omp-plugin",
        status: "ready",
        enabled: true,
        label: "OMP (Plugin Preview)",
      },
      { provider: "constructor", status: "ready", enabled: true },
      { provider: "toString", status: "ready", enabled: true },
      { provider: "claude", status: "ready", enabled: true, label: "Claude" },
    ];

    expect(selectKnownOmpProviders(entries)).toEqual([
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
});
