import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { createGasCityHandlers } from "./server/handlers";
import {
  discoverSupervisor,
  dispatchWork,
  GasCitySettingsSchema,
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

type GasCitySettingsHandle = PluginSettings<typeof gasCitySettings.schema>;

const paseo08DefaultSettings = GasCitySettingsSchema.parse({});
const paseo08SettingsHandle: GasCitySettingsHandle = {
  read: async () => ({
    status: "ready",
    revision: "paseo-0.8-schema-defaults",
    values: paseo08DefaultSettings,
  }),
  subscribe: () => () => {},
};

export function resolveRegisteredGasCitySettings(
  registered: GasCitySettingsHandle | undefined,
): GasCitySettingsHandle {
  // Paseo 0.8 registers the persisted settings RPCs but returns no server read handle.
  // Its only authoritative option is the schema-default, fail-closed policy.
  return registered ?? paseo08SettingsHandle;
}

export default function contribute(server: PluginServerContext) {
  const settings = resolveRegisteredGasCitySettings(server.registerSettings(gasCitySettings));
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
