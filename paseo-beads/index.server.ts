import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleGetWorkspaceBead, handleGetWorkspaceBeads } from "./server/beads";
import { getWorkspaceBead, getWorkspaceBeads } from "./shared/beads";

export default function contribute(server: PluginServerContext) {
  server.handle(getWorkspaceBeads, handleGetWorkspaceBeads);
  server.handle(getWorkspaceBead, handleGetWorkspaceBead);
  return () => {};
}
