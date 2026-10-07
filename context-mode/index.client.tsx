import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { ContextModeFooter } from "./client/context-mode-footer";
import { contributeContextModeComposerPills } from "./client/context-mode-pill";
import { ContextModeSurface } from "./client/context-mode-surface";
import { ContextModeSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  function Screen(props: PluginScreenProps) {
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
    client.addScreen({ id: "context-mode", title: "Context Mode", Component: Screen }),
    client.addSidebarFooterItem({
      id: "context-mode",
      title: "Context Mode",
      Component: ContextModeFooter,
    }),
    client.addCommandCenterItem({
      id: "open-context-mode",
      title: "Open Context Mode",
      icon: "Gauge",
      keywords: ["context", "savings", "tokens", "knowledge", "search", "doctor", "health"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "context-mode" });
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
