import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createRepositoryRefreshCoordinator,
  refreshWorkspaceRequest,
} from "./server/fresh-worktrees";
import { inspectWorkspaceFreshness } from "./server/workspace-freshness";
import { workspaceFreshness } from "./shared/workspace-freshness";

export default function contribute(server: PluginServerContext) {
  const refreshRepository = createRepositoryRefreshCoordinator();

  server.handle(workspaceFreshness, ({ projectRootPath, workspaceDirectory }) =>
    inspectWorkspaceFreshness(projectRootPath, workspaceDirectory, {
      signal: new AbortController().signal,
      refreshRepository,
    }),
  );

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
      warn(message) {
        console.warn(`[fresh-worktrees] ${message}`);
      },
    });
  });

  return () => {};
}
