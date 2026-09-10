import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createRemoteRefreshCoordinator,
  refreshWorkspaceRequest,
} from "./server/fresh-worktrees";

export default function contribute(server: PluginServerContext) {
  const refreshRemote = createRemoteRefreshCoordinator();

  server.before("workspace.create", async ({ request }, { paseo, signal }) => {
    return refreshWorkspaceRequest(request, {
      signal,
      refreshRemote,
      async listProjects() {
        return (await paseo.projects.list()).projects;
      },
      log(message) {
        console.log(`[fresh-worktrees] ${message}`);
      },
    });
  });

  return () => {};
}
