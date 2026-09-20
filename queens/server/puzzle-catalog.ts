import { createHash } from "node:crypto";
import type { z } from "zod";
import type { loadPuzzleDeck } from "../shared/puzzle-catalog";
import { REMOTE_PUZZLE_GROUPS, type RemotePuzzleGroup } from "./curated-manifest";

const MAX_REMOTE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

type PuzzleDeckInput = z.output<typeof loadPuzzleDeck.input>;
type PuzzleGroupManifest = Readonly<Record<string, RemotePuzzleGroup>>;

export function createPuzzleDeckLoader(
  fetcher: typeof fetch = fetch,
  groups: PuzzleGroupManifest = REMOTE_PUZZLE_GROUPS,
) {
  const cache = new Map<string, Promise<string>>();

  const fetchGroup = (key: string, group: RemotePuzzleGroup) => {
    const existing = cache.get(key);
    if (existing) return existing;

    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetcher(group.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Curated puzzle host returned HTTP ${response.status}.`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_BYTES) {
          throw new RangeError("Curated puzzle payload exceeds the download limit.");
        }
        const data = (await response.text()).trim();
        if (data.length === 0 || data.length > MAX_REMOTE_BYTES) {
          throw new RangeError("Curated puzzle payload has an invalid size.");
        }
        const digest = createHash("sha256").update(data).digest("hex");
        if (digest !== group.sha256) {
          throw new Error("Curated puzzle payload failed its integrity check.");
        }
        return data;
      } finally {
        clearTimeout(timeout);
      }
    })().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });

    cache.set(key, request);
    return request;
  };

  return async (input: PuzzleDeckInput) => {
    const key = `${input.size}-${input.difficulty}`;
    const group = groups[key];
    if (!group) {
      throw new RangeError(`No curated ${input.size}×${input.size} ${input.difficulty} deck.`);
    }
    const data = await fetchGroup(key, group);
    return {
      size: group.size,
      difficulty: group.difficulty,
      count: group.count,
      recordBytes: group.recordBytes,
      data,
    };
  };
}

export const getPuzzleDeck = createPuzzleDeckLoader();
