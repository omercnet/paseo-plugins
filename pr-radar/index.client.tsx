import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { PrRadar } from "./client/pr-radar";
import { PrRadarSettingsScreen } from "./client/settings-screen";
import { RadarSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  function RadarScreen(props: PluginScreenProps) {
    return <PrRadar {...props} onOpenSettings={() => client.openSettings("pr-radar")} />;
  }

  const removers = [
    client.addSettingsScreen({
      id: "pr-radar",
      title: "PR Radar settings",
      icon: "Settings",
      Component: PrRadarSettingsScreen,
    }),
    client.addScreen({ id: "radar", title: "PR Radar", Component: RadarScreen }),
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
