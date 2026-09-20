import {
  OMP_PROTOCOL_VIOLATION_CATEGORIES,
  OMP_PROTOCOL_VIOLATION_REASONS,
  type OmpProtocolViolationCategory,
  type OmpProtocolViolationDiagnostic,
  type OmpProtocolViolationReason,
} from "./provider/omp-rpc-protocol";

export interface OmpProtocolViolationSummary {
  category: OmpProtocolViolationCategory;
  occurrenceCount: number;
  batchCount: number;
  maxOccurrenceCount: number;
  firstAt: string | null;
  lastAt: string | null;
  reasonCounts: Record<OmpProtocolViolationReason, number>;
  latestReason: OmpProtocolViolationDiagnostic["reason"] | null;
  latestPhase: OmpProtocolViolationDiagnostic["phase"] | null;
  latestEventType: OmpProtocolViolationDiagnostic["eventType"] | null;
  latestFrameType: OmpProtocolViolationDiagnostic["frameType"] | null;
  latestField: OmpProtocolViolationDiagnostic["field"] | null;
  latestExpected: OmpProtocolViolationDiagnostic["expected"] | null;
  latestActualType: OmpProtocolViolationDiagnostic["actualType"] | null;
  maxByteSize: number | null;
  latestLimitBytes: number | null;
}

type MutableSummary = OmpProtocolViolationSummary;

const FRAME_TYPES: Record<NonNullable<OmpProtocolViolationDiagnostic["frameType"]>, true> = {
  ready: true,
  response: true,
  rpc_chunk: true,
  rpc_frame_error: true,
  notice: true,
};

function boundedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function safeTimestamp(now: () => Date): string | null {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

function logProtocolViolation(message: string, diagnostic: OmpProtocolViolationDiagnostic): void {
  const fields = [
    `category: ${diagnostic.category}`,
    `reason: ${diagnostic.reason}`,
    `occurrenceCount: ${diagnostic.occurrenceCount}`,
    `phase: ${diagnostic.phase}`,
    ...(diagnostic.eventType ? [`eventType: ${diagnostic.eventType}`] : []),
    ...(diagnostic.frameType ? [`frameType: ${diagnostic.frameType}`] : []),
    ...(diagnostic.field ? [`field: ${diagnostic.field}`] : []),
    ...(diagnostic.expected ? [`expected: ${diagnostic.expected}`] : []),
    ...(diagnostic.actualType ? [`actualType: ${diagnostic.actualType}`] : []),
    ...(diagnostic.maxByteSize ? [`maxByteSize: ${diagnostic.maxByteSize}`] : []),
    ...(diagnostic.limitBytes ? [`limitBytes: ${diagnostic.limitBytes}`] : []),
  ];
  console.error(`${message} { ${fields.join(", ")} }`);
}

/** Fixed-category, saturating in-process aggregation. A new instance is created on each reload. */
export class OmpProtocolViolationCollector {
  private readonly summaries = Object.fromEntries(
    OMP_PROTOCOL_VIOLATION_CATEGORIES.map((category) => [
      category,
      {
        category,
        occurrenceCount: 0,
        batchCount: 0,
        maxOccurrenceCount: 0,
        firstAt: null,
        lastAt: null,
        reasonCounts: Object.fromEntries(
          OMP_PROTOCOL_VIOLATION_REASONS.map((reason) => [reason, 0]),
        ),
        latestReason: null,
        latestPhase: null,
        latestEventType: null,
        latestFrameType: null,
        latestField: null,
        latestExpected: null,
        latestActualType: null,
        maxByteSize: null,
        latestLimitBytes: null,
      },
    ]),
  ) as Record<OmpProtocolViolationCategory, MutableSummary>;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly log: (
      message: string,
      diagnostic: OmpProtocolViolationDiagnostic,
    ) => void | PromiseLike<void> = logProtocolViolation,
  ) {}

  report = (diagnostic: OmpProtocolViolationDiagnostic): void => {
    try {
      const summary = this.summaries[diagnostic.category];
      if (!summary) return;
      const occurrenceCount = boundedCount(diagnostic.occurrenceCount);
      const timestamp = safeTimestamp(this.now);
      summary.occurrenceCount = boundedAdd(summary.occurrenceCount, occurrenceCount);
      summary.batchCount = boundedAdd(summary.batchCount, 1);
      summary.maxOccurrenceCount = Math.max(summary.maxOccurrenceCount, occurrenceCount);
      if (timestamp) {
        summary.firstAt ??= timestamp;
        summary.lastAt = timestamp;
      }
      summary.reasonCounts[diagnostic.reason] = boundedAdd(
        summary.reasonCounts[diagnostic.reason],
        occurrenceCount,
      );
      summary.latestReason = diagnostic.reason;
      summary.latestPhase = diagnostic.phase;
      summary.latestEventType = diagnostic.eventType ?? null;
      summary.latestFrameType =
        diagnostic.frameType && FRAME_TYPES[diagnostic.frameType] ? diagnostic.frameType : null;
      summary.latestField = diagnostic.field ?? null;
      summary.latestExpected = diagnostic.expected ?? null;
      summary.latestActualType = diagnostic.actualType ?? null;
      const byteSize = boundedCount(diagnostic.maxByteSize);
      if (byteSize > 0) summary.maxByteSize = Math.max(summary.maxByteSize ?? 0, byteSize);
      const limitBytes = boundedCount(diagnostic.limitBytes);
      summary.latestLimitBytes = limitBytes || null;

      const safeDiagnostic: OmpProtocolViolationDiagnostic = {
        category: diagnostic.category,
        reason: diagnostic.reason,
        phase: diagnostic.phase,
        occurrenceCount,
        ...(summary.latestEventType ? { eventType: summary.latestEventType } : {}),
        ...(summary.latestFrameType ? { frameType: summary.latestFrameType } : {}),
        ...(summary.latestField ? { field: summary.latestField } : {}),
        ...(summary.latestExpected ? { expected: summary.latestExpected } : {}),
        ...(summary.latestActualType ? { actualType: summary.latestActualType } : {}),
        ...(byteSize > 0 ? { maxByteSize: byteSize } : {}),
        ...(limitBytes > 0 ? { limitBytes } : {}),
      };
      try {
        const logging = this.log("OMP protocol violation", safeDiagnostic);
        if (logging) void Promise.resolve(logging).catch(() => undefined);
      } catch {
        // Diagnostics must never affect transport or provider flow.
      }
    } catch {
      // Diagnostics must never affect transport or provider flow.
    }
  };

  snapshot(): OmpProtocolViolationSummary[] {
    return OMP_PROTOCOL_VIOLATION_CATEGORIES.map((category) => ({
      ...this.summaries[category],
      reasonCounts: { ...this.summaries[category].reasonCounts },
    }));
  }
}
