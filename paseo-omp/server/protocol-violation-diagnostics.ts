import {
  OMP_PROTOCOL_VIOLATION_CATEGORIES,
  type OmpProtocolViolationCategory,
  type OmpProtocolViolationDiagnostic,
} from "./provider/omp-rpc";

export interface OmpProtocolViolationSummary {
  category: OmpProtocolViolationCategory;
  occurrenceCount: number;
  batchCount: number;
  maxOccurrenceCount: number;
  firstAt: string | null;
  lastAt: string | null;
  latestFrameType: OmpProtocolViolationDiagnostic["frameType"] | null;
  maxByteSize: number | null;
}

type MutableSummary = OmpProtocolViolationSummary;

const FRAME_TYPES: Record<NonNullable<OmpProtocolViolationDiagnostic["frameType"]>, true> = {
  ready: true,
  response: true,
  rpc_chunk: true,
  rpc_frame_error: true,
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
        latestFrameType: null,
        maxByteSize: null,
      },
    ]),
  ) as Record<OmpProtocolViolationCategory, MutableSummary>;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly log: (
      message: string,
      diagnostic: OmpProtocolViolationDiagnostic,
    ) => void | PromiseLike<void> = console.error,
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
      summary.latestFrameType =
        diagnostic.frameType && FRAME_TYPES[diagnostic.frameType] ? diagnostic.frameType : null;
      const byteSize = boundedCount(diagnostic.maxByteSize);
      if (byteSize > 0) summary.maxByteSize = Math.max(summary.maxByteSize ?? 0, byteSize);

      const safeDiagnostic: OmpProtocolViolationDiagnostic = {
        category: diagnostic.category,
        occurrenceCount,
        ...(summary.latestFrameType ? { frameType: summary.latestFrameType } : {}),
        ...(byteSize > 0 ? { maxByteSize: byteSize } : {}),
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
    }));
  }
}
