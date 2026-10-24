import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SCREEN_ID, SETTINGS_ID } from "./client/queries";
import { SandboxesScreen } from "./client/sandboxes-screen";
import { SandboxSettingsScreen } from "./client/settings-screen";
import { SandboxesSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({
      id: SCREEN_ID,
      title: "Sandboxes",
      Component: (props) => (
        <SandboxesScreen {...props} openCredentials={() => client.openSettings(SETTINGS_ID)} />
      ),
    }),
    client.addSidebarHeaderItem({
      id: SCREEN_ID,
      title: "Sandboxes",
      Component: SandboxesSidebarItem,
    }),
    client.addSettingsScreen({
      id: SETTINGS_ID,
      title: "Sandbox credentials",
      icon: "Box",
      Component: SandboxSettingsScreen,
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
