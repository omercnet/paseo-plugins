import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createRepositoryRefreshCoordinator,
  refreshWorkspaceRequest,
} from "./server/fresh-worktrees";

export default function contribute(server: PluginServerContext) {
  const refreshRepository = createRepositoryRefreshCoordinator();

  server.before("workspace.create", async ({ request }, { paseo, signal }) => {
    return refreshWorkspaceRequest(request, {
      signal,
      refreshRepository,
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
