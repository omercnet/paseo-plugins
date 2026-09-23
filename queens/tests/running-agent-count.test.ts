import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: vi.fn() }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: vi.fn() }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    absoluteFillObject: {},
    create<T>(styles: T): T {
      return styles;
    },
    hairlineWidth: 1,
  },
  Text: "Text",
  View: "View",
}));
vi.mock("../client/completion-feedback", () => ({ CompletionFeedback: () => null }));
vi.mock("../client/game", () => ({ findConflicts: () => new Set() }));
vi.mock("../client/game-controls", () => ({ GameControls: () => null }));
vi.mock("../client/game-mark", () => ({ GameMark: () => null }));
vi.mock("../client/puzzle-selector", () => ({ PuzzleSelector: () => null }));
vi.mock("../client/queens-board", () => ({ QueensBoard: () => null }));
vi.mock("../client/use-persisted-game", () => ({ usePersistedGame: vi.fn() }));
vi.mock("../client/use-puzzle-catalog", () => ({ usePuzzleCatalog: vi.fn() }));

import { observeRunningAgentCount } from "../client/queens-surface";

afterEach(() => {
  vi.useRealTimers();
});

async function flushBootstrap() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Queens running agent count", () => {
  test("refreshes when an owned directory update adds a running agent", async () => {
    vi.useFakeTimers();
    let agents = [{ agent: { id: "idle", status: "idle" } }];
    let observer:
      | {
          snapshot(snapshot: unknown): void;
          update(message: { type: "agent_update"; payload: unknown }): void;
        }
      | undefined;
    const release = vi.fn().mockResolvedValue(undefined);
    const firstPage = {
      entries: agents,
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const paseo = {
      agents: {
        async list(options?: { subscribe?: object }) {
          if (options?.subscribe) {
            return {
              ...firstPage,
              subscription: {
                subscribe(nextObserver: typeof observer) {
                  observer = nextObserver;
                  nextObserver?.snapshot(firstPage);
                  return () => {
                    observer = undefined;
                  };
                },
                release,
              },
            };
          }
          return {
            entries: agents,
            pageInfo: { hasMore: false, nextCursor: null },
          };
        },
      },
    };
    const counts: number[] = [];

    const cleanup = observeRunningAgentCount(
      paseo as Parameters<typeof observeRunningAgentCount>[0],
      (count) => counts.push(count),
    );
    await flushBootstrap();
    expect(counts).toEqual([0]);

    agents = [
      { agent: { id: "idle", status: "idle" } },
      { agent: { id: "running", status: "running" } },
    ];
    observer?.update({ type: "agent_update", payload: {} });
    await flushBootstrap();

    expect(counts).toEqual([0, 1]);

    cleanup();
    await flushBootstrap();
    expect(release).toHaveBeenCalledOnce();
  });

  test("aborts a pending owned observation during cleanup", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = Promise.withResolvers<never>();
    const paseo = {
      agents: {
        list(options: { signal?: AbortSignal }) {
          signal = options.signal;
          return pending.promise;
        },
      },
    };

    const cleanup = observeRunningAgentCount(
      paseo as unknown as Parameters<typeof observeRunningAgentCount>[0],
      () => undefined,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    cleanup();

    expect(signal?.aborted).toBe(true);
  });
});
