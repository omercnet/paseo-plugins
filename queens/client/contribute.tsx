import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerQueensComposerPills } from "./composer-pill";
import { QueensSidebar } from "./queens-sidebar";
import { PaseoQueensScreen } from "./queens-surface";
import { queensScreenTitle } from "./screen-navigation";
import { disposePersistedGames } from "./use-persisted-game";

export function registerPaseoQueensClient(client: PluginClientContext) {
  const cleanups = [
    disposePersistedGames,
    client.addScreen({
      id: "queens",
      title: queensScreenTitle,
      Component: PaseoQueensScreen,
    }),
    client.addSidebarHeaderItem({ id: "queens", title: "Queens", Component: QueensSidebar }),
    registerQueensComposerPills(client),
    client.addCommandCenterItem({
      id: "open-queens",
      title: "Open Queens",
      icon: "Crown",
      keywords: ["queens", "logic", "puzzle", "game"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "queens" });
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

export default registerPaseoQueensClient;
