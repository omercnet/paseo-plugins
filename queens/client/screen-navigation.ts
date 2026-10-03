import type { GameSettings } from "../shared/game-settings";
import { PuzzleDifficultySchema, PuzzleSizeSchema } from "../shared/puzzle-catalog";

export function parsePuzzleParam(value?: string) {
  const match = value?.match(/^queens-(\d+)x\1-(beginner|easy|medium|hard)-(\d+)$/);
  if (!match) return null;
  const size = PuzzleSizeSchema.safeParse(Number(match[1]));
  const difficulty = PuzzleDifficultySchema.safeParse(match[2]);
  if (!size.success || !difficulty.success || Number(match[3]) > 65535) return null;
  return { id: value as string, size: size.data, difficulty: difficulty.data, number: match[3] };
}

export function queensScreenTitle(params: Record<string, string>) {
  const puzzle = parsePuzzleParam(params.puzzle);
  return puzzle
    ? `Queens ${puzzle.size}×${puzzle.size} ${puzzle.difficulty} #${puzzle.number}`
    : "Queens";
}

export function queensProgress(settings: GameSettings) {
  const params: Record<string, string> = parsePuzzleParam(settings.currentPuzzleId)
    ? { puzzle: settings.currentPuzzleId }
    : {};
  return {
    solved: settings.puzzleStates[settings.currentPuzzleId]?.completedAtMs != null,
    completed: Object.keys(settings.records).length,
    params,
  };
}

export function supportsQueensScreens(
  client: {
    addScreen?: unknown;
    addSidebarHeaderItem?: unknown;
  },
  sidebarRow: unknown,
) {
  return (
    typeof client.addScreen === "function" &&
    typeof client.addSidebarHeaderItem === "function" &&
    typeof sidebarRow === "function"
  );
}
