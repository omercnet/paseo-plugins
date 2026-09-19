export const OMP_OPERATIONAL_FAILURES = [
  { category: "session-open", stage: "startup" },
  { category: "session-open", stage: "catalog" },
  { category: "replay-recovery", stage: "persisted-replay" },
  { category: "replay-recovery", stage: "runtime-recovery" },
  { category: "replay-recovery", stage: "rewind" },
  { category: "tool-projector", stage: "host-tool-unknown" },
  { category: "tool-projector", stage: "host-tool-capacity" },
  { category: "tool-projector", stage: "host-tool-normalization" },
  { category: "tool-projector", stage: "host-tool-call" },
  { category: "tool-projector", stage: "host-tool-timeout" },
  { category: "tool-projector", stage: "host-tool-delivery" },
  { category: "tool-projector", stage: "timeline-projector" },
  { category: "tool-projector", stage: "subsession-projector" },
  { category: "terminal-outcome", stage: "failed" },
  { category: "terminal-outcome", stage: "unresolved" },
] as const;

export type OmpOperationalFailure = (typeof OMP_OPERATIONAL_FAILURES)[number];
export type OmpOperationalFailureCategory = OmpOperationalFailure["category"];
export type OmpOperationalFailureStage = OmpOperationalFailure["stage"];
export type OmpOperationalFailureReporter = (failure: OmpOperationalFailure) => void;

export type OmpOperationalFailureSummary = OmpOperationalFailure & {
  occurrenceCount: number;
  firstAt: string | null;
  lastAt: string | null;
};

const FAILURE_KEYS: Readonly<Record<string, true>> = Object.fromEntries(
  OMP_OPERATIONAL_FAILURES.map(({ category, stage }) => [`${category}:${stage}`, true]),
);

function timestamp(now: () => Date): string | null {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

/** Fixed category/stage cells make aggregation constant-space for one plugin subprocess lifetime. */
export class OmpOperationalFailureCollector {
  private readonly summaries = Object.fromEntries(
    OMP_OPERATIONAL_FAILURES.map(({ category, stage }) => [
      `${category}:${stage}`,
      { category, stage, occurrenceCount: 0, firstAt: null, lastAt: null },
    ]),
  ) as Record<string, OmpOperationalFailureSummary>;

  constructor(private readonly now: () => Date = () => new Date()) {}

  report: OmpOperationalFailureReporter = (failure) => {
    try {
      const key = `${failure.category}:${failure.stage}`;
      if (!FAILURE_KEYS[key]) return;
      const summary = this.summaries[key];
      if (!summary) return;
      summary.occurrenceCount = Math.min(Number.MAX_SAFE_INTEGER, summary.occurrenceCount + 1);
      const recordedAt = timestamp(this.now);
      if (recordedAt) {
        summary.firstAt ??= recordedAt;
        summary.lastAt = recordedAt;
      }
    } catch {
      // Diagnostics must never affect provider or session flow.
    }
  };

  snapshot(): OmpOperationalFailureSummary[] {
    return OMP_OPERATIONAL_FAILURES.map(({ category, stage }) => ({
      ...this.summaries[`${category}:${stage}`],
    }));
  }
}
