import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PuzzleDifficultySchema, PuzzleSizeSchema } from "./puzzle-catalog";

export const DEFAULT_PUZZLE_ID = "paseo-queens-01";
export const DEFAULT_BOARD_SIZE = 6;
export const DEFAULT_DIFFICULTY = "easy" as const;

export const GAME_SETTINGS_LIMITS = {
  puzzleIdLength: 128,
  puzzles: 256,
  cellsPerPuzzle: 400,
  completionsPerPuzzle: 1_000_000,
} as const;

export const PersistedCellStateSchema = z.enum(["empty", "excluded", "marked"]);

export const PuzzleIdSchema = z
  .string()
  .min(1)
  .max(GAME_SETTINGS_LIMITS.puzzleIdLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const TimestampMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PuzzleStateSchema = z
  .object({
    cells: z.array(PersistedCellStateSchema).min(1).max(GAME_SETTINGS_LIMITS.cellsPerPuzzle),
    startedAtMs: TimestampMsSchema.nullable(),
    completedAtMs: TimestampMsSchema.nullable(),
    hintUsed: z.boolean(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.completedAtMs !== null && state.startedAtMs === null) {
      context.addIssue({
        code: "custom",
        path: ["completedAtMs"],
        message: "A completed puzzle must have a start timestamp",
      });
      return;
    }

    if (
      state.completedAtMs !== null &&
      state.startedAtMs !== null &&
      state.completedAtMs < state.startedAtMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAtMs"],
        message: "Completion timestamp cannot precede start timestamp",
      });
    }
  });

export const CompletionRecordSchema = z
  .object({
    completions: z.number().int().min(1).max(GAME_SETTINGS_LIMITS.completionsPerPuzzle),
    bestTimeMs: TimestampMsSchema,
  })
  .strict();

export const PuzzleStatesSchema = z
  .record(PuzzleIdSchema, PuzzleStateSchema)
  .superRefine((states, context) => {
    if (Object.keys(states).length > GAME_SETTINGS_LIMITS.puzzles) {
      context.addIssue({
        code: "custom",
        message: `Puzzle state collection cannot exceed ${GAME_SETTINGS_LIMITS.puzzles} entries`,
      });
    }
  });

export const CompletionRecordsSchema = z
  .record(PuzzleIdSchema, CompletionRecordSchema)
  .superRefine((records, context) => {
    if (Object.keys(records).length > GAME_SETTINGS_LIMITS.puzzles) {
      context.addIssue({
        code: "custom",
        message: `Completion record collection cannot exceed ${GAME_SETTINGS_LIMITS.puzzles} entries`,
      });
    }
  });

export const GameSettingsSchema = z
  .object({
    boardSize: PuzzleSizeSchema.default(DEFAULT_BOARD_SIZE),
    difficulty: PuzzleDifficultySchema.default(DEFAULT_DIFFICULTY),
    currentPuzzleId: PuzzleIdSchema.default(DEFAULT_PUZZLE_ID),
    puzzleStates: PuzzleStatesSchema.default({}),
    records: CompletionRecordsSchema.default({}),
  })
  .strict();

export type PersistedCellState = z.infer<typeof PersistedCellStateSchema>;
export type PuzzleState = z.infer<typeof PuzzleStateSchema>;
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;
export type GameSettings = z.infer<typeof GameSettingsSchema>;

export const DEFAULT_GAME_SETTINGS = {
  boardSize: DEFAULT_BOARD_SIZE,
  difficulty: DEFAULT_DIFFICULTY,
  currentPuzzleId: DEFAULT_PUZZLE_ID,
  puzzleStates: {},
  records: {},
} satisfies GameSettings;

export const gameSettings = defineSettings({
  id: "paseo-queens-game",
  scope: "host",
  version: 1,
  schema: GameSettingsSchema,
});
