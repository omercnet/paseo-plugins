import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ConnectedHostsScreen } from "./client/screen";
import { ConnectedHostsSidebarItem, SCREEN_ID } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title: "Connected hosts",
    Component: ConnectedHostsScreen,
  });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Connected hosts",
    Component: ConnectedHostsSidebarItem,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "manage-connected-hosts",
    title: "Manage connected hosts",
    icon: "Network",
    keywords: ["hosts", "daemon", "remote", "connect", "ssh"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  return () => {
    removeCommand();
    removeSidebarItem();
    removeScreen();
  };
}
