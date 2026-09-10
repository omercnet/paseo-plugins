import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentCrew } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "crew",
    title: "Agent Crew",
    icon: "Network",
    context: "workspace",
    locations: ["explorer"],
    Component: AgentCrew,
  });
  client.addCommandCenterItem({
    id: "open-crew",
    title: "Open Agent Crew",
    icon: "Network",
    keywords: ["agents", "subagents", "orchestration", "delegation", "workers", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("crew", { location: "explorer" });
    },
  });
  return () => {};
}
