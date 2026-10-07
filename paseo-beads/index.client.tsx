import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BEAD_SCREEN_ID, parseBeadScreenParams } from "./client/beads-view";
import { BeadScreen, PaseoBeads } from "./client/paseo-beads";
import { ReadyBeadsItem } from "./client/ready-beads";

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
  const removeScreen = client.addScreen({
    id: BEAD_SCREEN_ID,
    title: (params) => parseBeadScreenParams(params)?.issueId ?? "Bead",
    Component: BeadScreen,
  });
  const removeReadyBeads = client.addSidebarHeaderItem({
    id: "ready-beads",
    title: "Ready beads",
    Component: ReadyBeadsItem,
  });

  return () => {
    removeReadyBeads();
    removeScreen();
    removeAgentCommand();
    removeWorkspaceCommand();
    removePanel();
  };
}
