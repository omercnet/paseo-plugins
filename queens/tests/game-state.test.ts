import { describe, expect, test } from "vitest";
import {
  createGameState,
  type GameAction,
  type GameState,
  gameReducer,
  PUZZLES,
  type Puzzle,
} from "../client/game";

const puzzle = PUZZLES[0];
const solution = [0, 9, 13, 23, 26, 34] as const;
const knownSolutions = { [puzzle.id]: solution };

const hintPuzzle: Puzzle = {
  id: "hint-fixture",
  size: 4,
  regions: [0, 1, 1, 1, 0, 0, 2, 1, 3, 0, 2, 2, 3, 3, 3, 2],
};
const hintSolution = [2, 4, 11, 13] as const;

function activeProgress(state: GameState) {
  return state.progress[state.activePuzzleIndex];
}

function reduce(state: GameState, action: GameAction): GameState {
  return gameReducer(state, action);
}

function markCells(state: GameState, indexes: readonly number[], now: number): GameState {
  return reduce(state, { type: "set-cells", indexes, state: "marked", now });
}

describe("game state transitions", () => {
  test("sets cells immutably and undoes one transition at a time", () => {
    const initial = createGameState([puzzle], knownSolutions);
    const excluded = reduce(initial, {
      type: "set-cells",
      indexes: [5, 6],
      state: "excluded",
      now: 10,
    });
    const marked = reduce(excluded, { type: "set-cells", indexes: [5], state: "marked", now: 20 });
    const empty = reduce(marked, { type: "set-cells", indexes: [5], state: "empty", now: 30 });
    const undone = reduce(empty, { type: "undo", now: 40 });

    expect(activeProgress(initial).cells[5]).toBe("empty");
    expect(activeProgress(excluded).cells[5]).toBe("excluded");
    expect(activeProgress(excluded).cells[6]).toBe("excluded");
    expect(activeProgress(excluded).history).toHaveLength(1);
    expect(activeProgress(marked).cells[5]).toBe("marked");
    expect(activeProgress(empty).cells[5]).toBe("empty");
    expect(activeProgress(undone).cells[5]).toBe("marked");
    expect(excluded).not.toBe(initial);
    expect(activeProgress(excluded).cells).not.toBe(activeProgress(initial).cells);
  });

  test("treats reset as one undoable transition and clears its timer", () => {
    const initial = createGameState([puzzle], knownSolutions);
    const played = reduce(initial, {
      type: "set-cells",
      indexes: [4],
      state: "excluded",
      now: 100,
    });
    const advanced = reduce(played, { type: "tick", now: 160 });
    const reset = reduce(advanced, { type: "reset", now: 200 });

    expect(activeProgress(reset).cells.every((cell) => cell === "empty")).toBe(true);
    expect(activeProgress(reset).timer).toEqual({
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      lastTickAt: null,
    });

    const restored = reduce(reset, { type: "undo", now: 240 });
    expect(activeProgress(restored).cells[4]).toBe("excluded");
    expect(activeProgress(restored).timer).toEqual({
      startedAt: 100,
      completedAt: null,
      elapsedMs: 100,
      lastTickAt: 240,
    });

    const beforePlay = reduce(restored, { type: "undo", now: 250 });
    expect(activeProgress(beforePlay).cells[4]).toBe("empty");
  });

  test("treats a hint as one undoable transition", () => {
    const initial = createGameState([hintPuzzle], { [hintPuzzle.id]: hintSolution });
    const hinted = reduce(initial, { type: "hint", now: 10 });
    const undone = reduce(hinted, { type: "undo", now: 20 });

    expect(activeProgress(hinted).cells[2]).toBe("marked");
    expect(activeProgress(undone).cells).toEqual(activeProgress(initial).cells);
  });
});

describe("deterministic hints", () => {
  test("fixes the first conflict before an earlier non-conflicting incorrect mark", () => {
    const initial = createGameState([hintPuzzle], { [hintPuzzle.id]: hintSolution });
    const withMarks = markCells(initial, [0, 10, 11], 10);
    const hinted = reduce(withMarks, { type: "hint", now: 20 });

    expect(activeProgress(hinted).cells[0]).toBe("marked");
    expect(activeProgress(hinted).cells[10]).toBe("empty");
    expect(activeProgress(hinted).cells[11]).toBe("marked");
  });

  test("removes the first incorrect mark when there are no conflicts", () => {
    const initial = createGameState([hintPuzzle], { [hintPuzzle.id]: hintSolution });
    const withIncorrectMark = markCells(initial, [0], 10);
    const hinted = reduce(withIncorrectMark, { type: "hint", now: 20 });

    expect(activeProgress(hinted).cells[0]).toBe("empty");
    expect(activeProgress(hinted).cells[2]).toBe("empty");
  });

  test("marks the first missing solution cell in row-major order", () => {
    const initial = createGameState([hintPuzzle], { [hintPuzzle.id]: hintSolution });
    const hinted = reduce(initial, { type: "hint", now: 10 });

    expect(activeProgress(hinted).cells[2]).toBe("marked");
    expect(activeProgress(hinted).cells[4]).toBe("empty");
  });
});

describe("puzzle navigation", () => {
  test("stops at bank boundaries and retains progress for each puzzle", () => {
    const secondPuzzle: Puzzle = { ...puzzle, id: "second-puzzle" };
    const initial = createGameState([puzzle, secondPuzzle], {
      [puzzle.id]: solution,
      [secondPuzzle.id]: solution,
    });
    const changedFirst = reduce(initial, {
      type: "set-cells",
      indexes: [3],
      state: "excluded",
      now: 10,
    });
    const atSecond = reduce(changedFirst, { type: "select-puzzle", index: 1, now: 15 });
    const changedSecond = reduce(atSecond, {
      type: "set-cells",
      indexes: [8],
      state: "excluded",
      now: 20,
    });
    const pastEnd = reduce(changedSecond, { type: "select-puzzle", index: 2, now: 25 });
    const atFirst = reduce(pastEnd, { type: "select-puzzle", index: 0, now: 30 });
    const beforeStart = reduce(atFirst, { type: "select-puzzle", index: -1, now: 35 });

    expect(pastEnd.activePuzzleIndex).toBe(1);
    expect(activeProgress(pastEnd).cells[8]).toBe("excluded");
    expect(beforeStart.activePuzzleIndex).toBe(0);
    expect(activeProgress(beforeStart).cells[3]).toBe("excluded");
    expect(beforeStart.progress[1].cells[8]).toBe("excluded");
  });
});

describe("timestamp-based timer", () => {
  test("starts on the first board change and clamps clock rollback", () => {
    const initial = createGameState([puzzle], knownSolutions);
    const idleTick = reduce(initial, { type: "tick", now: 50 });
    const started = reduce(idleTick, {
      type: "set-cells",
      indexes: [1],
      state: "excluded",
      now: 100,
    });
    const rolledBack = reduce(started, { type: "tick", now: 80 });
    const advanced = reduce(rolledBack, { type: "tick", now: 130 });

    expect(activeProgress(idleTick).timer.startedAt).toBeNull();
    expect(activeProgress(started).timer).toEqual({
      startedAt: 100,
      completedAt: null,
      elapsedMs: 0,
      lastTickAt: 100,
    });
    expect(activeProgress(rolledBack).timer.elapsedMs).toBe(0);
    expect(activeProgress(advanced).timer.elapsedMs).toBe(30);
  });

  test("stops on completion and resumes safely when completion is undone", () => {
    const initial = createGameState([puzzle], knownSolutions);
    const almostSolved = markCells(initial, solution.slice(0, -1), 100);
    const lastIndex = solution.at(-1);
    if (lastIndex === undefined) {
      throw new Error("The solution must contain at least one cell");
    }
    const solved = reduce(almostSolved, {
      type: "set-cells",
      indexes: [lastIndex],
      state: "marked",
      now: 200,
    });
    const afterIdleTick = reduce(solved, { type: "tick", now: 500 });

    expect(activeProgress(solved).solved).toBe(true);
    expect(activeProgress(solved).timer).toEqual({
      startedAt: 100,
      completedAt: 200,
      elapsedMs: 100,
      lastTickAt: null,
    });
    expect(afterIdleTick).toBe(solved);

    const resumed = reduce(solved, { type: "undo", now: 150 });
    const rollbackTick = reduce(resumed, { type: "tick", now: 190 });
    const forwardTick = reduce(rollbackTick, { type: "tick", now: 230 });

    expect(activeProgress(resumed).solved).toBe(false);
    expect(activeProgress(resumed).timer.completedAt).toBeNull();
    expect(activeProgress(resumed).timer.lastTickAt).toBe(200);
    expect(activeProgress(rollbackTick).timer.elapsedMs).toBe(100);
    expect(activeProgress(forwardTick).timer.elapsedMs).toBe(130);
  });
});
