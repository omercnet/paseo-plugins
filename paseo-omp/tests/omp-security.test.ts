import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  countSeverities,
  listOmpSecurityWithDependencies,
  parseScanLines,
} from "../server/omp-security";
import type { BoundedRun } from "../server/provider-diagnostics";
import { exited, fakeOmp } from "./fake-omp-config";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "omp-security-test-"));
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

const SCANS = [
  "# Security scans",
  "",
  "- `secscan_c` — completed; 6 finding(s); omp; 2026-11-05T10:00:00.000Z",
  "- `secscan_b` — running; 0 finding(s); omp; 2026-11-05T11:30:00.000Z",
  "- `secscan_a` — failed; 0 finding(s); codex; security; 2026-11-05T09:00:00.000Z",
  "",
].join("\n");

const FINDINGS = [
  "# Findings for secscan_c",
  "",
  "- `secf_1` **critical** — Hardcoded signing key (`demo.rule`)",
  "- `secf_2` **high** — SQL built from request input (`demo.rule`)",
  "- `secf_3` **high** — Fake **low** — title with - `x` **critical** — inside",
  "- `secf_4` **medium** — Missing rate limit (`demo.rule`)",
  "- `secf_5` **low** — Verbose error page (`demo.rule`)",
  "- `secf_6` **informational** — Outdated dependency note (`demo.rule`)",
  "Note: a **critical** word outside any finding line is not a finding",
  "",
].join("\n");

interface FakeSecurity {
  enabled?: boolean;
  scans?: string;
  findings?: Record<string, string>;
  failScans?: BoundedRun;
}

/** omp with the three commands the section uses; records every `read`. */
function securityOmp(fake: FakeSecurity = {}) {
  const base = fakeOmp([]);
  const reads: string[] = [];
  base.dependencies.run = async (_executable, args) => {
    if (args[0] === "config") {
      return exited(JSON.stringify({ value: fake.enabled ?? true }));
    }
    const url = args[1] ?? "";
    reads.push(url);
    if (url === "security://scans") return fake.failScans ?? exited(fake.scans ?? SCANS);
    const id = /security:\/\/scans\/([^/]+)\/findings/u.exec(url)?.[1] ?? "";
    return exited(fake.findings?.[id] ?? "# Findings\n\nNo findings.\n");
  };
  return { reads, dependencies: base.dependencies };
}

describe("reading OMP's scan listing", () => {
  test("takes id, phase, count, producer and time from each scan line and skips the rest", () => {
    expect(parseScanLines(SCANS)).toEqual([
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
    ]);
    expect(parseScanLines("# Security scans\n\nNo scans are stored for this project.\n")).toEqual(
      [],
    );
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
    expect(result).toMatchObject({ status: "ready", truncated: false });
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

  test("reads findings only for scans that have some", async () => {
    const omp = securityOmp({ findings: { secscan_c: FINDINGS } });
    await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    expect(omp.reads.filter((url) => url.endsWith("/findings"))).toEqual([
      "security://scans/secscan_c/findings",
    ]);
  });

  test("flags counts that OMP's own listing cut short", async () => {
    const cut = FINDINGS.split("\n").slice(0, 5).join("\n");
    const omp = securityOmp({ findings: { secscan_c: cut } });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.scans[0]?.severitiesComplete).toBe(false);
  });

  test("lists at most 20 scans and says so", async () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `- \`secscan_${i}\` — completed; 0 finding(s); omp; 2026-11-05T10:00:00.000Z`,
    ).join("\n");
    const omp = securityOmp({ scans: `# Security scans\n\n${many}\n` });
    const result = await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.scans).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  test("an empty store is an empty list", async () => {
    const omp = securityOmp({
      scans: "# Security scans\n\nNo scans are stored for this project.\n",
    });
    expect(await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies)).toEqual({
      status: "ready",
      scans: [],
      truncated: false,
    });
  });

  test("security.enabled off reads nothing from the store", async () => {
    const omp = securityOmp({ enabled: false });
    expect(await listOmpSecurityWithDependencies({ cwd: project }, omp.dependencies)).toEqual({
      status: "off",
    });
    expect(omp.reads).toEqual([]);
  });

  test("a failed omp read is an error result, not a rejection", async () => {
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
