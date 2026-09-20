import type { z } from "zod";
import type { loadPuzzleDeck } from "../shared/puzzle-catalog";
import { CURATED_PUZZLE_DATA } from "./curated-data";

export function getPuzzleDeck(input: z.output<typeof loadPuzzleDeck.input>) {
  const group = CURATED_PUZZLE_DATA[`${input.size}-${input.difficulty}`];
  if (!group)
    throw new RangeError(`No curated ${input.size}×${input.size} ${input.difficulty} deck.`);
  return group;
}
