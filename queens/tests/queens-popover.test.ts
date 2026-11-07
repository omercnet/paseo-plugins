import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { afterEach, expect, test, vi } from "vitest";
import { createGameState, gameReducer, PUZZLES } from "../client/game";
import { QueensPopover } from "../client/queens-popover";

const hooks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: null as unknown,
  deps: null as unknown[] | null,
  cleanup: undefined as undefined | (() => void),
}));

// The popover has a single effect. Like React, rerun it only when a dependency changes.
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
  useEffect(effect: () => undefined | (() => void), deps: unknown[]) {
    if (hooks.deps?.every((value, index) => Object.is(value, deps[index]))) return;
    hooks.cleanup?.();
    hooks.deps = deps;
    hooks.cleanup = effect();
  },
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
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
vi.mock("../client/use-puzzle-catalog", () => ({
  usePuzzleCatalog: () => ({ deck: { key: "deck", puzzles: [], solutions: {} } }),
}));
// Like the real hook: a new session object on every render, with a stable dispatch.
vi.mock("../client/use-persisted-game", () => ({
  usePersistedGame: () => ({
    status: "ready",
    state: hooks.state,
    saving: false,
    dispatch: hooks.dispatch,
  }),
}));

afterEach(() => {
  hooks.deps = null;
  hooks.dispatch.mockClear();
  vi.useRealTimers();
});

test("popover timer keeps ticking every second while it re-renders faster than the tick", () => {
  vi.useFakeTimers({ now: 0 });
  hooks.state = gameReducer(createGameState([PUZZLES[0]]), {
    type: "set-cells",
    indexes: [0],
    state: "marked",
    now: 0,
  });
  const props = {
    host: { id: "host" },
    layout: { compact: true },
    theme: { colors: {} },
  } as unknown as PluginButtonContentProps;
  const game = QueensPopover(props);

  game.type(game.props);
  for (let rerender = 0; rerender < 6; rerender++) {
    vi.advanceTimersByTime(500);
    game.type(game.props);
  }

  expect(hooks.dispatch.mock.calls).toEqual([
    [{ type: "tick", now: 1_000 }],
    [{ type: "tick", now: 2_000 }],
    [{ type: "tick", now: 3_000 }],
  ]);
});
