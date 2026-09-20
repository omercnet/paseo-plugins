import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getPuzzleDeck } from "./server/puzzle-catalog";
import { gameSettings } from "./shared/game-settings";
import { loadPuzzleDeck } from "./shared/puzzle-catalog";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(gameSettings);
  server.handle(loadPuzzleDeck, getPuzzleDeck);
  return () => {};
}
