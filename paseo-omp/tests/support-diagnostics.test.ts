import { describe, expect, test, vi } from "vitest";
import { OmpProtocolViolationCollector } from "../server/protocol-violation-diagnostics";
import {
  formatOmpSupportReport,
  type OmpSupportReportData,
  resolveGetOmpSupportReport,
} from "../server/support-diagnostics";
import type { OmpProviderHealth } from "../shared/provider-diagnostics";
import {
  getOmpSupportReport,
  OMP_SUPPORT_REPORT_MAX_BYTES,
  supportReportByteLength,
} from "../shared/support-diagnostics";

function providerHealth(): OmpProviderHealth {
  return {
    binary: {
      installed: true,
      resolvedPath: "/Users/alice/private/bin/omp-secret",
      version: { major: 18, minor: 4, patch: 2, prerelease: "beta.1" },
      versionStatus: "ok",
      processCleanupFailed: false,
    },
    rpcUi: { checked: true, supported: true },
    lsp: { status: "supported" },
    mcp: { status: "configured", serverCount: 3, reason: null },
    process: {
      status: "partial",
      trackedCount: 8,
      activeCount: 2,
      historicalCount: 5,
      unknownCount: 1,
    },
    roots: {
      agentRoot: "/Users/alice/private/.omp/agent",
      agentRootState: "available",
      configPath: "/Users/alice/private/.omp/config.yml",
      configState: "available",
      sessionRoot: "/Users/alice/private/.omp/sessions",
      sessionRootState: "unreadable",
    },
    databases: { agentDbState: "available", historyDbState: "missing" },
    memoryBackend: "mnemopi",
    checkedAt: "2026-09-19T12:00:00.000Z",
  };
}

function reportData(
  collector = new OmpProtocolViolationCollector(
    () => new Date("2026-09-19T12:00:00.000Z"),
    vi.fn(),
  ),
): OmpSupportReportData {
  return {
    collectedAt: "2026-09-19T12:00:00.000Z",
    pluginVersion: "0.3.0",
    platform: "linux",
    architecture: "arm64",
    nodeVersion: "v24.8.0",
    scope: "workspace",
    store: "Profile: work",
    health: providerHealth(),
    violations: collector.snapshot(),
  };
}

describe("OMP support report", () => {
  test("is schema-valid, complete, deterministic, and bounded", () => {
    const collector = new OmpProtocolViolationCollector(
      () => new Date("2026-09-19T12:00:00.000Z"),
      vi.fn(),
    );
    collector.report({
      category: "invalid-json",
      occurrenceCount: 4,
      frameType: "response",
      maxByteSize: 777,
    });
    const data = reportData(collector);
    const first = formatOmpSupportReport(data);
    const second = formatOmpSupportReport(data);

    expect(second).toBe(first);
    expect(getOmpSupportReport.output.parse({ report: first })).toEqual({ report: first });
    expect(supportReportByteLength(first)).toBeLessThanOrEqual(OMP_SUPPORT_REPORT_MAX_BYTES);
    expect(first).toContain("schema_version: 1");
    expect(first).toContain("collected_at_utc: 2026-09-19T12:00:00.000Z");
    expect(first).toContain("paseo_omp.version: 0.3.0");
    expect(first).toContain("runtime.platform: linux");
    expect(first).toContain("selection.scope: workspace");
    expect(first).toContain("selection.store: Profile: work");
    expect(first).toContain("omp.version: 18.4.2-beta.1");
    expect(first).toContain("compatibility.rpc_ui: supported");
    expect(first).toContain("compatibility.lsp: supported");
    expect(first).toContain("mcp.server_count: 3");
    expect(first).toContain("storage.session_root: unreadable");
    expect(first).toContain("storage.memory_backend: mnemopi");
    expect(first).toContain("hub.active_count: 2");
    expect(first).toContain("protocol.invalid-json.occurrence_count: 4");
    expect(first).toContain("protocol.invalid-json.latest_frame_type: response");
    expect(first).toContain("protocol.invalid-json.max_byte_size: 777");
  });

  test("excludes paths and private payloads at the resolver boundary", async () => {
    const collector = new OmpProtocolViolationCollector(() => new Date(), vi.fn());
    const result = await resolveGetOmpSupportReport(
      {
        cwd: "/Users/alice/repositories/private-project",
        store: { agentDir: "/Users/alice/custom-secret-store" },
      },
      collector,
      {
        loadHealth: async () => providerHealth(),
        loadPluginVersion: async () => "0.3.0",
        now: () => new Date("2026-09-19T12:00:00.000Z"),
        platform: () => "linux",
        architecture: () => "arm64",
        nodeVersion: "v24.8.0",
      },
    );

    expect(result.report).toContain("selection.store: Custom agent directory");
    expect(result.report).not.toContain("/Users/alice");
    expect(result.report).not.toContain("private-project");
    expect(result.report).not.toContain("omp-secret");
    expect(result.report).not.toContain("https://");
  });

  test("uses explicit unavailable fields when collection fails", async () => {
    const collector = new OmpProtocolViolationCollector(() => new Date(), vi.fn());
    const result = await resolveGetOmpSupportReport({}, collector, {
      loadHealth: async () => {
        throw new Error("secret failure payload");
      },
      loadPluginVersion: async () => {
        throw new Error("missing");
      },
      now: () => new Date("2026-09-19T12:00:00.000Z"),
      platform: () => "unexpected-platform",
      architecture: () => "unexpected-architecture",
      nodeVersion: "private-build-string",
    });

    expect(result.report).toContain("paseo_omp.version: unavailable");
    expect(result.report).toContain("provider_health.status: unavailable");
    expect(result.report).toContain("omp.version: unavailable");
    expect(result.report).toContain("runtime.platform: unknown");
    expect(result.report).not.toContain("secret failure payload");
  });

  test("falls back to a valid bounded report if formatting would exceed 64 KiB", () => {
    const sample = reportData().violations[0];
    const oversized = formatOmpSupportReport({
      ...reportData(),
      violations: Array.from({ length: 2_000 }, () => sample),
    });

    expect(supportReportByteLength(oversized)).toBeLessThanOrEqual(OMP_SUPPORT_REPORT_MAX_BYTES);
    expect(oversized).toContain("collection_error: report-size-limit");
    expect(getOmpSupportReport.output.safeParse({ report: oversized }).success).toBe(true);
  });
});

describe("protocol violation aggregation", () => {
  test("keeps fixed categories, saturating counts, timestamps, and safe metadata", () => {
    const times = [new Date("2026-09-19T12:00:00.000Z"), new Date("2026-09-19T12:01:00.000Z")];
    const log = vi.fn();
    const collector = new OmpProtocolViolationCollector(() => times.shift() ?? new Date(0), log);

    collector.report({
      category: "frame-limit",
      occurrenceCount: Number.MAX_SAFE_INTEGER,
      frameType: "rpc_chunk",
      maxByteSize: 1024,
    });
    collector.report({
      category: "frame-limit",
      occurrenceCount: 9,
      frameType: "rpc_frame_error",
      maxByteSize: 4096,
    });

    const snapshot = collector.snapshot();
    const frameLimit = snapshot.find((entry) => entry.category === "frame-limit");
    expect(snapshot).toHaveLength(12);
    expect(frameLimit).toEqual({
      category: "frame-limit",
      occurrenceCount: Number.MAX_SAFE_INTEGER,
      batchCount: 2,
      maxOccurrenceCount: Number.MAX_SAFE_INTEGER,
      firstAt: "2026-09-19T12:00:00.000Z",
      lastAt: "2026-09-19T12:01:00.000Z",
      latestFrameType: "rpc_frame_error",
      maxByteSize: 4096,
    });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("never throws into provider flow when time or logging fails", () => {
    const collector = new OmpProtocolViolationCollector(
      () => {
        throw new Error("clock failed");
      },
      () => {
        throw new Error("logger failed");
      },
    );

    expect(() => collector.report({ category: "invalid-event", occurrenceCount: 1 })).not.toThrow();
    expect(collector.snapshot().find((entry) => entry.category === "invalid-event")).toMatchObject({
      occurrenceCount: 1,
      firstAt: null,
      lastAt: null,
    });
  });
});
