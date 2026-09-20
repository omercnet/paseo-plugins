import { describe, expect, test } from "vitest";
import { decodePuzzleDeck } from "../client/game/curated";
import { CURATED_PUZZLE_DATA } from "../server/curated-data";

const EXPECTED_PUZZLE_COUNT = 97_184;

describe("curated puzzle corpus", () => {
  test("decodes every indexed puzzle group", () => {
    let total = 0;
    for (const [key, encoded] of Object.entries(CURATED_PUZZLE_DATA)) {
      const deck = decodePuzzleDeck(encoded);
      expect(deck.key).toBe(key);
      expect(deck.puzzles).toHaveLength(encoded.count);
      expect(Object.keys(deck.solutions)).toHaveLength(encoded.count);
      expect(deck.puzzles[0]?.regions).toHaveLength(encoded.size * encoded.size);
      expect(deck.solutions[deck.puzzles[0]?.id ?? ""]).toHaveLength(encoded.size);
      expect(deck.puzzles.at(-1)?.regions).toHaveLength(encoded.size * encoded.size);
      total += encoded.count;
    }
    expect(Object.keys(CURATED_PUZZLE_DATA)).toHaveLength(40);
    expect(total).toBe(EXPECTED_PUZZLE_COUNT);
  });
});
