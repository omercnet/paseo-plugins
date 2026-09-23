import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAutoOpenClaimHandler } from "./server/auto-open";
import { claimOpenedWorkspaces } from "./shared/auto-open";
import { agentCrewSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(agentCrewSettings);
  server.handle(claimOpenedWorkspaces, createAutoOpenClaimHandler());
  return () => {};
}
