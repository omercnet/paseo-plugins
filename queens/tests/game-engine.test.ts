import { describe, expect, test } from "vitest";
import {
  type CellState,
  countSolutions,
  createEmptyCells,
  findConflicts,
  isSolved,
  PUZZLES,
  type Puzzle,
  setCellStates,
} from "../client/game";

const conflictPuzzle: Puzzle = {
  id: "conflict-fixture",
  size: 4,
  regions: [0, 1, 1, 1, 0, 0, 2, 1, 3, 0, 2, 2, 3, 3, 3, 2],
};

function boardWithMarks(size: number, indexes: readonly number[]): CellState[] {
  const cells = createEmptyCells(size);
  for (const index of indexes) cells[index] = "marked";
  return cells;
}

function expectConflicts(indexes: readonly number[], expected: readonly number[]): void {
  expect(
    [...findConflicts(conflictPuzzle, boardWithMarks(conflictPuzzle.size, indexes))].sort(
      (a, b) => a - b,
    ),
  ).toEqual([...expected].sort((a, b) => a - b));
}

function expectConnectedRegions(puzzle: Puzzle): void {
  for (let region = 0; region < puzzle.size; region += 1) {
    const cells = puzzle.regions
      .map((cellRegion, index) => (cellRegion === region ? index : -1))
      .filter((index) => index >= 0);
    const remaining = new Set(cells);
    const pending = [cells[0]];
    remaining.delete(cells[0]);

    while (pending.length > 0) {
      const index = pending.pop();
      if (index === undefined) break;
      const row = Math.floor(index / puzzle.size);
      const column = index % puzzle.size;
      const neighbors = [
        [row - 1, column],
        [row + 1, column],
        [row, column - 1],
        [row, column + 1],
      ] as const;

      for (const [neighborRow, neighborColumn] of neighbors) {
        if (
          neighborRow < 0 ||
          neighborRow >= puzzle.size ||
          neighborColumn < 0 ||
          neighborColumn >= puzzle.size
        ) {
          continue;
        }
        const neighbor = neighborRow * puzzle.size + neighborColumn;
        if (remaining.delete(neighbor)) pending.push(neighbor);
      }
    }

    expect(remaining.size, `${puzzle.id} region ${region} is disconnected`).toBe(0);
  }
}

describe("cell state", () => {
  test("creates a correctly sized empty board", () => {
    expect(createEmptyCells(6)).toEqual(Array<CellState>(36).fill("empty"));
    expect(() => createEmptyCells(0)).toThrow(RangeError);
  });

  test("sets one or many cells without mutating the input", () => {
    const initial = createEmptyCells(2);
    const excluded = setCellStates(initial, [0, 3], "excluded");
    const marked = setCellStates(excluded, [0], "marked");

    expect(initial).toEqual(["empty", "empty", "empty", "empty"]);
    expect(excluded).toEqual(["excluded", "empty", "empty", "excluded"]);
    expect(marked).toEqual(["marked", "empty", "empty", "excluded"]);
    expect(excluded).not.toBe(initial);
    expect(setCellStates(excluded, [0, 3], "excluded")).toBe(excluded);
    expect(() => setCellStates(initial, [-1], "excluded")).toThrow(RangeError);
    expect(() => setCellStates(initial, [initial.length], "excluded")).toThrow(RangeError);
  });
});

describe("conflict detection", () => {
  test("marks every queen in duplicate rows, columns, and regions", () => {
    expectConflicts([0, 3], [0, 3]);
    expectConflicts([1, 13], [1, 13]);
    expectConflicts([0, 9], [0, 9]);
  });

  test("detects diagonal adjacency at the board edge without wrapping rows", () => {
    expectConflicts([1, 6], [1, 6]);
    expectConflicts([3, 6], [3, 6]);
    expectConflicts([3, 4], []);
  });

  test("ignores excluded cells", () => {
    const cells = createEmptyCells(conflictPuzzle.size);
    cells[0] = "excluded";
    cells[1] = "marked";
    expect(findConflicts(conflictPuzzle, cells)).toEqual(new Set());
  });
});

describe("solved validation", () => {
  test("depends on the final board rather than the order cells were marked", () => {
    const puzzle = PUZZLES[0];
    const solution = [0, 9, 13, 23, 26, 34];

    const markInOrder = (indexes: readonly number[]): readonly CellState[] => {
      let cells: readonly CellState[] = createEmptyCells(puzzle.size);
      for (const index of indexes) {
        cells = setCellStates(cells, [index], "marked");
      }
      return cells;
    };

    const forward = markInOrder(solution);
    const reverse = markInOrder([...solution].reverse());
    expect(forward).toEqual(reverse);
    expect(isSolved(puzzle, forward)).toBe(true);
    expect(isSolved(puzzle, reverse)).toBe(true);
  });

  test("rejects incomplete and conflicting boards", () => {
    const puzzle = PUZZLES[0];
    expect(isSolved(puzzle, createEmptyCells(puzzle.size))).toBe(false);
    expect(isSolved(puzzle, boardWithMarks(puzzle.size, [0, 1, 14, 23, 28, 33]))).toBe(false);
  });
});

describe("shipped puzzles", () => {
  test("provides structurally valid connected 6x6 regions", () => {
    expect(PUZZLES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(PUZZLES.map((puzzle) => puzzle.id)).size).toBe(PUZZLES.length);

    for (const puzzle of PUZZLES) {
      expect(puzzle.size, puzzle.id).toBe(6);
      expect(puzzle.regions, puzzle.id).toHaveLength(puzzle.size * puzzle.size);
      expect(
        [...new Set(puzzle.regions)].sort((a, b) => a - b),
        puzzle.id,
      ).toEqual(Array.from({ length: puzzle.size }, (_, region) => region));
      expectConnectedRegions(puzzle);
    }
  });

  test("gives every shipped puzzle exactly one solution", () => {
    for (const puzzle of PUZZLES) {
      expect(countSolutions(puzzle), puzzle.id).toBe(1);
    }
  });
});
