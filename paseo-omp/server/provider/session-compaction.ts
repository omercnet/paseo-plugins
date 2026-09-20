import { randomUUID } from "node:crypto";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { OmpRpcEvent } from "./omp-rpc-protocol";
import type { OmpPublicDataSerializer } from "./security";
import type { ActiveTurn } from "./session-terminal";
import type { OmpSessionUsage } from "./session-usage";
import type { OmpTimelineProjector } from "./timeline-projector";

type Emit = (event: ProviderEvent) => void;

export interface ActiveCompaction {
  id: string;
  trigger: "auto" | "manual";
  turnId: string;
  generation: number;
  retrying: boolean;
  action?: string;
  preTokens?: number;
}

export class OmpSessionCompaction {
  private operation: ActiveCompaction | null = null;
  private discardedEnds = 0;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly projector: OmpTimelineProjector,
    private readonly dataFilter: OmpPublicDataSerializer,
    private readonly usage: OmpSessionUsage,
  ) {}

  get active(): ActiveCompaction | null {
    return this.operation;
  }

  start(turn: ActiveTurn, trigger: "auto" | "manual", action?: string): void {
    if (this.discardedEnds > 0) {
      this.discardedEnds += 1;
      return;
    }
    const active = this.operation;
    if (active && active.trigger === trigger && active.action === action) {
      active.retrying = false;
      return;
    }
    if (active) {
      this.retire("OMP emitted overlapping compactions");
      this.discardedEnds = 2;
      return;
    }
    const operation: ActiveCompaction = {
      id: randomUUID(),
      trigger,
      turnId: turn.turnId,
      generation: turn.generation,
      action,
      retrying: false,
      preTokens: this.usage.latest?.contextWindowUsedTokens,
    };
    this.operation = operation;
    this.projector.flush(true);
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        id: operation.id,
        type: "compaction",
        status: "loading",
        trigger,
        ...(operation.preTokens !== undefined ? { preTokens: operation.preTokens } : {}),
      },
    });
  }

  handleAutoEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "auto_compaction_end" }>,
  ): boolean {
    if (this.discardedEnds > 0) {
      this.discardedEnds -= 1;
      return false;
    }
    const operation = this.operation;
    if (
      operation?.trigger !== "auto" ||
      operation.turnId !== turn.turnId ||
      operation.generation !== turn.generation
    ) {
      return false;
    }
    if (event.action !== undefined && operation.action !== event.action) {
      this.retire("OMP emitted overlapping compactions");
      this.discardedEnds = 1;
      return false;
    }
    if (event.willRetry) {
      operation.retrying = true;
      return false;
    }
    if (operation.retrying) {
      operation.retrying = false;
      return false;
    }
    const state = event.aborted
      ? "canceled"
      : event.errorMessage
        ? "failed"
        : event.skipped
          ? "skipped"
          : "completed";
    this.finish(state, {
      tokensBefore: event.result?.tokensBefore ?? event.result?.preTokens,
      message: event.errorMessage,
    });
    return true;
  }

  finish(
    state: "completed" | "failed" | "canceled" | "skipped",
    options: { tokensBefore?: number | null; message?: string } = {},
  ): void {
    const operation = this.operation;
    if (!operation) return;
    this.operation = null;
    this.projector.flush(true);
    if (state === "completed") {
      this.usage.completeCompaction();
    }
    if (state !== "completed") {
      const defaultMessage =
        state === "failed"
          ? "OMP compaction failed"
          : state === "canceled"
            ? "OMP compaction canceled"
            : "OMP compaction skipped";
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          id: operation.id,
          type: "notification",
          level: state === "failed" ? "error" : "info",
          message: this.dataFilter.text(options.message ?? defaultMessage, 4_096),
        },
      });
      return;
    }
    const tokensBefore = options.tokensBefore ?? operation.preTokens;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        id: operation.id,
        type: "compaction",
        status: "completed",
        trigger: operation.trigger,
        ...(tokensBefore !== undefined ? { preTokens: tokensBefore } : {}),
      },
    });
  }

  retire(message: string): void {
    const operation = this.operation;
    if (!operation) return;
    this.operation = null;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: {
        id: operation.id,
        type: "compaction",
        status: "completed",
        trigger: operation.trigger,
      },
    });
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: { id: `${operation.id}:error`, type: "error", message },
    });
  }

  resetDiscardedEnds(): void {
    this.discardedEnds = 0;
  }
}
