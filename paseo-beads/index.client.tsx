import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PaseoBeads } from "./client/paseo-beads";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "beads",
    title: "Beads",
    icon: "CircleDot",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: PaseoBeads,
  });
  const removeWorkspaceCommand = client.addCommandCenterItem({
    id: "open-beads",
    title: "Open Beads",
    icon: "CircleDot",
    keywords: ["beads", "issues", "dependencies", "ready", "work queue"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("beads");
    },
  });
  const removeAgentCommand = client.addCommandCenterItem({
    id: "open-beads-agent",
    title: "Open Beads",
    icon: "CircleDot",
    keywords: ["beads", "issues", "dependencies", "ready", "work queue"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("beads");
    },
  });

  return () => {
    removeAgentCommand();
    removeWorkspaceCommand();
    removePanel();
  };
}
