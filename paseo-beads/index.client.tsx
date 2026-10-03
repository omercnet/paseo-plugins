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
  // Paseo 0.11 added screens and sidebar header items. 0.9 and 0.10 keep the panel and commands.
  const removeReadyBeads =
    typeof client.addScreen === "function" && typeof client.addSidebarHeaderItem === "function"
      ? [
          client.addScreen({
            id: BEAD_SCREEN_ID,
            title: (params) => parseBeadScreenParams(params)?.issueId ?? "Bead",
            Component: BeadScreen,
          }),
          client.addSidebarHeaderItem({
            id: "ready-beads",
            title: "Ready beads",
            Component: ReadyBeadsItem,
          }),
        ]
      : [];

  return () => {
    for (const remove of removeReadyBeads) remove();
    removeAgentCommand();
    removeWorkspaceCommand();
    removePanel();
  };
}
