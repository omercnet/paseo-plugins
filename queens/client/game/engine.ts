import type { CellState, Puzzle } from "./types";

function assertSize(size: number): void {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("Board size must be a positive integer.");
  }
}

function assertPuzzle(puzzle: Puzzle): void {
  assertSize(puzzle.size);

  const expectedCellCount = puzzle.size * puzzle.size;
  if (puzzle.regions.length !== expectedCellCount) {
    throw new RangeError(`Puzzle must contain exactly ${expectedCellCount} region cells.`);
  }

  const regions = new Set<number>();
  for (const region of puzzle.regions) {
    if (!Number.isInteger(region) || region < 0 || region >= puzzle.size) {
      throw new RangeError(`Region ids must be integers from 0 to ${puzzle.size - 1}.`);
    }
    regions.add(region);
  }

  if (regions.size !== puzzle.size) {
    throw new RangeError(`Puzzle must contain all ${puzzle.size} region ids.`);
  }
}

function assertCells(puzzle: Puzzle, cells: readonly CellState[]): void {
  const expectedCellCount = puzzle.size * puzzle.size;
  if (cells.length !== expectedCellCount) {
    throw new RangeError(`Board must contain exactly ${expectedCellCount} cells.`);
  }
}

export function createEmptyCells(size: number): CellState[] {
  assertSize(size);
  return Array.from({ length: size * size }, () => "empty" as const);
}

export function setCellStates(
  cells: readonly CellState[],
  indexes: readonly number[],
  state: CellState,
): readonly CellState[] {
  let next: CellState[] | null = null;
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
      throw new RangeError("Cell index is outside the board.");
    }
    if (cells[index] === state) continue;

    next ??= cells.slice();
    next[index] = state;
  }
  return next ?? cells;
}

function addGroupConflicts(
  groups: ReadonlyMap<number, readonly number[]>,
  conflicts: Set<number>,
): void {
  for (const indexes of groups.values()) {
    if (indexes.length > 1) {
      for (const index of indexes) conflicts.add(index);
    }
  }
}
function addToGroup(groups: Map<number, number[]>, key: number, index: number): void {
  const group = groups.get(key);
  if (group) group.push(index);
  else groups.set(key, [index]);
}

export function findConflicts(puzzle: Puzzle, cells: readonly CellState[]): Set<number> {
  assertPuzzle(puzzle);
  assertCells(puzzle, cells);

  const { size } = puzzle;
  const markedIndexes: number[] = [];
  const rows = new Map<number, number[]>();
  const columns = new Map<number, number[]>();
  const regions = new Map<number, number[]>();

  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] !== "marked") continue;

    markedIndexes.push(index);
    const row = Math.floor(index / size);
    const column = index % size;
    const region = puzzle.regions[index];
    addToGroup(rows, row, index);
    addToGroup(columns, column, index);
    addToGroup(regions, region, index);
  }

  const conflicts = new Set<number>();
  addGroupConflicts(rows, conflicts);
  addGroupConflicts(columns, conflicts);
  addGroupConflicts(regions, conflicts);

  const marked = new Set(markedIndexes);
  for (const index of markedIndexes) {
    const row = Math.floor(index / size);
    const column = index % size;

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        if (rowOffset === 0 && columnOffset === 0) continue;

        const adjacentRow = row + rowOffset;
        const adjacentColumn = column + columnOffset;
        if (
          adjacentRow < 0 ||
          adjacentRow >= size ||
          adjacentColumn < 0 ||
          adjacentColumn >= size
        ) {
          continue;
        }

        const adjacentIndex = adjacentRow * size + adjacentColumn;
        if (marked.has(adjacentIndex)) {
          conflicts.add(index);
          conflicts.add(adjacentIndex);
        }
      }
    }
  }

  return conflicts;
}

export function isSolved(puzzle: Puzzle, cells: readonly CellState[]): boolean {
  const conflicts = findConflicts(puzzle, cells);

  let markedCount = 0;
  const markedRows = new Set<number>();
  const markedColumns = new Set<number>();
  const markedRegions = new Set<number>();

  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] !== "marked") continue;
    markedCount += 1;
    markedRows.add(Math.floor(index / puzzle.size));
    markedColumns.add(index % puzzle.size);
    markedRegions.add(puzzle.regions[index]);
  }

  return (
    markedCount === puzzle.size &&
    markedRows.size === puzzle.size &&
    markedColumns.size === puzzle.size &&
    markedRegions.size === puzzle.size &&
    conflicts.size === 0
  );
}

export function countSolutions(puzzle: Puzzle, limit = Number.POSITIVE_INFINITY): number {
  assertPuzzle(puzzle);
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError("Solution limit must be a non-negative integer or Infinity.");
  }
  if (limit === 0) return 0;

  const { size } = puzzle;
  const usedColumns = new Uint8Array(size);
  const usedRegions = new Uint8Array(size);
  let solutions = 0;

  function search(row: number, previousColumn: number): void {
    if (solutions >= limit) return;
    if (row === size) {
      solutions += 1;
      return;
    }

    for (let column = 0; column < size; column += 1) {
      const region = puzzle.regions[row * size + column];
      if (
        usedColumns[column] === 1 ||
        usedRegions[region] === 1 ||
        (row > 0 && Math.abs(column - previousColumn) <= 1)
      ) {
        continue;
      }

      usedColumns[column] = 1;
      usedRegions[region] = 1;
      search(row + 1, column);
      usedColumns[column] = 0;
      usedRegions[region] = 0;
    }
  }

  search(0, -2);
  return solutions;
}
