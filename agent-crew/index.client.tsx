import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { createAutoOpenManager } from "./client/auto-open";
import { AgentCrew } from "./client/main";
import { AgentCrewSettingsScreen } from "./client/settings-screen";
import { agentCrewSettings } from "./shared/settings";

export default function contribute(client: PluginClientContext) {
  const autoOpen = createAutoOpenManager(client);

  function SettingsSurface(props: PluginSurfaceProps) {
    return <AgentCrewSettingsScreen {...props} onAutoOpenChange={autoOpen.setEnabled} />;
  }

  const removeSettings = client.addSettingsScreen({
    id: agentCrewSettings.id,
    title: "Agent Crew settings",
    icon: "Settings",
    Component: SettingsSurface,
  });
  const removeWorkspacePanel = client.addWorkspacePanel({
    id: "crew",
    title: "Agent Crew",
    icon: "Network",
    context: "workspace",
    locations: ["explorer"],
    Component: AgentCrew,
  });
  const removeOpenCrew = client.addCommandCenterItem({
    id: "open-crew",
    title: "Open Agent Crew",
    icon: "Network",
    keywords: ["agents", "subagents", "orchestration", "delegation", "workers", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("crew", { location: "explorer" });
    },
  });

  return () => {
    removeOpenCrew();
    removeWorkspacePanel();
    removeSettings();
    autoOpen.dispose();
  };
}
