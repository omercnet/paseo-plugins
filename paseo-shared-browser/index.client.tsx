import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SharedBrowserPanel, contributeSharedBrowserClient } from "./client/browser";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "shared-browser",
    title: "Shared Browser",
    icon: "PanelsTopLeft",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: SharedBrowserPanel,
  });
  client.addCommandCenterItem({
    id: "open-shared-browser",
    title: "Open Shared Browser",
    icon: "PanelsTopLeft",
    keywords: ["browser", "shared", "remote"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("shared-browser");
    },
  });
  client.addCommandCenterItem({
    id: "open-shared-browser-agent",
    title: "Open Shared Browser",
    icon: "PanelsTopLeft",
    keywords: ["browser", "shared", "remote"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("shared-browser");
    },
  });

  return contributeSharedBrowserClient(client);
}
