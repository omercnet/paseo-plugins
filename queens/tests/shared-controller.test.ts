import { beforeEach, describe, expect, test, vi } from "vitest";

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Instance = {
  slots: Slot[];
  cursor: number;
  render: () => void;
  schedule: () => void;
  effects: (() => void)[];
};

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
        instance.schedule();
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
    useSyncExternalStore: <T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
    ) => {
      const instance = runtime.current as Instance;
      const s = slot();
      if (changed(s, [subscribe])) {
        s.deps = [subscribe];
        instance.effects.push(() => {
          s.cleanup?.();
          s.cleanup = subscribe(() => instance.schedule());
        });
      }
      return getSnapshot();
    },
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

const TEST_PUZZLES = [PUZZLES[0]];
let renders = 0;
const mounted: Instance[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mountHook(): {
  readonly session: () => Extract<PersistedGameSession, { status: "ready" }>;
  readonly rerender: () => void;
} {
  let result: PersistedGameSession;
  let scheduled = false;
  const instance: Instance = {
    slots: [],
    cursor: 0,
    effects: [],
    schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        instance.render();
      });
    },
    render() {
      if (++renders > 50) throw new Error("render loop");
      for (let pass = 0; pass < 20; pass++) {
        instance.cursor = 0;
        instance.effects = [];
        runtime.current = instance;
        result = usePersistedGame("host:deck", TEST_PUZZLES);
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
  mounted.push(instance);
  return { session, rerender: () => instance.render() };
}

describe("shared controller across hook instances", () => {
  beforeEach(() => {
    disposePersistedGames();
    mounted.length = 0;
    renders = 0;
  });

  test("an instance re-acquires the shared controller after another instance reloads", async () => {
    let revision = 1;
    let stored: unknown;
    const base = {
      status: "ready",
      saveError: null,
      reload: async () => {},
      reset: async () => true,
    };
    const save = vi.fn(async (values: unknown) => {
      revision += 1;
      stored = { ...base, values, revision: `revision-${revision}`, save };
      return true;
    });
    settingsHook.current = { ...base, values: DEFAULT_GAME_SETTINGS, revision: "revision-1", save };
    const a = mountHook();
    const b = mountHook();

    b.session().dispatch({ type: "set-cells", indexes: [0], state: "marked", now: 1 });
    await flush();
    settingsHook.current = stored;
    for (const instance of mounted) instance.render();
    expect(save).toHaveBeenCalledTimes(1);

    await a.session().reload();
    await flush();
    b.session().dispatch({ type: "set-cells", indexes: [1], state: "marked", now: 2 });
    await flush();

    expect(save).toHaveBeenCalledTimes(2);
  });
});
