import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PrRadar } from "./client/pr-radar";
import { RadarSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "radar", title: "PR Radar", Component: PrRadar }),
    client.addSidebarHeaderItem({ id: "radar", title: "PR Radar", Component: RadarSidebar }),
    client.addCommandCenterItem({
      id: "open-radar",
      title: "Open PR Radar",
      icon: "GitPullRequest",
      keywords: ["pull requests", "delivery", "merge", "agents"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "radar" });
      },
    }),
  ];
  return () => {
    for (const remove of removers.reverse()) remove();
  };
}
