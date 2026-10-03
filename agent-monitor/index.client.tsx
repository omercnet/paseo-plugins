import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { AgentMonitor } from "./client/agent-monitor";
import type { Bucket } from "./client/monitor";
import { MonitorSettingsScreen } from "./client/settings-screen";
import { MONITOR_SCREEN_ID, MonitorSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  // 0.11 hosts have screens and live sidebar items; 0.9 and 0.10 only have surfaces.
  const hasScreens =
    typeof client.addScreen === "function" && typeof client.addSidebarHeaderItem === "function";
  const removers: Array<() => void> = [];

  const removeSettings = client.addSettingsScreen({
    id: "monitor",
    title: "Monitor settings",
    icon: "Settings",
    Component: MonitorSettingsScreen,
  });

  if (hasScreens) {
    const selectBucket = (bucket: Bucket | null) =>
      client.openScreen({ screenId: MONITOR_SCREEN_ID, params: { bucket: bucket ?? "all" } });
    // Registered under the deprecated sidebar item's id so saved links keep working.
    removers.push(
      client.addScreen({
        id: MONITOR_SCREEN_ID,
        title: "Agent monitor",
        Component: (props: PluginScreenProps) => (
          <AgentMonitor
            {...props}
            bucketParam={props.params.bucket}
            onSelectBucket={selectBucket}
            onOpenSettings={() => client.openSettings("monitor")}
          />
        ),
      }),
      client.addSidebarHeaderItem({
        id: "monitor",
        title: "Agent monitor",
        Component: MonitorSidebarItem,
      }),
    );
  } else {
    const MonitorSurface = (props: PluginSurfaceProps) => (
      <AgentMonitor {...props} onOpenSettings={() => client.openSettings("monitor")} />
    );
    removers.push(
      client.addSurface("monitor", MonitorSurface),
      client.addSidebarItem({
        id: "monitor",
        title: "Agent monitor",
        icon: "Radar",
        surface: "monitor",
      }),
    );
  }

  const removeOpenMonitor = client.addCommandCenterItem({
    id: "open-monitor",
    title: "Open agent monitor",
    icon: "Radar",
    keywords: ["agents", "sessions", "monitor", "triage"],
    context: "global",
    onSelect({ openScreen, openSurface }) {
      if (hasScreens) openScreen({ screenId: MONITOR_SCREEN_ID });
      else openSurface("monitor");
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
    for (const remove of removers.reverse()) remove();
    removeSettings();
  };
}
