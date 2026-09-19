import { describe, expect, test, vi } from "vitest";
import {
  OMP_OPERATIONAL_FAILURES,
  OmpOperationalFailureCollector,
} from "../server/operational-failure-diagnostics";
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
    store: "named-profile",
    health: providerHealth(),
    violations: collector.snapshot(),
    operationalFailures: new OmpOperationalFailureCollector(
      () => new Date("2026-09-19T12:00:00.000Z"),
    ).snapshot(),
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
      reason: "json-decode",
      phase: "idle",
      field: "frame",
      expected: "valid-json",
      actualType: "invalid-json",
      occurrenceCount: 4,
      frameType: "response",
      maxByteSize: 777,
    });
    collector.report({
      category: "invalid-event",
      reason: "notice-level-type",
      phase: "active-turn",
      eventType: "notice",
      frameType: "notice",
      field: "notice.level",
      expected: "notice-level-enum",
      actualType: "number",
      occurrenceCount: 1,
      maxByteSize: 762,
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
    expect(first).toContain("selection.store: named-profile");
    expect(first).toContain("selection.applies_to: provider-health");
    expect(first).toContain("diagnostic_counters.scope: plugin-process-all-stores-workspaces");
    expect(first).toContain("diagnostic_counters.lifetime: since-plugin-load");
    expect(first).toContain("collection.provider_health: complete");
    expect(first).toContain("omp.version: 18.4.2-beta.1");
    expect(first).toContain("compatibility.rpc_ui: supported");
    expect(first).toContain("compatibility.lsp: supported");
    expect(first).toContain("mcp.server_count: 3");
    expect(first).toContain("storage.session_root: unreadable");
    expect(first).toContain("storage.memory_backend: mnemopi");
    expect(first).toContain("hub.active_count: 2");
    expect(first).toContain("protocol.invalid-json.occurrence_count: 4");
    expect(first).toContain("protocol.invalid-json.latest_reason: json-decode");
    expect(first).toContain("protocol.invalid-json.latest_phase: idle");
    expect(first).toContain("protocol.invalid-json.latest_field: frame");
    expect(first).toContain("protocol.invalid-json.latest_expected: valid UTF-8 JSON");
    expect(first).toContain("protocol.invalid-json.latest_actual_type: invalid-json");
    expect(first).toContain("protocol.invalid-json.reason.json-decode.occurrence_count: 4");
    expect(first).toContain("protocol.invalid-json.latest_frame_type: response");
    expect(first).toContain("protocol.invalid-json.max_byte_size: 777");
    expect(first).not.toContain("operational.session-open.startup");
    expect(first).toContain("protocol.invalid-event.latest_phase: active-turn");
    expect(first).toContain("protocol.invalid-event.latest_event_type: notice");
    expect(first).toContain("protocol.invalid-event.latest_field: notice.level");
    expect(first).toContain("protocol.invalid-event.latest_expected: info, warning, or error");
    expect(first).toContain("protocol.invalid-event.latest_actual_type: number");
    expect(first).not.toMatch(/: (?:0|unknown|unavailable)$/mu);
  });

  test("excludes paths and private payloads at the resolver boundary", async () => {
    const collector = new OmpProtocolViolationCollector(() => new Date(), vi.fn());
    const operational = new OmpOperationalFailureCollector(() => new Date());
    const result = await resolveGetOmpSupportReport(
      {
        cwd: "/Users/alice/repositories/private-project",
        store: { agentDir: "/Users/alice/custom-secret-store" },
      },
      collector,
      operational,
      {
        loadHealth: async () => providerHealth(),
        loadPluginVersion: async () => "0.3.0",
        now: () => new Date("2026-09-19T12:00:00.000Z"),
        platform: () => "linux",
        architecture: () => "arm64",
        nodeVersion: "v24.8.0",
      },
    );

    expect(result.report).toContain("selection.store: custom-directory");
    expect(result.report).not.toContain("/Users/alice");
    expect(result.report).not.toContain("private-project");
    expect(result.report).not.toContain("omp-secret");
    expect(result.report).not.toContain("https://");

    const namedProfile = await resolveGetOmpSupportReport(
      { store: { profile: "private-team" } },
      collector,
      operational,
      {
        loadHealth: async () => providerHealth(),
        loadPluginVersion: async () => "0.3.0",
        now: () => new Date("2026-09-19T12:00:00.000Z"),
        platform: () => "linux",
        architecture: () => "arm64",
        nodeVersion: "v24.8.0",
      },
    );
    expect(namedProfile.report).toContain("selection.store: named-profile");
    expect(namedProfile.report).not.toContain("private-team");
  });

  test("keeps actionable health reasons while omitting unavailable status rows", () => {
    const data = reportData();
    const report = formatOmpSupportReport({
      ...data,
      health: {
        ...providerHealth(),
        mcp: {
          status: "unavailable",
          serverCount: null,
          reason: "No mcp.json manifest found under the agent root",
        },
      },
    });

    expect(report).toContain("mcp.reason: No mcp.json manifest found under the agent root");
    expect(report).not.toContain("mcp.status: unavailable");
    expect(report).not.toMatch(/: (?:0|unknown|unavailable)$/mu);
  });

  test("omits unavailable placeholder rows when collection fails", async () => {
    const collector = new OmpProtocolViolationCollector(() => new Date(), vi.fn());
    const operational = new OmpOperationalFailureCollector(() => new Date());
    const result = await resolveGetOmpSupportReport({}, collector, operational, {
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

    expect(result.report).toContain("schema_version: 1");
    expect(result.report).toContain("selection.store: default");
    expect(result.report).toContain("collection.provider_health: failed");
    expect(result.report).not.toMatch(/: (?:0|unknown|unavailable)$/mu);
    expect(result.report).not.toContain("secret failure payload");
  });

  test("falls back to a valid bounded report if formatting would exceed 64 KiB", () => {
    const sample = {
      ...reportData().violations[0],
      occurrenceCount: 1,
      batchCount: 1,
      maxOccurrenceCount: 1,
      latestReason: "event-schema" as const,
      firstAt: "2026-09-19T12:00:00.000Z",
      lastAt: "2026-09-19T12:00:00.000Z",
    };
    const oversized = formatOmpSupportReport({
      ...reportData(),
      violations: Array.from({ length: 2_000 }, () => sample),
    });

    expect(supportReportByteLength(oversized)).toBeLessThanOrEqual(OMP_SUPPORT_REPORT_MAX_BYTES);
    expect(oversized).toContain("collection_error: report-size-limit");
    expect(getOmpSupportReport.output.safeParse({ report: oversized }).success).toBe(true);
  });
});

describe("operational failure aggregation", () => {
  test("covers every fixed failure class with bounded timestamp-only cells", () => {
    const times = OMP_OPERATIONAL_FAILURES.map(
      (_, index) => new Date(Date.UTC(2026, 8, 19, 12, index)),
    );
    const collector = new OmpOperationalFailureCollector(() => times.shift() ?? new Date(0));
    for (const failure of OMP_OPERATIONAL_FAILURES) collector.report(failure);

    const snapshot = collector.snapshot();
    expect(snapshot).toHaveLength(15);
    expect(snapshot.map(({ category, stage }) => ({ category, stage }))).toEqual(
      OMP_OPERATIONAL_FAILURES,
    );
    expect(snapshot.every((entry) => entry.occurrenceCount === 1)).toBe(true);
    expect(snapshot.every((entry) => entry.firstAt === entry.lastAt)).toBe(true);
    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "session-open", stage: "startup" }),
        expect.objectContaining({ category: "session-open", stage: "catalog" }),
        expect.objectContaining({ category: "replay-recovery", stage: "runtime-recovery" }),
        expect.objectContaining({ category: "tool-projector", stage: "host-tool-timeout" }),
        expect.objectContaining({ category: "tool-projector", stage: "timeline-projector" }),
        expect.objectContaining({ category: "terminal-outcome", stage: "unresolved" }),
      ]),
    );
  });

  test("stays constant-space, ignores unknown cells, and resets with a new plugin instance", () => {
    const collector = new OmpOperationalFailureCollector(() => new Date(0));
    for (let index = 0; index < 10_000; index += 1) {
      collector.report({ category: "terminal-outcome", stage: "failed" });
    }
    collector.report({ category: "unsafe", stage: "payload" } as never);

    expect(collector.snapshot()).toHaveLength(15);
    expect(
      collector
        .snapshot()
        .find((entry) => entry.category === "terminal-outcome" && entry.stage === "failed"),
    ).toMatchObject({ occurrenceCount: 10_000 });
    expect(
      new OmpOperationalFailureCollector().snapshot().every((entry) => entry.occurrenceCount === 0),
    ).toBe(true);
  });
});

describe("protocol violation aggregation", () => {
  test("keeps fixed categories, saturating counts, timestamps, and safe metadata", () => {
    const times = [new Date("2026-09-19T12:00:00.000Z"), new Date("2026-09-19T12:01:00.000Z")];
    const log = vi.fn();
    const collector = new OmpProtocolViolationCollector(() => times.shift() ?? new Date(0), log);

    collector.report({
      category: "frame-limit",
      reason: "physical-frame-limit",
      phase: "startup",
      occurrenceCount: Number.MAX_SAFE_INTEGER,
      frameType: "rpc_chunk",
      maxByteSize: 1024,
    });
    collector.report({
      category: "frame-limit",
      reason: "semantic-frame-limit",
      phase: "idle",
      occurrenceCount: 9,
      frameType: "rpc_frame_error",
      maxByteSize: 4096,
    });

    const snapshot = collector.snapshot();
    const frameLimit = snapshot.find((entry) => entry.category === "frame-limit");
    expect(frameLimit).toMatchObject({
      category: "frame-limit",
      occurrenceCount: Number.MAX_SAFE_INTEGER,
      batchCount: 2,
      maxOccurrenceCount: Number.MAX_SAFE_INTEGER,
      firstAt: "2026-09-19T12:00:00.000Z",
      lastAt: "2026-09-19T12:01:00.000Z",
      latestReason: "semantic-frame-limit",
      latestPhase: "idle",
      latestFrameType: "rpc_frame_error",
      maxByteSize: 4096,
    });
    expect(frameLimit?.reasonCounts["physical-frame-limit"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(frameLimit?.reasonCounts["semantic-frame-limit"]).toBe(9);
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

    expect(() =>
      collector.report({
        category: "invalid-event",
        phase: "idle",
        reason: "event-schema",
        occurrenceCount: 1,
      }),
    ).not.toThrow();
    expect(collector.snapshot().find((entry) => entry.category === "invalid-event")).toMatchObject({
      occurrenceCount: 1,
      firstAt: null,
      lastAt: null,
    });
  });

  test("suppresses asynchronous logger rejection", async () => {
    const collector = new OmpProtocolViolationCollector(
      () => new Date("2026-09-19T12:00:00.000Z"),
      async () => {
        throw new Error("async logger failed");
      },
    );

    expect(() =>
      collector.report({
        category: "invalid-json",
        phase: "idle",
        reason: "json-decode",
        occurrenceCount: 1,
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(collector.snapshot().find((entry) => entry.category === "invalid-json")).toMatchObject({
      occurrenceCount: 1,
    });
  });
});
