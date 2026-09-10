import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PrRadar } from "./client/pr-radar";

export default function contribute(client: PluginClientContext) {
  client.addSurface("radar", PrRadar);
  client.addSidebarItem({
    id: "radar",
    title: "PR Radar",
    icon: "GitPullRequest",
    surface: "radar",
  });
  client.addCommandCenterItem({
    id: "open-radar",
    title: "Open PR Radar",
    icon: "GitPullRequest",
    keywords: ["pull requests", "delivery", "merge", "agents"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("radar");
    },
  });
  return () => {};
}
