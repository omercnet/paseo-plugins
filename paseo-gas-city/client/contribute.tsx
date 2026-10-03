import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CityScreen } from "./city-screen";
import { queueSlingIntent } from "./dispatch-intent";
import { FactoryPanel } from "./factory-panel";
import { GasCitySurface } from "./gas-city-surface";
import { GasCitySettingsScreen } from "./settings-screen";
import { GasCitySidebarItem } from "./sidebar-item";
import { CITY_SCREEN_ID, cityScreenTitle, supportsScreens } from "./view-model";

// Paseo 0.11+ registers screens and a sidebar row; 0.9/0.10 keep the static surface.
// The main screen keeps the old sidebar item id so saved links keep working.
function addNavigation(client: PluginClientContext) {
  if (supportsScreens(client)) {
    return [
      client.addScreen({ id: "gas-city", title: "Gas City", Component: GasCitySurface }),
      client.addScreen({ id: CITY_SCREEN_ID, title: cityScreenTitle, Component: CityScreen }),
      client.addSidebarHeaderItem({
        id: "gas-city",
        title: "Gas City",
        Component: GasCitySidebarItem,
      }),
    ];
  }
  return [
    client.addSurface("gas-city", GasCitySurface),
    client.addSidebarItem({
      id: "gas-city",
      title: "Gas City",
      icon: "Factory",
      surface: "gas-city",
    }),
  ];
}

export function registerGasCityClient(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({
      id: "gas-city",
      title: "Gas City settings",
      icon: "Settings",
      Component: GasCitySettingsScreen,
    }),
    ...addNavigation(client),
    client.addWorkspacePanel({
      id: "gas-city-factory",
      title: "Factory",
      icon: "Factory",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: FactoryPanel,
    }),
    client.addCommandCenterItem({
      id: "open-gas-city",
      title: "Open Gas City",
      icon: "Factory",
      keywords: ["gas city", "supervisor", "sessions", "convoys", "operator"],
      context: "global",
      onSelect({ openSurface, openScreen }) {
        if (typeof openScreen === "function") openScreen({ screenId: "gas-city" });
        else openSurface("gas-city");
      },
    }),
    client.addCommandCenterItem({
      id: "configure-gas-city",
      title: "Configure Gas City",
      icon: "Settings",
      keywords: ["gas city", "endpoint", "observe only", "mutations"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings("gas-city");
      },
    }),
    client.addCommandCenterItem({
      id: "open-gas-city-factory",
      title: "Open Gas City Factory",
      icon: "Factory",
      keywords: ["gas city", "workspace", "rig", "sessions", "convoys"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("gas-city-factory");
      },
    }),
    client.addCommandCenterItem({
      id: "sling-gas-city-work",
      title: "Sling work in Gas City",
      icon: "Send",
      keywords: ["gas city", "dispatch", "bead", "agent role"],
      context: "workspace",
      onSelect({ workspace, openPanel }) {
        queueSlingIntent(workspace.id, "");
        openPanel("gas-city-factory");
      },
    }),
    client.addCommandCenterItem({
      id: "open-agent-gas-city-factory",
      title: "Open Gas City Factory",
      icon: "Factory",
      keywords: ["gas city", "workspace", "agent", "session"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("gas-city-factory");
      },
    }),
    client.addSlashCommand({
      name: "sling",
      description: "Confirm and dispatch a Gas City bead to an agent role",
      argumentHint: "<bead-id> [agent-role]",
      context: "workspace",
      onSubmit({ workspace, args, openPanel }) {
        queueSlingIntent(workspace.id, args);
        openPanel("gas-city-factory");
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
