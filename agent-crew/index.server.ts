import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAutoOpenClaimHandler } from "./server/auto-open";
import { claimOpenedWorkspaces } from "./shared/auto-open";

export default function contribute(server: PluginServerContext) {
  server.handle(claimOpenedWorkspaces, createAutoOpenClaimHandler());
  return () => {};
}
