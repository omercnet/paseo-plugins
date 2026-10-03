import { describe, expect, test } from "vitest";
import {
  parsePuzzleParam,
  queensProgress,
  queensScreenTitle,
  supportsQueensScreens,
} from "../client/screen-navigation";
import { DEFAULT_GAME_SETTINGS } from "../shared/game-settings";

describe("Queens screen navigation", () => {
  test("parses a cross-deck puzzle link and derives its title", () => {
    expect(parsePuzzleParam("queens-10x10-hard-231")).toEqual({
      id: "queens-10x10-hard-231",
      size: 10,
      difficulty: "hard",
      number: "231",
    });
    expect(queensScreenTitle({ puzzle: "queens-10x10-hard-231" })).toBe("Queens 10×10 hard #231");
  });
  test.each([
    undefined,
    "",
    "paseo-queens-01",
    "queens-6x7-easy-1",
    "queens-15x15-easy-1",
    "queens-4x4-easy-1",
    "queens-6x6-unknown-1",
    "queens-6x6-easy-65536",
    "queens-6x6-easy-1/other",
    "queens-06x06-easy-1",
    "queens-6x6-easy-01",
  ])("rejects invalid puzzle param %s without inventing a title", (puzzle) => {
    expect(parsePuzzleParam(puzzle)).toBeNull();
    expect(queensScreenTitle(puzzle === undefined ? {} : { puzzle })).toBe("Queens");
  });
  test("counts distinct recorded completions and reports solved only for a completed current attempt", () => {
    const settings = {
      ...DEFAULT_GAME_SETTINGS,
      currentPuzzleId: "queens-6x6-easy-1",
      records: {
        "queens-6x6-easy-1": { completions: 4, bestTimeMs: 100 },
        "queens-7x7-hard-2": { completions: 1, bestTimeMs: 200 },
      },
    };
    expect(queensProgress(settings)).toEqual({
      solved: false,
      completed: 2,
      params: { puzzle: settings.currentPuzzleId },
    });
    expect(
      queensProgress({
        ...settings,
        puzzleStates: {
          [settings.currentPuzzleId]: {
            cells: ["marked"],
            startedAtMs: 0,
            completedAtMs: 0,
            hintUsed: true,
          },
        },
      }).solved,
    ).toBe(true);
    expect(queensProgress(DEFAULT_GAME_SETTINGS)).toEqual({
      solved: false,
      completed: 0,
      params: {},
    });
  });
  test("requires all new runtime capabilities before replacing legacy navigation", () => {
    const method = () => {};
    expect(supportsQueensScreens({ addScreen: method, addSidebarHeaderItem: method }, method)).toBe(
      true,
    );
    expect(supportsQueensScreens({}, undefined)).toBe(false);
    expect(supportsQueensScreens({ addScreen: method }, method)).toBe(false);
    expect(supportsQueensScreens({ addSidebarHeaderItem: method }, method)).toBe(false);
    expect(
      supportsQueensScreens({ addScreen: method, addSidebarHeaderItem: method }, undefined),
    ).toBe(false);
  });
});
