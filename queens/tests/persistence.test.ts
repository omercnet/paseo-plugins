import { describe, expect, test, vi } from "vitest";
import { type CellState, createGameState, gameReducer, PUZZLES } from "../client/game";
import {
  createGamePersistenceController,
  type GamePersistenceController,
  gameSettingsFromState,
  gameStateFromSettings,
  type SaveGameSettings,
} from "../client/use-persisted-game";
import type { GameSettings } from "../shared/game-settings";
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS } from "../shared/game-settings";

vi.mock("@getpaseo/plugin/client", () => ({ useSettings: vi.fn() }));

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

type SaveCall = {
  readonly values: GameSettings;
  readonly revision: string;
  readonly result: Deferred<boolean>;
};

const puzzle = PUZZLES[0];
const solution = [0, 9, 13, 23, 26, 34] as const;
const knownSolutions = { [puzzle.id]: solution };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function recordingSave(): { readonly calls: SaveCall[]; readonly save: SaveGameSettings } {
  const calls: SaveCall[] = [];
  return {
    calls,
    save(values, revision) {
      const result = deferred<boolean>();
      calls.push({ values, revision, result });
      return result.promise;
    },
  };
}

async function flushSaveCompletion(): Promise<void> {
  await Promise.resolve();
}

function controller(save: SaveGameSettings): GamePersistenceController {
  return createGamePersistenceController({
    settings: DEFAULT_GAME_SETTINGS,
    revision: "revision-1",
    save,
    puzzles: [puzzle],
    knownSolutions,
    now: 0,
  });
}

describe("persisted game conversion", () => {
  test("round trips stable puzzle ids, progress, timestamps, hints, and records", () => {
    const secondPuzzle = PUZZLES[1];
    const firstCells = Array<CellState>(puzzle.size * puzzle.size).fill("empty");
    const secondCells = Array<CellState>(secondPuzzle.size * secondPuzzle.size).fill("empty");
    firstCells[0] = "marked";
    secondCells[5] = "excluded";

    const settings: GameSettings = {
      boardSize: 6,
      difficulty: "easy",
      currentPuzzleId: secondPuzzle.id,
      puzzleStates: {
        [puzzle.id]: {
          cells: firstCells,
          startedAtMs: 1_000,
          completedAtMs: 1_750,
          hintUsed: true,
        },
        [secondPuzzle.id]: {
          cells: secondCells,
          startedAtMs: 2_000,
          completedAtMs: null,
          hintUsed: false,
        },
        "retired-puzzle": {
          cells: ["excluded"],
          startedAtMs: null,
          completedAtMs: null,
          hintUsed: true,
        },
      },
      records: {
        [puzzle.id]: { completions: 3, bestTimeMs: 750 },
        "retired-puzzle": { completions: 8, bestTimeMs: 400 },
      },
    };

    const hydrated = gameStateFromSettings(settings, [secondPuzzle, puzzle], {}, 5_000);
    const serialized = gameSettingsFromState(hydrated.state, hydrated, settings);

    expect(hydrated.state.activePuzzleIndex).toBe(0);
    expect(hydrated.state.progress[0].cells).toEqual(secondCells);
    expect(hydrated.state.progress[0].timer).toEqual({
      startedAt: 2_000,
      completedAt: null,
      elapsedMs: 3_000,
      lastTickAt: 5_000,
    });
    expect(hydrated.state.progress[1].cells).toEqual(firstCells);
    expect(hydrated.state.progress[1].history).toEqual([]);
    expect(serialized).toEqual(settings);
    expect(Object.keys(serialized.puzzleStates[puzzle.id])).toEqual([
      "cells",
      "startedAtMs",
      "completedAtMs",
      "hintUsed",
    ]);
  });

  test("omits untouched puzzles from persisted settings", () => {
    const secondPuzzle = { ...puzzle, id: "second-pristine-puzzle" };
    const state = createGameState([puzzle, secondPuzzle], {
      [puzzle.id]: solution,
      [secondPuzzle.id]: solution,
    });
    const serialized = gameSettingsFromState(state, { hintUsed: {}, records: {} });

    expect(serialized.puzzleStates).toEqual({});
  });

  test("caps old progress while retaining the active puzzle", () => {
    const retiredStates = Object.fromEntries(
      Array.from({ length: GAME_SETTINGS_LIMITS.puzzles + 1 }, (_, index) => [
        `retired-${index}`,
        {
          cells: ["excluded" as const],
          startedAtMs: index,
          completedAtMs: null,
          hintUsed: false,
        },
      ]),
    );
    const retiredRecords = Object.fromEntries(
      Array.from({ length: GAME_SETTINGS_LIMITS.puzzles + 1 }, (_, index) => [
        `retired-${index}`,
        { completions: 1, bestTimeMs: index },
      ]),
    );
    const baseline: GameSettings = {
      ...DEFAULT_GAME_SETTINGS,
      puzzleStates: retiredStates,
      records: retiredRecords,
    };
    const initial = createGameState([puzzle], knownSolutions);
    const played = gameReducer(initial, {
      type: "set-cells",
      indexes: [0],
      state: "excluded",
      now: 10,
    });
    const serialized = gameSettingsFromState(played, { hintUsed: {}, records: {} }, baseline);

    expect(Object.keys(serialized.puzzleStates)).toHaveLength(GAME_SETTINGS_LIMITS.puzzles);
    expect(Object.keys(serialized.records)).toHaveLength(GAME_SETTINGS_LIMITS.puzzles);
    expect(serialized.puzzleStates[puzzle.id]).toBeDefined();
    expect(serialized.puzzleStates["retired-0"]).toBeUndefined();
  });
});

describe("serialized game saves", () => {
  test("coalesces rapid actions behind one revision-checked in-flight save", async () => {
    const transport = recordingSave();
    const session = controller(transport.save);

    session.dispatch({ type: "set-cells", indexes: [0], state: "marked", now: 20 });
    session.dispatch({ type: "set-cells", indexes: [1], state: "excluded", now: 30 });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].revision).toBe("revision-1");
    expect(transport.calls[0].values.puzzleStates[puzzle.id]?.cells[0]).toBe("marked");

    transport.calls[0].result.resolve(true);
    await flushSaveCompletion();
    expect(transport.calls).toHaveLength(1);
    expect(session.getSnapshot().saving).toBe(true);

    session.synchronize(transport.calls[0].values, "revision-2");

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].revision).toBe("revision-2");
    expect(transport.calls[1].values.puzzleStates[puzzle.id]?.cells.slice(0, 2)).toEqual([
      "marked",
      "excluded",
    ]);
  });

  test("keeps undo history when the host acknowledges a successful save", async () => {
    const transport = recordingSave();
    const session = controller(transport.save);

    session.dispatch({ type: "set-cells", indexes: [0], state: "excluded", now: 10 });
    expect(session.getSnapshot().state.progress[0].history).toHaveLength(1);
    expect(transport.calls[0].values.puzzleStates[puzzle.id]).not.toHaveProperty("history");
    expect(transport.calls[0].values.puzzleStates[puzzle.id]).not.toHaveProperty("timer");

    transport.calls[0].result.resolve(true);
    await flushSaveCompletion();
    session.dispatch({ type: "tick", now: 50 });
    session.synchronize(transport.calls[0].values, "revision-2", null, 50);

    expect(session.getSnapshot().state.progress[0].history).toHaveLength(1);
    expect(session.getSnapshot().state.progress[0].timer.elapsedMs).toBe(40);
    session.dispatch({ type: "undo", now: 60 });
    expect(session.getSnapshot().state.progress[0].cells[0]).toBe("empty");
    expect(session.getSnapshot().state.progress[0].history).toHaveLength(0);
  });

  test("hydrates a newer external revision when there is no local draft", () => {
    const transport = recordingSave();
    const session = controller(transport.save);
    const externalCells = Array<CellState>(puzzle.size * puzzle.size).fill("empty");
    externalCells[3] = "marked";
    const externalSettings: GameSettings = {
      ...DEFAULT_GAME_SETTINGS,
      currentPuzzleId: puzzle.id,
      puzzleStates: {
        [puzzle.id]: {
          cells: externalCells,
          startedAtMs: 20,
          completedAtMs: null,
          hintUsed: true,
        },
      },
    };

    session.synchronize(externalSettings, "revision-2", null, 30);

    expect(session.getSnapshot().state.progress[0].cells[3]).toBe("marked");
    expect(session.getSnapshot().state.progress[0].history).toEqual([]);
    expect(session.getSnapshot().hintUsed).toBe(true);
  });

  test("rebases an unsaved draft after its revision becomes stale", async () => {
    const transport = recordingSave();
    const session = controller(transport.save);

    session.dispatch({ type: "set-cells", indexes: [4], state: "excluded", now: 10 });
    session.synchronize(DEFAULT_GAME_SETTINGS, "revision-2", null, 20);
    expect(session.getSnapshot().state.progress[0].cells[4]).toBe("excluded");

    transport.calls[0].result.resolve(false);
    await flushSaveCompletion();

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].revision).toBe("revision-2");
    expect(transport.calls[1].values.puzzleStates[puzzle.id]?.cells[4]).toBe("excluded");
    expect(session.getSnapshot().saveError).toBeNull();
  });

  test("does not enqueue timer ticks", async () => {
    const transport = recordingSave();
    const session = controller(transport.save);

    session.dispatch({ type: "set-cells", indexes: [1], state: "excluded", now: 10 });
    session.dispatch({ type: "tick", now: 50 });
    expect(session.getSnapshot().state.progress[0].timer.elapsedMs).toBe(40);

    transport.calls[0].result.resolve(true);
    await flushSaveCompletion();
    session.synchronize(transport.calls[0].values, "revision-2");

    expect(transport.calls).toHaveLength(1);
  });

  test("keeps the optimistic draft and reports actionable recovery after save false", async () => {
    const transport = recordingSave();
    const session = controller(transport.save);

    session.dispatch({ type: "set-cells", indexes: [4], state: "excluded", now: 10 });
    transport.calls[0].result.resolve(false);
    await flushSaveCompletion();

    expect(session.getSnapshot().state.progress[0].cells[4]).toBe("excluded");
    expect(session.getSnapshot().saving).toBe(false);
    expect(session.getSnapshot().saveError).toContain("not saved");
    expect(session.getSnapshot().saveError).toContain("still available");
    expect(session.getSnapshot().saveError).toContain("Reload saved progress");

    session.replace(DEFAULT_GAME_SETTINGS, "revision-2", 20);
    expect(session.getSnapshot().state.progress[0].cells[4]).toBe("empty");
    expect(session.getSnapshot().saveError).toBeNull();
  });

  test("tracks hint usage and only records unassisted completions", async () => {
    const unassistedTransport = recordingSave();
    const unassisted = controller(unassistedTransport.save);
    for (const index of solution) {
      unassisted.dispatch({
        type: "set-cells",
        indexes: [index],
        state: "marked",
        now: index === 34 ? 110 : 10,
      });
    }

    unassistedTransport.calls[0].result.resolve(true);
    await flushSaveCompletion();
    unassisted.synchronize(unassistedTransport.calls[0].values, "revision-2");

    expect(unassistedTransport.calls[1].values.records[puzzle.id]).toEqual({
      completions: 1,
      bestTimeMs: 100,
    });
    expect(unassistedTransport.calls[1].values.puzzleStates[puzzle.id]?.hintUsed).toBe(false);

    const hintedTransport = recordingSave();
    const hinted = controller(hintedTransport.save);
    hinted.dispatch({ type: "hint", now: 10 });
    expect(hinted.getSnapshot().hintUsed).toBe(true);
    expect(hintedTransport.calls[0].values.puzzleStates[puzzle.id]?.hintUsed).toBe(true);
    for (const index of solution.slice(1)) {
      hinted.dispatch({
        type: "set-cells",
        indexes: [index],
        state: "marked",
        now: index === 34 ? 110 : 10,
      });
    }

    hintedTransport.calls[0].result.resolve(true);
    await flushSaveCompletion();
    hinted.synchronize(hintedTransport.calls[0].values, "revision-2");

    expect(hintedTransport.calls[1].values.puzzleStates[puzzle.id]?.hintUsed).toBe(true);
    expect(hintedTransport.calls[1].values.records[puzzle.id]).toBeUndefined();
  });

  test("fences pending work when an old host controller is disposed", async () => {
    const oldTransport = recordingSave();
    const oldHost = controller(oldTransport.save);
    let oldNotifications = 0;
    oldHost.subscribe(() => {
      oldNotifications += 1;
    });
    oldHost.dispatch({ type: "set-cells", indexes: [2], state: "excluded", now: 10 });
    oldNotifications = 0;
    oldHost.dispose();

    const newTransport = recordingSave();
    const newHost = controller(newTransport.save);
    newHost.dispatch({ type: "set-cells", indexes: [7], state: "excluded", now: 20 });
    const newHostDraft = newHost.getSnapshot();

    oldTransport.calls[0].result.resolve(false);
    await flushSaveCompletion();

    expect(oldNotifications).toBe(0);
    expect(newHost.getSnapshot()).toBe(newHostDraft);
    expect(newHost.getSnapshot().state.progress[0].cells[7]).toBe("excluded");
    expect(newHost.getSnapshot().saveError).toBeNull();
  });
});
