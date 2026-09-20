import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, test } from "vitest";
import contribute from "../index.server";
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_LIMITS, gameSettings } from "../shared/game-settings";
import { loadPuzzleDeck } from "../shared/puzzle-catalog";

describe("Queens game settings document", () => {
  test("is host-scoped and supplies a complete default document", () => {
    expect(gameSettings.id).toBe("paseo-queens-game");
    expect(gameSettings.scope).toBe("host");
    expect(gameSettings.version).toBe(1);
    expect(gameSettings.schema.parse({})).toEqual(DEFAULT_GAME_SETTINGS);
  });

  test("accepts persisted puzzle progress and completion records", () => {
    expect(
      gameSettings.schema.parse({
        currentPuzzleId: "paseo-queens-02",
        puzzleStates: {
          "paseo-queens-01": {
            cells: ["marked", "excluded", "empty"],
            startedAtMs: 1_000,
            completedAtMs: 2_500,
            hintUsed: true,
          },
        },
        records: {
          "paseo-queens-01": {
            completions: 3,
            bestTimeMs: 1_500,
          },
        },
      }),
    ).toEqual({
      boardSize: 6,
      difficulty: "easy",
      currentPuzzleId: "paseo-queens-02",
      puzzleStates: {
        "paseo-queens-01": {
          cells: ["marked", "excluded", "empty"],
          startedAtMs: 1_000,
          completedAtMs: 2_500,
          hintUsed: true,
        },
      },
      records: {
        "paseo-queens-01": {
          completions: 3,
          bestTimeMs: 1_500,
        },
      },
    });
  });

  test("rejects malformed identifiers, cells, timestamps, and unknown fields", () => {
    const invalidDocuments = [
      { currentPuzzleId: 1 },
      { currentPuzzleId: " bad-id" },
      { unexpected: true },
      {
        puzzleStates: {
          puzzle: {
            cells: ["queen"],
            startedAtMs: null,
            completedAtMs: null,
            hintUsed: false,
          },
        },
      },
      {
        puzzleStates: {
          puzzle: {
            cells: ["empty"],
            startedAtMs: -1,
            completedAtMs: null,
            hintUsed: false,
          },
        },
      },
      {
        puzzleStates: {
          puzzle: {
            cells: ["empty"],
            startedAtMs: null,
            completedAtMs: 1,
            hintUsed: false,
          },
        },
      },
      {
        puzzleStates: {
          puzzle: {
            cells: ["empty"],
            startedAtMs: 2,
            completedAtMs: 1,
            hintUsed: false,
          },
        },
      },
      { records: { puzzle: { completions: 0, bestTimeMs: 100 } } },
      { records: { puzzle: { completions: 1, bestTimeMs: -1 } } },
    ];

    for (const document of invalidDocuments) {
      expect(() => gameSettings.schema.parse(document)).toThrow();
    }
  });

  test("bounds cell arrays and per-puzzle collections", () => {
    const puzzleState = {
      cells: ["empty"] as const,
      startedAtMs: null,
      completedAtMs: null,
      hintUsed: false,
    };
    const tooManyCells = Array.from(
      { length: GAME_SETTINGS_LIMITS.cellsPerPuzzle + 1 },
      () => "empty" as const,
    );
    const tooManyPuzzleStates = Object.fromEntries(
      Array.from({ length: GAME_SETTINGS_LIMITS.puzzles + 1 }, (_, index) => [
        `puzzle-${index}`,
        puzzleState,
      ]),
    );
    const tooManyRecords = Object.fromEntries(
      Array.from({ length: GAME_SETTINGS_LIMITS.puzzles + 1 }, (_, index) => [
        `puzzle-${index}`,
        { completions: 1, bestTimeMs: 100 },
      ]),
    );

    expect(() =>
      gameSettings.schema.parse({
        puzzleStates: { puzzle: { ...puzzleState, cells: tooManyCells } },
      }),
    ).toThrow();
    expect(() => gameSettings.schema.parse({ puzzleStates: tooManyPuzzleStates })).toThrow();
    expect(() => gameSettings.schema.parse({ records: tooManyRecords })).toThrow();
  });
});

describe("Queens server contribution", () => {
  test("registers the game settings contract and returns cleanup", () => {
    const registered: unknown[] = [];
    const handled: unknown[] = [];
    const cleanup = contribute({
      registerSettings(definition: unknown) {
        registered.push(definition);
      },
      handle(contract: unknown) {
        handled.push(contract);
      },
    } as unknown as PluginServerContext);

    expect(registered).toEqual([gameSettings]);
    expect(handled).toEqual([loadPuzzleDeck]);
    expect(typeof cleanup).toBe("function");
    expect(cleanup()).toBeUndefined();
  });
});
