import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { PrRadar } from "./client/pr-radar";
import { supportsRadarScreen } from "./client/screen-state";
import { RadarSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const screens = supportsRadarScreen(client, SidebarRow);
  if (screens) {
    client.addScreen({
      id: "radar",
      title: "PR Radar",
      Component: PrRadar,
    });
    client.addSidebarHeaderItem({ id: "radar", title: "PR Radar", Component: RadarSidebar });
  } else {
    client.addSurface("radar", PrRadar);
    client.addSidebarItem({
      id: "radar",
      title: "PR Radar",
      icon: "GitPullRequest",
      surface: "radar",
    });
  }
  client.addCommandCenterItem({
    id: "open-radar",
    title: "Open PR Radar",
    icon: "GitPullRequest",
    keywords: ["pull requests", "delivery", "merge", "agents"],
    context: "global",
    onSelect(capabilities) {
      if (screens && typeof capabilities.openScreen === "function")
        capabilities.openScreen({ screenId: "radar" });
      else capabilities.openSurface("radar");
    },
  });
  return () => {};
}
