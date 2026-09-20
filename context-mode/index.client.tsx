import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { contributeContextModeComposerPills } from "./client/context-mode-pill";
import { ContextModeSurface } from "./client/context-mode-surface";
import { ContextModeSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  function Surface(props: PluginSurfaceProps) {
    return (
      <ContextModeSurface {...props} onOpenSettings={() => client.openSettings("context-mode")} />
    );
  }

  const cleanups = [
    contributeContextModeComposerPills(client),
    client.addSettingsScreen({
      id: "context-mode",
      title: "Context Mode settings",
      icon: "Settings",
      Component: ContextModeSettingsScreen,
    }),
    client.addSurface("context-mode", Surface),
    client.addSidebarItem({
      id: "context-mode",
      title: "Context Mode",
      icon: "Gauge",
      surface: "context-mode",
    }),
    client.addCommandCenterItem({
      id: "open-context-mode",
      title: "Open Context Mode",
      icon: "Gauge",
      keywords: ["context", "savings", "tokens", "knowledge", "search", "doctor", "health"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface("context-mode");
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
