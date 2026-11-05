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
const MAX_PARALLEL_READS = 4;
const MAX_FIELD_CHARS = 256;
const DASH = "\u2014";
const SCAN_LINE = new RegExp(
  `^- \`(secscan_[A-Za-z0-9]+)\` ${DASH} (\\w+); (\\d+) finding\\(s\\); (.*); (\\S+)$`,
  "u",
);
const FINDING_LINE = new RegExp(`^- \`[^\`]+\` \\*\\*(\\w+)\\*\\* ${DASH} `, "u");
const EnabledSchema = z.object({ value: z.boolean() });

export class OmpSecurityError extends OmpPublicError {}

interface ListedScan {
  id: string;
  phase: string;
  findingCount: number;
  producer: string;
  createdAt: string;
}

interface ParsedScans {
  scans: ListedScan[];
  /** Bullet lines that did not parse, or repeated an id: an odd producer name can break a line. */
  skipped: number;
}

/**
 * The scan lines of `security://scans`. A heading or a blank line is ignored; a bullet that does
 * not parse, or whose id was already listed, is counted as skipped so the tab can say so.
 */
export function parseScanLines(text: string): ParsedScans {
  const scans: ListedScan[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("- `")) continue;
    const match = SCAN_LINE.exec(line);
    if (!match || seen.has(match[1])) {
      skipped += 1;
      continue;
    }
    const [, id, phase, count, producer, createdAt] = match;
    seen.add(id);
    scans.push({
      id: id.slice(0, MAX_FIELD_CHARS),
      phase: phase.slice(0, MAX_FIELD_CHARS),
      findingCount: Number(count),
      producer: producer.slice(0, MAX_FIELD_CHARS),
      createdAt: createdAt.slice(0, MAX_FIELD_CHARS),
    });
  }
  return { scans, skipped };
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

/** A scan whose findings cannot be read still lists, with its counts marked incomplete. */
async function withSeverities(
  dependencies: OmpListDependencies,
  executable: string,
  scan: ListedScan,
  cwd: string,
): Promise<OmpSecurityScan> {
  const url = `security://scans/${scan.id}/findings`;
  const text =
    scan.findingCount === 0
      ? ""
      : await readResource(dependencies, executable, url, cwd).catch((error: unknown) => {
          if (error instanceof OmpSecurityError) return null;
          throw error;
        });
  const severities = countSeverities(text ?? "");
  const counted = Object.values(severities).reduce((sum, count) => sum + count, 0);
  return {
    ...scan,
    severities,
    severitiesComplete: text !== null && counted === scan.findingCount,
  };
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
      const text = await readResource(dependencies, executable, "security://scans", runIn);
      const { scans: listed, skipped } = parseScanLines(text);
      const shown = listed.slice(0, MAX_SCANS);
      const scans: OmpSecurityScan[] = [];
      for (let start = 0; start < shown.length; start += MAX_PARALLEL_READS) {
        const batch = shown.slice(start, start + MAX_PARALLEL_READS);
        scans.push(
          ...(await Promise.all(
            batch.map((scan) => withSeverities(dependencies, executable, scan, runIn)),
          )),
        );
      }
      return { status: "ready" as const, scans, truncated: listed.length > shown.length, skipped };
    });
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

export function resolveListOmpSecurity(input: RpcInput<typeof listOmpSecurity>) {
  return listOmpSecurityWithDependencies(input, ompListDependencies);
}
