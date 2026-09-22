import { describe, expect, test, vi } from "vitest";
import { createGameState, gameReducer, PUZZLES } from "../client/game";
import { collectDragIndexes, resolveDraggedCellState } from "../client/queens-board";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: {
    absoluteFillObject: {},
    create<T>(styles: T): T {
      return styles;
    },
    hairlineWidth: 1,
  },
  Text: "Text",
  View: "View",
}));

const puzzle = PUZZLES[0];

function makePreview(replacement: "empty" | "excluded") {
  return {
    indexes: new Set([0, 1, 2]),
    replacement,
  };
}

describe("Queens board drag helpers", () => {
  test("keeps queen cells stable during drag preview", () => {
    expect(resolveDraggedCellState(0, "marked", makePreview("empty"))).toBe("marked");
    expect(resolveDraggedCellState(0, "marked", makePreview("excluded"))).toBe("marked");
    expect(resolveDraggedCellState(3, "empty", makePreview("excluded"))).toBe("empty");
  });

  test("omits queen cells from drag writes in both directions", () => {
    const cells = ["marked", "excluded", "empty"] as const;

    expect(collectDragIndexes(cells, makePreview("empty"))).toEqual([1]);
    expect(collectDragIndexes(cells, makePreview("excluded"))).toEqual([2]);
  });
});

describe("Queens board explicit clicks", () => {
  test("still let a queen be toggled by the reducer", () => {
    const initial = createGameState([puzzle]);
    const marked = gameReducer(initial, {
      type: "set-cells",
      indexes: [0],
      state: "marked",
      now: 10,
    });
    const cleared = gameReducer(marked, {
      type: "set-cells",
      indexes: [0],
      state: "empty",
      now: 20,
    });

    expect(marked.progress[0].cells[0]).toBe("marked");
    expect(cleared.progress[0].cells[0]).toBe("empty");
  });
});
