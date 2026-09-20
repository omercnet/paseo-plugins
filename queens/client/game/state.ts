import { createEmptyCells, findConflicts, isSolved, setCellStates } from "./engine";
import type { CellState, Puzzle } from "./types";

export interface TimerState {
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly elapsedMs: number;
  readonly lastTickAt: number | null;
}

export interface GameHistoryEntry {
  readonly cells: readonly CellState[];
  readonly timer: TimerState;
  readonly restoresTimer: boolean;
}

export interface PuzzleProgress {
  readonly cells: readonly CellState[];
  readonly history: readonly GameHistoryEntry[];
  readonly solved: boolean;
  readonly timer: TimerState;
}

export interface GameState {
  readonly puzzles: readonly Puzzle[];
  readonly solutions: readonly (readonly number[])[];
  readonly progress: readonly PuzzleProgress[];
  readonly activePuzzleIndex: number;
}

export type PuzzleSolution = readonly number[];

export type GameAction =
  | {
      readonly type: "set-cells";
      readonly indexes: readonly number[];
      readonly state: CellState;
      readonly now: number;
    }
  | { readonly type: "undo"; readonly now: number }
  | { readonly type: "reset"; readonly now: number }
  | { readonly type: "hint"; readonly now: number }
  | { readonly type: "select-puzzle"; readonly index: number; readonly now: number }
  | { readonly type: "tick"; readonly now: number };

const EMPTY_TIMER: TimerState = {
  startedAt: null,
  completedAt: null,
  elapsedMs: 0,
  lastTickAt: null,
};

function assertTimestamp(now: number): void {
  if (!Number.isFinite(now)) throw new RangeError("Timestamp must be finite.");
}

function advanceTimer(timer: TimerState, now: number): TimerState {
  assertTimestamp(now);
  if (timer.lastTickAt === null) return timer;

  const nextTickAt = Math.max(timer.lastTickAt, now);
  if (nextTickAt === timer.lastTickAt) return timer;

  return {
    ...timer,
    elapsedMs: timer.elapsedMs + nextTickAt - timer.lastTickAt,
    lastTickAt: nextTickAt,
  };
}

function startTimer(timer: TimerState, now: number): TimerState {
  assertTimestamp(now);
  if (timer.startedAt !== null) return advanceTimer(timer, now);

  return {
    startedAt: now,
    completedAt: null,
    elapsedMs: 0,
    lastTickAt: now,
  };
}

function stopTimer(timer: TimerState, now: number): TimerState {
  const advanced = advanceTimer(timer, now);
  if (advanced.startedAt === null) return advanced;

  return {
    ...advanced,
    completedAt: advanced.lastTickAt ?? Math.max(advanced.startedAt, now),
    lastTickAt: null,
  };
}

function resumeTimer(timer: TimerState, now: number): TimerState {
  assertTimestamp(now);
  if (timer.startedAt === null) return timer;

  const latestTimestamp = timer.completedAt ?? timer.lastTickAt ?? timer.startedAt;
  return {
    ...timer,
    completedAt: null,
    lastTickAt: Math.max(latestTimestamp, now),
  };
}

function firstSolution(puzzle: Puzzle): readonly number[] {
  // This also validates the puzzle before the one-time solution search.
  isSolved(puzzle, createEmptyCells(puzzle.size));

  const usedColumns = new Uint8Array(puzzle.size);
  const usedRegions = new Uint8Array(puzzle.size);
  const solution = Array<number>(puzzle.size).fill(-1);

  function search(row: number, previousColumn: number): boolean {
    if (row === puzzle.size) return true;

    for (let column = 0; column < puzzle.size; column += 1) {
      const index = row * puzzle.size + column;
      const region = puzzle.regions[index];
      if (
        usedColumns[column] === 1 ||
        usedRegions[region] === 1 ||
        (row > 0 && Math.abs(column - previousColumn) <= 1)
      ) {
        continue;
      }

      usedColumns[column] = 1;
      usedRegions[region] = 1;
      solution[row] = index;
      if (search(row + 1, column)) return true;
      usedColumns[column] = 0;
      usedRegions[region] = 0;
    }

    return false;
  }

  if (!search(0, -2)) throw new RangeError(`Puzzle ${puzzle.id} has no solution.`);
  return solution;
}

function normalizeSolution(puzzle: Puzzle, solution: PuzzleSolution): readonly number[] {
  const cells = createEmptyCells(puzzle.size);
  for (const index of solution) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= cells.length ||
      cells[index] === "marked"
    ) {
      throw new RangeError(`Puzzle ${puzzle.id} has an invalid known solution.`);
    }
    cells[index] = "marked";
  }

  if (!isSolved(puzzle, cells))
    throw new RangeError(`Puzzle ${puzzle.id} has an invalid known solution.`);
  return [...solution].sort((left, right) => left - right);
}

export function createGameState(
  puzzles: readonly Puzzle[],
  knownSolutions: Readonly<Record<string, PuzzleSolution>> = {},
): GameState {
  if (puzzles.length === 0) throw new RangeError("The puzzle bank must not be empty.");
  if (new Set(puzzles.map((puzzle) => puzzle.id)).size !== puzzles.length) {
    throw new RangeError("Puzzle ids must be unique.");
  }

  const bank = puzzles.slice();
  const solutions = bank.map((puzzle) => {
    const known = knownSolutions[puzzle.id];
    return known === undefined ? firstSolution(puzzle) : normalizeSolution(puzzle, known);
  });
  const emptyCellsBySize = new Map<number, readonly CellState[]>();
  const progress = bank.map((puzzle): PuzzleProgress => {
    let cells = emptyCellsBySize.get(puzzle.size);
    if (!cells) {
      cells = createEmptyCells(puzzle.size);
      emptyCellsBySize.set(puzzle.size, cells);
    }
    return {
      cells,
      history: [],
      solved: false,
      timer: EMPTY_TIMER,
    };
  });

  return {
    puzzles: bank,
    solutions,
    progress,
    activePuzzleIndex: 0,
  };
}

function replaceActiveProgress(state: GameState, next: PuzzleProgress): GameState {
  const progress = state.progress.slice();
  progress[state.activePuzzleIndex] = next;
  return { ...state, progress };
}

function changeCells(
  state: GameState,
  cells: readonly CellState[],
  now: number,
  restoresTimer: boolean,
): GameState {
  const current = state.progress[state.activePuzzleIndex];
  const puzzle = state.puzzles[state.activePuzzleIndex];
  const advancedTimer = advanceTimer(current.timer, now);
  const runningTimer = startTimer(advancedTimer, now);
  const solved = isSolved(puzzle, cells);
  const timer = solved ? stopTimer(runningTimer, now) : runningTimer;
  const historyEntry: GameHistoryEntry = {
    cells: current.cells,
    timer: advancedTimer,
    restoresTimer,
  };

  return replaceActiveProgress(state, {
    cells,
    history: [...current.history, historyEntry],
    solved,
    timer,
  });
}

function reset(state: GameState, now: number): GameState {
  assertTimestamp(now);
  const current = state.progress[state.activePuzzleIndex];
  const pristine =
    current.timer.startedAt === null && current.cells.every((cell) => cell === "empty");
  if (pristine) return state;

  const timer = advanceTimer(current.timer, now);
  const historyEntry: GameHistoryEntry = {
    cells: current.cells,
    timer,
    restoresTimer: true,
  };

  return replaceActiveProgress(state, {
    cells: createEmptyCells(state.puzzles[state.activePuzzleIndex].size),
    history: [...current.history, historyEntry],
    solved: false,
    timer: EMPTY_TIMER,
  });
}

function undo(state: GameState, now: number): GameState {
  assertTimestamp(now);
  const current = state.progress[state.activePuzzleIndex];
  const historyEntry = current.history[current.history.length - 1];
  if (historyEntry === undefined) return state;

  const puzzle = state.puzzles[state.activePuzzleIndex];
  const solved = isSolved(puzzle, historyEntry.cells);
  const currentTimer = advanceTimer(current.timer, now);
  const restoredTimer = historyEntry.restoresTimer ? historyEntry.timer : currentTimer;
  const timer = solved ? restoredTimer : resumeTimer(restoredTimer, now);

  return replaceActiveProgress(state, {
    cells: historyEntry.cells,
    history: current.history.slice(0, -1),
    solved,
    timer,
  });
}

function hint(state: GameState, now: number): GameState {
  assertTimestamp(now);
  const current = state.progress[state.activePuzzleIndex];
  if (current.solved) return state;

  const puzzle = state.puzzles[state.activePuzzleIndex];
  const solution = state.solutions[state.activePuzzleIndex];
  const conflicts = findConflicts(puzzle, current.cells);
  let target = -1;
  let replacement: CellState = "empty";

  for (let index = 0; index < current.cells.length; index += 1) {
    if (conflicts.has(index)) {
      target = index;
      break;
    }
  }

  if (target === -1) {
    const solutionCells = new Set(solution);
    target = current.cells.findIndex(
      (cell, index) => cell === "marked" && !solutionCells.has(index),
    );
  }

  if (target === -1) {
    target = solution.find((index) => current.cells[index] !== "marked") ?? -1;
    replacement = "marked";
  }

  if (target === -1) return state;
  const cells = current.cells.slice();
  cells[target] = replacement;
  return changeCells(state, cells, now, false);
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  const current = state.progress[state.activePuzzleIndex];

  switch (action.type) {
    case "set-cells": {
      if (current.solved) return state;
      const cells = setCellStates(current.cells, action.indexes, action.state);
      return cells === current.cells ? state : changeCells(state, cells, action.now, false);
    }
    case "undo":
      return undo(state, action.now);
    case "reset":
      return reset(state, action.now);
    case "hint":
      return hint(state, action.now);
    case "select-puzzle": {
      if (!Number.isInteger(action.index)) throw new RangeError("Puzzle index must be an integer.");
      const activePuzzleIndex = Math.min(Math.max(action.index, 0), state.puzzles.length - 1);
      const currentTimer = advanceTimer(current.timer, action.now);
      if (activePuzzleIndex === state.activePuzzleIndex) {
        return currentTimer === current.timer
          ? state
          : replaceActiveProgress(state, { ...current, timer: currentTimer });
      }

      const progress = state.progress.slice();
      if (currentTimer !== current.timer)
        progress[state.activePuzzleIndex] = { ...current, timer: currentTimer };
      const selected = progress[activePuzzleIndex];
      const selectedTimer = advanceTimer(selected.timer, action.now);
      if (selectedTimer !== selected.timer)
        progress[activePuzzleIndex] = { ...selected, timer: selectedTimer };
      return { ...state, progress, activePuzzleIndex };
    }
    case "tick": {
      const timer = advanceTimer(current.timer, action.now);
      return timer === current.timer ? state : replaceActiveProgress(state, { ...current, timer });
    }
  }
}
