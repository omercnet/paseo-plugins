import type { PuzzleDifficulty } from "../../shared/puzzle-catalog";
import type { Puzzle } from "./types";

export type EncodedPuzzleDeck = {
  readonly size: number;
  readonly difficulty: PuzzleDifficulty;
  readonly count: number;
  readonly recordBytes: number;
  readonly data: string;
};

export type CuratedPuzzleDeck = {
  readonly key: string;
  readonly size: number;
  readonly difficulty: PuzzleDifficulty;
  readonly puzzles: readonly Puzzle[];
  readonly solutions: Readonly<Record<string, readonly number[]>>;
};

const BASE64_VALUES = new Int16Array(128);
BASE64_VALUES.fill(-1);
for (let index = 0; index < 26; index += 1) {
  BASE64_VALUES[65 + index] = index;
  BASE64_VALUES[97 + index] = index + 26;
}
for (let index = 0; index < 10; index += 1) BASE64_VALUES[48 + index] = index + 52;
BASE64_VALUES[43] = 62;
BASE64_VALUES[47] = 63;

function decodeBase64(encoded: string): Uint8Array {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((encoded.length * 3) / 4 - padding);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    if (code === 61) break;
    const value = code < BASE64_VALUES.length ? BASE64_VALUES[code] : -1;
    if (value < 0) throw new RangeError("Curated puzzle data contains invalid base64.");
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >> bits) & 255;
      outputIndex += 1;
    }
  }
  if (outputIndex !== output.length) throw new RangeError("Curated puzzle data is truncated.");
  return output;
}

export function decodePuzzleDeck(encoded: EncodedPuzzleDeck): CuratedPuzzleDeck {
  const key = `${encoded.size}-${encoded.difficulty}`;

  const bytes = decodeBase64(encoded.data);
  if (bytes.length !== encoded.count * encoded.recordBytes) {
    throw new RangeError(`Curated ${key} deck has an invalid byte length.`);
  }

  const regionBytes = Math.ceil((encoded.size * encoded.size) / 2);
  const expectedRecordBytes = 2 + regionBytes + encoded.size;
  if (encoded.recordBytes !== expectedRecordBytes) {
    throw new RangeError(`Curated ${key} deck has an invalid record size.`);
  }

  const puzzles: Puzzle[] = [];
  const solutions: Record<string, readonly number[]> = {};
  for (let record = 0; record < encoded.count; record += 1) {
    let offset = record * encoded.recordBytes;
    const sourceId = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    const id = `queens-${encoded.size}x${encoded.size}-${encoded.difficulty}-${sourceId}`;
    const regions = Array<number>(encoded.size * encoded.size);
    for (let cell = 0; cell < regions.length; cell += 2) {
      const packed = bytes[offset + Math.floor(cell / 2)];
      regions[cell] = packed >> 4;
      if (cell + 1 < regions.length) regions[cell + 1] = packed & 15;
    }
    offset += regionBytes;
    const solution = Array<number>(encoded.size);
    for (let row = 0; row < encoded.size; row += 1) {
      solution[row] = row * encoded.size + bytes[offset + row];
    }
    puzzles.push({ id, size: encoded.size, regions });
    solutions[id] = solution;
  }

  const deck = { key, size: encoded.size, difficulty: encoded.difficulty, puzzles, solutions };
  return deck;
}
