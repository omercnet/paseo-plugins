export type CellState = "empty" | "excluded" | "marked";

export interface Puzzle {
  readonly id: string;
  readonly size: number;
  readonly regions: readonly number[];
}
