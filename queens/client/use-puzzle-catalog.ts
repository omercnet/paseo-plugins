import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_BOARD_SIZE, DEFAULT_DIFFICULTY, gameSettings } from "../shared/game-settings";
import { loadPuzzleDeck, type PuzzleDifficulty } from "../shared/puzzle-catalog";
import { type CuratedPuzzleDeck, decodePuzzleDeck } from "./game/curated";

const DECK_PROMISES = new Map<string, Promise<CuratedPuzzleDeck>>();
const MAX_CACHED_DECKS = 3;

export type PuzzleCatalogState = {
  readonly size: number;
  readonly difficulty: PuzzleDifficulty;
  readonly deck: CuratedPuzzleDeck | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
  readonly select: (size: number, difficulty: PuzzleDifficulty) => Promise<boolean>;
};

export function usePuzzleCatalog(): PuzzleCatalogState {
  const settings = useSettings(gameSettings);
  const loadDeck = useRpc(loadPuzzleDeck);
  const size = settings.status === "ready" ? settings.values.boardSize : DEFAULT_BOARD_SIZE;
  const difficulty = settings.status === "ready" ? settings.values.difficulty : DEFAULT_DIFFICULTY;
  const [deck, setDeck] = useState<CuratedPuzzleDeck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getDeck = useCallback(
    (nextSize: number, nextDifficulty: PuzzleDifficulty) => {
      const key = `${nextSize}-${nextDifficulty}`;
      const existing = DECK_PROMISES.get(key);
      if (existing) return existing;
      if (DECK_PROMISES.size >= MAX_CACHED_DECKS) {
        const oldestKey = DECK_PROMISES.keys().next().value;
        if (oldestKey !== undefined) DECK_PROMISES.delete(oldestKey);
      }
      const request = loadDeck({ size: nextSize, difficulty: nextDifficulty })
        .then(decodePuzzleDeck)
        .catch((loadError: unknown) => {
          DECK_PROMISES.delete(key);
          throw loadError;
        });
      DECK_PROMISES.set(key, request);
      return request;
    },
    [loadDeck],
  );

  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextDeck = await getDeck(size, difficulty);
      if (request !== requestRef.current) return;
      setDeck(nextDeck);
      setLoading(false);
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Puzzle deck failed to load.");
      setLoading(false);
    }
  }, [difficulty, getDeck, size]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const select = useCallback(
    async (nextSize: number, nextDifficulty: PuzzleDifficulty) => {
      if (settings.status !== "ready") return false;
      setLoading(true);
      setError(null);
      try {
        const nextDeck = await getDeck(nextSize, nextDifficulty);
        const firstPuzzle = nextDeck.puzzles[0];
        if (!firstPuzzle) throw new RangeError("The curated puzzle deck is empty.");
        const saved = await settings.save(
          {
            ...settings.values,
            boardSize: nextSize,
            difficulty: nextDifficulty,
            currentPuzzleId: firstPuzzle.id,
          },
          settings.revision,
        );
        if (!saved) throw new Error("Puzzle selection was not saved.");
        return true;
      } catch (selectionError) {
        setError(
          selectionError instanceof Error ? selectionError.message : "Puzzle selection failed.",
        );
        setLoading(false);
        return false;
      }
    },
    [getDeck, settings],
  );

  const retry = useCallback(() => {
    DECK_PROMISES.delete(`${size}-${difficulty}`);
    setDeck(null);
    void refresh();
  }, [difficulty, refresh, size]);

  return { size, difficulty, deck, loading, error, retry, select };
}
