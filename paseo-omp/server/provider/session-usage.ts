import type { ProviderEvent, ProviderUsage } from "@getpaseo/plugin/server/provider";
import type { OmpRuntimeSession } from "./omp-rpc";
import type { OmpSessionState, OmpSessionStats } from "./omp-rpc-protocol";
import type { ActiveTurn } from "./session-terminal";
import type { OmpTimelineScheduler } from "./timeline-projector";

const USAGE_POLL_MS = 1_000;

interface UsageContext {
  closed: boolean;
  runtimeDead: boolean;
  generation: number;
  runtime: OmpRuntimeSession;
  activeTurn: ActiveTurn | null;
}

type Emit = (event: ProviderEvent) => void;
type ReadContext = () => UsageContext;
type IsPollable = (turn: ActiveTurn) => boolean;

interface UsageSample {
  turn: ActiveTurn;
  generation: number;
  runtime: OmpRuntimeSession;
  epoch: number;
  sequence: number;
  promise: Promise<OmpSessionState | undefined>;
}

function usageFrom(
  state: OmpSessionState | undefined,
  stats: OmpSessionStats | undefined,
): ProviderUsage | undefined {
  if (!state?.contextUsage && !stats) return undefined;
  const stateContext = state?.contextUsage;
  const statsContext = stats?.contextUsage;
  const modelCapacity = state?.model?.contextWindow;
  const inputTokens = stats?.tokens?.input;
  const cachedInputTokens = stats?.tokens?.cacheRead;
  const outputTokens = stats?.tokens?.output;
  const totalCostUsd = stats?.cost;
  const contextTokens =
    typeof stateContext?.tokens === "number"
      ? stateContext.tokens
      : typeof statsContext?.tokens === "number"
        ? statsContext.tokens
        : undefined;
  const contextWindow =
    typeof stateContext?.contextWindow === "number" && stateContext.contextWindow > 0
      ? stateContext.contextWindow
      : typeof statsContext?.contextWindow === "number" && statsContext.contextWindow > 0
        ? statsContext.contextWindow
        : typeof modelCapacity === "number" && modelCapacity > 0
          ? modelCapacity
          : undefined;
  const usage: ProviderUsage = {
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof totalCostUsd === "number" ? { totalCostUsd } : {}),
    ...(contextTokens !== undefined ? { contextWindowUsedTokens: contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindowMaxTokens: contextWindow } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export class OmpSessionUsage {
  private epoch = 0;
  private sequence = 0;
  private sample: UsageSample | null = null;
  private lastUsage: ProviderUsage | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler,
    private readonly readContext: ReadContext,
    private readonly isPollable: IsPollable,
  ) {}

  get latest(): ProviderUsage | null {
    return this.lastUsage;
  }

  private ownsSample(turn: ActiveTurn, generation: number, runtime: OmpRuntimeSession): boolean {
    const context = this.readContext();
    return (
      !context.closed &&
      !context.runtimeDead &&
      !turn.terminal &&
      generation === context.generation &&
      runtime === context.runtime &&
      context.activeTurn === turn
    );
  }

  publishSnapshot(
    turn: ActiveTurn,
    minimumEpoch = this.epoch,
    minimumSequence = turn.usageSampleFloor,
  ): Promise<OmpSessionState | undefined> {
    const { generation, runtime } = this.readContext();
    if (!this.ownsSample(turn, generation, runtime)) return Promise.resolve(undefined);
    const current = this.sample;
    if (current) {
      if (
        current.turn === turn &&
        current.generation === generation &&
        current.runtime === runtime &&
        current.epoch >= minimumEpoch &&
        current.sequence >= minimumSequence
      ) {
        return current.promise;
      }
      return current.promise.then(() => {
        if (!this.ownsSample(turn, generation, runtime)) return undefined;
        return this.publishSnapshot(turn, minimumEpoch, minimumSequence);
      });
    }
    const epoch = this.epoch;
    const sequence = ++this.sequence;
    const promise = Promise.allSettled([runtime.getState(), runtime.getSessionStats()]).then(
      ([stateResult, statsResult]) => {
        if (
          !this.ownsSample(turn, generation, runtime) ||
          epoch !== this.epoch ||
          epoch < minimumEpoch ||
          sequence < turn.usageSampleFloor ||
          sequence < minimumSequence
        ) {
          return undefined;
        }
        const state = stateResult.status === "fulfilled" ? stateResult.value : undefined;
        const stats = statsResult.status === "fulfilled" ? statsResult.value : undefined;
        const usage = usageFrom(state, stats);
        if (usage) {
          this.lastUsage = usage;
          this.emit({
            type: "session.usage",
            sessionId: this.sessionId,
            turnId: turn.turnId,
            usage,
          });
        }
        return state;
      },
    );
    this.sample = { turn, generation, runtime, epoch, sequence, promise };
    void promise.finally(() => {
      if (this.sample?.promise === promise) this.sample = null;
    });
    return promise;
  }

  async boundedSnapshot(turn: ActiveTurn, timeoutMs: number): Promise<OmpSessionState | undefined> {
    const timeout = Promise.withResolvers<undefined>();
    const timer = this.scheduler.set(() => timeout.resolve(undefined), timeoutMs);
    try {
      return await Promise.race([this.publishSnapshot(turn), timeout.promise]);
    } finally {
      this.scheduler.clear(timer);
    }
  }

  async boundedTerminalState(
    turn: ActiveTurn,
    timeoutMs: number,
  ): Promise<OmpSessionState | undefined> {
    const { generation, runtime } = this.readContext();
    const timeout = Promise.withResolvers<undefined>();
    const timer = this.scheduler.set(() => timeout.resolve(undefined), timeoutMs);
    try {
      const state = await Promise.race([runtime.getState(), timeout.promise]);
      return this.ownsSample(turn, generation, runtime) ? state : undefined;
    } catch {
      return undefined;
    } finally {
      this.scheduler.clear(timer);
    }
  }

  schedulePoll(turn: ActiveTurn, delayMs = USAGE_POLL_MS): void {
    if (!this.isPollable(turn) || turn.usagePollTimer !== undefined) return;
    turn.usagePollTimer = this.scheduler.set(() => {
      turn.usagePollTimer = undefined;
      this.poll(turn);
    }, delayMs);
  }

  poll(turn: ActiveTurn): void {
    if (!this.isPollable(turn) || turn.usagePoll) return;
    const poll = this.publishSnapshot(turn).then(() => undefined);
    turn.usagePoll = poll;
    void poll.finally(() => {
      if (turn.usagePoll === poll) turn.usagePoll = undefined;
      this.schedulePoll(turn);
    });
  }

  stopPoll(turn: ActiveTurn): void {
    if (turn.usagePollTimer === undefined) return;
    this.scheduler.clear(turn.usagePollTimer);
    turn.usagePollTimer = undefined;
  }

  invalidateBeforeNextSample(turn: ActiveTurn): void {
    turn.usageSampleFloor = this.sequence + 1;
    if (this.sample?.turn === turn && this.sample.sequence < turn.usageSampleFloor) {
      this.sample = null;
    }
  }

  completeCompaction(): void {
    this.epoch += 1;
    const staleSample = this.sample;
    if (staleSample && staleSample.epoch < this.epoch) {
      this.sample = null;
      staleSample.turn.usagePoll = undefined;
    }
    this.lastUsage = null;
  }
  clearLatest(): void {
    this.lastUsage = null;
  }

  clearSample(turn: ActiveTurn): void {
    if (this.sample?.turn === turn) this.sample = null;
  }

  reset(): void {
    this.sample = null;
    this.lastUsage = null;
  }
}
