import { beforeEach, describe, expect, test, vi } from "vitest";

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Instance = { slots: Slot[]; cursor: number; render: () => void; effects: (() => void)[] };

const runtime = vi.hoisted(() => ({ current: null as Instance | null }));

vi.mock("react", () => {
  const slot = (): Slot => {
    const instance = runtime.current as Instance;
    const index = instance.cursor++;
    instance.slots[index] ??= {};
    return instance.slots[index];
  };
  const changed = (s: Slot, deps?: readonly unknown[]) =>
    !deps || !s.deps || deps.some((dep, i) => !Object.is(dep, s.deps?.[i]));
  const useMemoLike = <T>(factory: () => T, deps: readonly unknown[]): T => {
    const s = slot();
    if (changed(s, deps)) {
      s.value = factory();
      s.deps = deps;
    }
    return s.value as T;
  };
  return {
    useRef: <T>(initial: T) => useMemoLike(() => ({ current: initial }), []),
    useCallback: <T>(fn: T, deps: readonly unknown[]) => useMemoLike(() => fn, deps),
    useState: <T>(initial: T | (() => T)) => {
      const instance = runtime.current as Instance;
      const s = slot();
      if (!("value" in s))
        s.value = typeof initial === "function" ? (initial as () => T)() : initial;
      const set = (next: T) => {
        if (Object.is(s.value, next)) return;
        s.value = next;
        instance.render();
      };
      return [s.value as T, set];
    },
    useEffect: (effect: () => (() => void) | undefined, deps?: readonly unknown[]) => {
      const instance = runtime.current as Instance;
      const s = slot();
      if (!changed(s, deps)) return;
      s.deps = deps;
      instance.effects.push(() => {
        s.cleanup?.();
        s.cleanup = effect() ?? undefined;
      });
    },
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});

const settingsHook = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => settingsHook.current }));

import { PUZZLES } from "../client/game";
import {
  disposePersistedGames,
  type PersistedGameSession,
  usePersistedGame,
} from "../client/use-persisted-game";
import { DEFAULT_GAME_SETTINGS } from "../shared/game-settings";

function mountHook(): {
  readonly session: () => Extract<PersistedGameSession, { status: "ready" }>;
  readonly rerender: () => void;
} {
  let result: PersistedGameSession;
  const instance: Instance = {
    slots: [],
    cursor: 0,
    effects: [],
    render() {
      for (let pass = 0; pass < 20; pass++) {
        instance.cursor = 0;
        instance.effects = [];
        runtime.current = instance;
        result = usePersistedGame("host:deck", [PUZZLES[0]]);
        runtime.current = null;
        if (instance.effects.length === 0) return;
        for (const effect of instance.effects) effect();
      }
    },
  };
  instance.render();
  const session = () => {
    if (result.status !== "ready") throw new Error("session is not ready");
    return result;
  };
  return { session, rerender: () => instance.render() };
}

describe("shared controller across hook instances", () => {
  beforeEach(() => disposePersistedGames());

  test("an instance keeps saving after another instance recovers the shared controller", async () => {
    const save = vi.fn(async () => true);
    const ready = {
      status: "ready",
      values: DEFAULT_GAME_SETTINGS,
      revision: "revision-1",
      saveError: null,
      save,
      reload: async () => {},
      reset: async () => true,
    };
    settingsHook.current = ready;
    const a = mountHook();
    const b = mountHook();

    await a.session().reload();
    settingsHook.current = { ...ready, revision: "revision-2" };
    a.rerender();
    b.rerender();
    b.session().dispatch({ type: "set-cells", indexes: [0], state: "marked", now: 1 });
    await Promise.resolve();

    expect(save).toHaveBeenCalled();
  });
});
