import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  handleDiscoverSupervisor,
  handleDispatchWork,
  handleGetCityRigSnapshot,
  handleListAttention,
  handleListConvoys,
  handleListEvents,
  handleListProviderSelections,
  handleListSessions,
  handlePerformSessionAction,
  handleResolveWorkspaceRig,
} from "./server/handlers";
import { registerGasCitySessionProvider } from "./server/provider";
import {
  discoverSupervisor,
  dispatchWork,
  gasCitySettings,
  getCityRigSnapshot,
  listAttention,
  listConvoys,
  listEvents,
  listProviderSelections,
  listSessions,
  performSessionAction,
  resolveWorkspaceRig,
} from "./shared";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(gasCitySettings);
  server.handle(discoverSupervisor, handleDiscoverSupervisor);
  server.handle(resolveWorkspaceRig, handleResolveWorkspaceRig);
  server.handle(getCityRigSnapshot, handleGetCityRigSnapshot);
  server.handle(listSessions, handleListSessions);
  server.handle(listConvoys, handleListConvoys);
  server.handle(listEvents, handleListEvents);
  server.handle(listAttention, handleListAttention);
  server.handle(dispatchWork, handleDispatchWork);
  server.handle(performSessionAction, handlePerformSessionAction);
  server.handle(listProviderSelections, handleListProviderSelections);
  registerGasCitySessionProvider(server);
  return () => {};
}
