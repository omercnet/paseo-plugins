import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import {
  type listOmpSecurity,
  type OmpSecurityList,
  type OmpSecurityScan,
  type OmpSecuritySeverity,
  OmpSecuritySeveritySchema,
} from "../shared/omp-security";
import {
  type OmpListDependencies,
  ompListDependencies,
  requireOmpExecutable,
} from "./omp-list-setting";
import { inOmpScope, readSetting } from "./omp-rules";
import { OmpPublicError } from "./provider/security";

const MAX_SCANS = 20;
const MAX_FIELD_CHARS = 256;
const SCAN_LINE = /^- `(secscan_[A-Za-z0-9]+)` — (\w+); (\d+) finding\(s\); (.*); (\S+)$/u;
const FINDING_LINE = /^- `[^`]+` \*\*(\w+)\*\* — /u;
const EnabledSchema = z.object({ value: z.boolean() });

export class OmpSecurityError extends OmpPublicError {}

interface ListedScan {
  id: string;
  phase: string;
  findingCount: number;
  producer: string;
  createdAt: string;
}

/** The scan lines of `security://scans`. Anything else, such as a heading, is skipped. */
export function parseScanLines(text: string): ListedScan[] {
  return text.split("\n").flatMap((line) => {
    const match = SCAN_LINE.exec(line);
    if (!match) return [];
    const [, id, phase, count, producer, createdAt] = match;
    return [
      {
        id: id.slice(0, MAX_FIELD_CHARS),
        phase: phase.slice(0, MAX_FIELD_CHARS),
        findingCount: Number(count),
        producer: producer.slice(0, MAX_FIELD_CHARS),
        createdAt: createdAt.slice(0, MAX_FIELD_CHARS),
      },
    ];
  });
}

/** Counts the severity at the start of each finding line; a title can never be mistaken for one. */
export function countSeverities(text: string): Record<OmpSecuritySeverity, number> {
  const counts: Record<OmpSecuritySeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  for (const line of text.split("\n")) {
    const level = OmpSecuritySeveritySchema.safeParse(FINDING_LINE.exec(line)?.[1]);
    if (level.success) counts[level.data] += 1;
  }
  return counts;
}

async function readResource(
  dependencies: OmpListDependencies,
  executable: string,
  url: string,
  cwd: string,
): Promise<string> {
  const run = await dependencies.run(executable, ["read", url], cwd);
  if (run.outcome === "timeout") throw new OmpSecurityError(`omp read ${url} timed out`);
  if (run.outcome !== "exited" || run.exitCode !== 0 || run.truncated) {
    throw new OmpSecurityError(`omp read ${url} failed`);
  }
  return run.stdout;
}

async function withSeverities(
  dependencies: OmpListDependencies,
  executable: string,
  scan: ListedScan,
  cwd: string,
): Promise<OmpSecurityScan> {
  const url = `security://scans/${scan.id}/findings`;
  const text =
    scan.findingCount === 0 ? "" : await readResource(dependencies, executable, url, cwd);
  const severities = countSeverities(text);
  const counted = Object.values(severities).reduce((sum, count) => sum + count, 0);
  return { ...scan, severities, severitiesComplete: counted === scan.findingCount };
}

/**
 * Scans live in OMP's private, project-keyed store. The plugin reads them through OMP itself
 * (`omp read security://...`), the documented read-only surface, so the store layout, profiles and
 * XDG roots stay OMP's business. Only phase and counts leave the server, never finding details.
 */
export async function listOmpSecurityWithDependencies(
  input: RpcInput<typeof listOmpSecurity>,
  dependencies: OmpListDependencies,
): Promise<OmpSecurityList> {
  try {
    const executable = await requireOmpExecutable(dependencies);
    return await inOmpScope(input.cwd, dependencies, async (runIn) => {
      const enabled = await readSetting(
        dependencies,
        executable,
        "security.enabled",
        EnabledSchema,
        runIn,
      );
      if (!enabled) return { status: "off" as const };
      const listed = parseScanLines(
        await readResource(dependencies, executable, "security://scans", runIn),
      );
      const shown = listed.slice(0, MAX_SCANS);
      const scans = await Promise.all(
        shown.map((scan) => withSeverities(dependencies, executable, scan, runIn)),
      );
      return { status: "ready" as const, scans, truncated: listed.length > shown.length };
    });
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

export function resolveListOmpSecurity(input: RpcInput<typeof listOmpSecurity>) {
  return listOmpSecurityWithDependencies(input, ompListDependencies);
}
