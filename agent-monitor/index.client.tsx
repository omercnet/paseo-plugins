import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { AgentMonitor } from "./client/agent-monitor";
import { MonitorSettingsScreen } from "./client/settings-screen";
import { MONITOR_SCREEN_ID, MonitorSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "monitor",
    title: "Monitor settings",
    icon: "Settings",
    Component: MonitorSettingsScreen,
  });

  // Registered under the retired sidebar item's id so saved links keep working.
  const removeScreen = client.addScreen({
    id: MONITOR_SCREEN_ID,
    title: "Agent monitor",
    Component: (props: PluginScreenProps) => (
      <AgentMonitor
        {...props}
        bucketParam={props.params.bucket}
        onOpenSettings={() => client.openSettings("monitor")}
      />
    ),
  });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: "monitor",
    title: "Agent monitor",
    Component: MonitorSidebarItem,
  });

  const removeOpenMonitor = client.addCommandCenterItem({
    id: "open-monitor",
    title: "Open agent monitor",
    icon: "Radar",
    keywords: ["agents", "sessions", "monitor", "triage"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: MONITOR_SCREEN_ID });
    },
  });
  const removeConfigureMonitor = client.addCommandCenterItem({
    id: "configure-monitor",
    title: "Configure agent monitor",
    icon: "Settings",
    keywords: ["settings", "preferences", "monitor"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("monitor");
    },
  });

  return () => {
    removeConfigureMonitor();
    removeOpenMonitor();
    removeSidebarItem();
    removeScreen();
    removeSettings();
  };
}
