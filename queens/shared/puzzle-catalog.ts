import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PUZZLE_SIZES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const PUZZLE_DIFFICULTIES = ["beginner", "easy", "medium", "hard"] as const;

export const PuzzleSizeSchema = z.number().int().min(5).max(14);
export const PuzzleDifficultySchema = z.enum(PUZZLE_DIFFICULTIES);

export type PuzzleDifficulty = z.infer<typeof PuzzleDifficultySchema>;

export const loadPuzzleDeck = defineRpc({
  name: "queens.load-puzzle-deck",
  input: z
    .object({
      size: PuzzleSizeSchema,
      difficulty: PuzzleDifficultySchema,
    })
    .strict(),
  output: z
    .object({
      size: PuzzleSizeSchema,
      difficulty: PuzzleDifficultySchema,
      count: z.number().int().positive().max(20_000),
      recordBytes: z.number().int().positive().max(256),
      data: z.string().min(1).max(2_000_000),
    })
    .strict(),
});
