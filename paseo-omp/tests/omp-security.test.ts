import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { severityText } from "../client/omp-security-state";
import {
  countSeverities,
  listOmpSecurityWithDependencies,
  parseScanLines,
} from "../server/omp-security";
import type { BoundedRun } from "../server/provider-diagnostics";
import type { OmpSecurityScan } from "../shared/omp-security";
import { exited, fakeOmp } from "./fake-omp-config";

/** OMP prints an em dash between a scan id and its status. */
const DASH = "\u2014";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "omp-security-test-"));
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function scanLine(id: string, status: string, count: number, producer: string, time: string) {
  return `- \`${id}\` ${DASH} ${status}; ${count} finding(s); ${producer}; ${time}`;
}

const SCANS = [
  "# Security scans",
  "",
  scanLine("secscan_c", "completed", 6, "omp", "2026-11-05T10:00:00.000Z"),
  scanLine("secscan_b", "running", 0, "omp", "2026-11-05T11:30:00.000Z"),
  scanLine("secscan_a", "failed", 0, "codex; security", "2026-11-05T09:00:00.000Z"),
  "",
].join("\n");

function findingLine(id: string, severity: string, title: string) {
  return `- \`${id}\` **${severity}** ${DASH} ${title}`;
}

const FINDINGS = [
  "# Findings for secscan_c",
  "",
  findingLine("secf_1", "critical", "Hardcoded signing key (`demo.rule`)"),
  findingLine("secf_2", "high", "SQL built from request input (`demo.rule`)"),
  findingLine(
    "secf_3",
    "high",
    `Fake **low** ${DASH} title with - \`x\` **critical** ${DASH} inside`,
  ),
  findingLine("secf_4", "medium", "Missing rate limit (`demo.rule`)"),
  findingLine("secf_5", "low", "Verbose error page (`demo.rule`)"),
  findingLine("secf_6", "informational", "Outdated dependency note (`demo.rule`)"),
  "Note: a **critical** word outside any finding line is not a finding",
  "",
].join("\n");

interface FakeSecurity {
  enabled?: boolean;
  scans?: string;
  findings?: Record<string, string>;
  failScans?: BoundedRun;
  /** Scan ids whose findings listing fails. */
  failFindings?: readonly string[];
}

/** omp with the three commands the section uses; records every `read` and how many overlap. */
function securityOmp(fake: FakeSecurity = {}) {
  const base = fakeOmp([]);
  const reads: { url: string; cwd: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  base.dependencies.run = async (_executable, args, cwd) => {
    if (args[0] === "config") return exited(JSON.stringify({ value: fake.enabled ?? true }));
    const url = args[1] ?? "";
    reads.push({ url, cwd });
    if (url === "security://scans") return fake.failScans ?? exited(fake.scans ?? SCANS);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(5);
    inFlight -= 1;
    const id = /security:\/\/scans\/([^/]+)\/findings/u.exec(url)?.[1] ?? "";
    if (fake.failFindings?.includes(id)) return { ...exited(""), exitCode: 1 };
    return exited(fake.findings?.[id] ?? "# Findings\n\nNo findings.\n");
  };
  return {
    reads,
    urls: () => reads.map((read) => read.url),
    maxInFlight: () => maxInFlight,
    dependencies: base.dependencies,
  };
}

describe("reading OMP's scan listing", () => {
  test("takes id, phase, count, producer and time from each scan line and skips the rest", () => {
    expect(parseScanLines(SCANS)).toEqual({
      skipped: 0,
      scans: [
        {
          id: "secscan_c",
          phase: "completed",
          findingCount: 6,
          producer: "omp",
          createdAt: "2026-11-05T10:00:00.000Z",
        },
        {
          id: "secscan_b",
          phase: "running",
          findingCount: 0,
          producer: "omp",
          createdAt: "2026-11-05T11:30:00.000Z",
        },
        {
          id: "secscan_a",
          phase: "failed",
          findingCount: 0,
          producer: "codex; security",
          createdAt: "2026-11-05T09:00:00.000Z",
        },
      ],
    });
    expect(parseScanLines("# Security scans\n\nNo scans are stored for this project.\n")).toEqual({
      scans: [],
      skipped: 0,
    });
  });

  test("a producer name with a newline cannot hide a scan: the broken line is counted as skipped", () => {
    const spoofed = [
      "# Security scans",
      `- \`secscan_real\` ${DASH} completed; 3 finding(s); x`,
      scanLine("secscan_fake", "completed", 0, "y", "2026-11-05T10:00:00.000Z"),
    ].join("\n");
    const parsed = parseScanLines(spoofed);
    expect(parsed.skipped).toBe(1);
    expect(parsed.scans.map((scan) => scan.id)).toEqual(["secscan_fake"]);
  });

  test("a repeated scan id is listed once and the repeat counts as skipped", () => {
    const line = scanLine("secscan_dup", "completed", 0, "omp", "2026-11-05T10:00:00.000Z");
    const parsed = parseScanLines(`${line}\n${line}\n`);
    expect(parsed.scans).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  test("counts the severity that starts a finding line, never one inside a title", () => {
    expect(countSeverities(FINDINGS)).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 1,
      informational: 1,
    });
  });
});

describe("listing scans for a workspace", () => {
  test("reports phase and counts per scan, and sends no finding details", async () => {
    const omp = securityOmp({ findings: { secscan_c: FINDINGS } });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    expect(result).toMatchObject({ status: "ready", truncated: false, skipped: 0 });
    if (result.status !== "ready") return;
    expect(result.scans.map((scan) => [scan.id, scan.phase, scan.findingCount])).toEqual([
      ["secscan_c", "completed", 6],
      ["secscan_b", "running", 0],
      ["secscan_a", "failed", 0],
    ]);
    expect(result.scans[0]?.severities).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 1,
      informational: 1,
    });
    expect(result.scans[0]?.severitiesComplete).toBe(true);
    const sent = JSON.stringify(result);
    for (const secret of ["Hardcoded signing key", "demo.rule", "SQL built"]) {
      expect(sent).not.toContain(secret);
    }
  });

  test("runs omp in the workspace and reads findings only for scans that have some", async () => {
    const omp = securityOmp({ findings: { secscan_c: FINDINGS } });
    await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    expect(omp.urls().filter((url) => url.endsWith("/findings"))).toEqual([
      "security://scans/secscan_c/findings",
    ]);
    for (const read of omp.reads) expect(read.cwd).toBe(project);
  });

  test("flags counts that OMP's own listing cut short", async () => {
    const cut = FINDINGS.split("\n").slice(0, 5).join("\n");
    const omp = securityOmp({ findings: { secscan_c: cut } });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.scans[0]?.severitiesComplete).toBe(false);
  });

  test("one scan whose findings cannot be read does not hide the others", async () => {
    const omp = securityOmp({
      scans: [
        scanLine("secscan_x", "completed", 2, "omp", "2026-11-05T10:00:00.000Z"),
        scanLine("secscan_y", "completed", 1, "omp", "2026-11-05T09:00:00.000Z"),
      ].join("\n"),
      findings: { secscan_y: findingLine("secf_1", "high", "Only one") },
      failFindings: ["secscan_x"],
    });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.scans.map((scan) => [scan.id, scan.severitiesComplete])).toEqual([
      ["secscan_x", false],
      ["secscan_y", true],
    ]);
    expect(result.scans[1]?.severities.high).toBe(1);
  });

  test("lists at most 20 scans, reads at most 4 at once, and says there are more", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      scanLine(`secscan_${i}`, "completed", 1, "omp", "2026-11-05T10:00:00.000Z"),
    ).join("\n");
    const omp = securityOmp({ scans: `# Security scans\n\n${many}\n` });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.scans).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(omp.urls().filter((url) => url.endsWith("/findings"))).toHaveLength(20);
    expect(omp.maxInFlight()).toBeLessThanOrEqual(4);
    expect(omp.maxInFlight()).toBeGreaterThan(1);
  });

  test("an empty store is an empty list", async () => {
    const omp = securityOmp({
      scans: "# Security scans\n\nNo scans are stored for this project.\n",
    });
    expect(await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies)).toEqual({
      status: "ready",
      scans: [],
      truncated: false,
      skipped: 0,
    });
  });

  test("security.enabled off reads nothing from the store", async () => {
    const omp = securityOmp({ enabled: false });
    expect(await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies)).toEqual({
      status: "off",
    });
    expect(omp.reads).toEqual([]);
  });

  test("a failed omp read of the listing is an error result, not a rejection", async () => {
    const omp = securityOmp({ failScans: { ...exited(""), exitCode: 1 } });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    expect(result.status).toBe("error");
  });

  test("an invalid workspace path is an error result", async () => {
    const omp = securityOmp();
    const result = await listOmpSecurityWithDependencies(
      { cwd: join(project, "missing") },
      omp.dependencies,
    );
    expect(result.status).toBe("error");
    expect(omp.reads).toEqual([]);
  });
});

describe("wording the counts of a scan", () => {
  const scan: OmpSecurityScan = {
    id: "secscan_x",
    phase: "completed",
    findingCount: 3,
    severities: { critical: 0, high: 2, medium: 1, low: 0, informational: 0 },
    severitiesComplete: true,
    producer: "omp",
    createdAt: "2026-11-05T10:00:00.000Z",
  };

  test("lists the severities present, most severe first, or says there are no findings", () => {
    expect(severityText(scan)).toBe("2 high, 1 medium");
    expect(severityText({ ...scan, findingCount: 0 })).toBe("No findings");
  });

  test("a list that is cut short keeps the counts it has and says they may be incomplete", () => {
    expect(severityText({ ...scan, severitiesComplete: false })).toBe(
      "2 high, 1 medium (counts may be incomplete)",
    );
  });

  test("a failed read says counts are unavailable instead of printing nothing", () => {
    const failed: OmpSecurityScan = {
      ...scan,
      severities: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
      severitiesComplete: false,
    };
    expect(severityText(failed)).toBe("Severity counts unavailable");
  });
});
