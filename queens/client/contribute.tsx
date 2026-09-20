import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerQueensComposerPills } from "./composer-pill";
import { PaseoQueensSurface } from "./queens-surface";
import { disposePersistedGames } from "./use-persisted-game";

export function registerPaseoQueensClient(client: PluginClientContext) {
  const cleanups = [
    disposePersistedGames,
    client.addSurface("queens", PaseoQueensSurface),
    registerQueensComposerPills(client),
    client.addSidebarItem({
      id: "queens",
      title: "Queens",
      icon: "Crown",
      surface: "queens",
    }),
    client.addCommandCenterItem({
      id: "open-queens",
      title: "Open Queens",
      icon: "Crown",
      keywords: ["queens", "logic", "puzzle", "game"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface("queens");
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

export default registerPaseoQueensClient;
