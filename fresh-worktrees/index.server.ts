import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createRepositoryRefreshCoordinator,
  refreshWorkspaceRequest,
} from "./server/fresh-worktrees";
import { inspectWorkspaceFreshness, refreshSourceBranch } from "./server/workspace-freshness";
import {
  refreshSourceBranch as refreshSourceBranchContract,
  workspaceFreshness,
} from "./shared/workspace-freshness";

export default function contribute(server: PluginServerContext) {
  const refreshRepository = createRepositoryRefreshCoordinator();

  server.handle(workspaceFreshness, ({ projectRootPath, workspaceDirectory }) =>
    inspectWorkspaceFreshness(projectRootPath, workspaceDirectory, {
      signal: new AbortController().signal,
      refreshRepository,
    }),
  );

  server.handle(refreshSourceBranchContract, ({ projectRootPath }) =>
    refreshSourceBranch(projectRootPath, {
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
