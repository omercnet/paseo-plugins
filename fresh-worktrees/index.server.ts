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

// Polls share one never-aborted signal so concurrent ones still dedupe;
// only a cancellable workspace.create signal runs a separate refresh.
const pollSignal = new AbortController().signal;

export default function contribute(server: PluginServerContext) {
  const refreshRepository = createRepositoryRefreshCoordinator();

  server.handle(workspaceFreshness, ({ projectRootPath, workspaceDirectory }) =>
    inspectWorkspaceFreshness(projectRootPath, workspaceDirectory, {
      signal: pollSignal,
      refreshRepository,
    }),
  );

  server.handle(refreshSourceBranchContract, ({ projectRootPath }) =>
    refreshSourceBranch(projectRootPath, {
      signal: pollSignal,
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
