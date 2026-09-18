import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGasCityHandlers } from "./server/handlers";
import {
  discoverSupervisor,
  dispatchWork,
  gasCitySettings,
  getCityRigSnapshot,
  listAttention,
  listConvoys,
  listEvents,
  listSessions,
  listWork,
  performSessionAction,
  resolveWorkspaceRig,
} from "./shared";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(gasCitySettings);
  const handlers = createGasCityHandlers(settings);
  server.handle(discoverSupervisor, handlers.discoverSupervisor);
  server.handle(resolveWorkspaceRig, handlers.resolveWorkspaceRig);
  server.handle(getCityRigSnapshot, handlers.getCityRigSnapshot);
  server.handle(listSessions, handlers.listSessions);
  server.handle(listConvoys, handlers.listConvoys);
  server.handle(listWork, handlers.listWork);
  server.handle(listEvents, handlers.listEvents);
  server.handle(listAttention, handlers.listAttention);
  server.handle(dispatchWork, handlers.dispatchWork);
  server.handle(performSessionAction, handlers.performSessionAction);

  return () => {};
}
