import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { registerQueensComposerPills } from "./composer-pill";
import { QueensSidebar } from "./queens-sidebar";
import { PaseoQueensScreen, PaseoQueensSurface } from "./queens-surface";
import { queensScreenTitle, supportsQueensScreens } from "./screen-navigation";
import { disposePersistedGames } from "./use-persisted-game";

export function registerPaseoQueensClient(client: PluginClientContext) {
  const screens = supportsQueensScreens(client, SidebarRow);
  const cleanups = [
    disposePersistedGames,
    ...(screens
      ? [
          client.addScreen({
            id: "queens",
            title: queensScreenTitle,
            Component: PaseoQueensScreen,
          }),
          client.addSidebarHeaderItem({ id: "queens", title: "Queens", Component: QueensSidebar }),
        ]
      : [
          client.addSurface("queens", PaseoQueensSurface),
          client.addSidebarItem({
            id: "queens",
            title: "Queens",
            icon: "Crown",
            surface: "queens",
          }),
        ]),
    registerQueensComposerPills(client),
    client.addCommandCenterItem({
      id: "open-queens",
      title: "Open Queens",
      icon: "Crown",
      keywords: ["queens", "logic", "puzzle", "game"],
      context: "global",
      onSelect({ openScreen, openSurface }) {
        if (screens) openScreen({ screenId: "queens" });
        else openSurface("queens");
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

export default registerPaseoQueensClient;
