import type { WorkspaceRef } from "../shared/agent-access";

export const WORKSPACE_PAGE_SIZE = 200;
export const WORKSPACE_PAGE_LIMIT = 20;

interface WorkspacePage {
  entries: readonly WorkspaceRef[];
  pageInfo: { nextCursor?: string | null; hasMore: boolean };
}

export interface WorkspaceLister {
  workspaces: {
    list(options: {
      filter: { includeBackground: true };
      page: { limit: number; cursor?: string };
    }): Promise<WorkspacePage>;
  };
}

/**
 * Every workspace the daemon knows, background ones included. An access decision made from a partial
 * list could match a shallower workspace than the agent is really in, so a list that is still
 * incomplete after the page limit is an error, and the caller counts it as a failed lookup.
 */
export async function listAllWorkspaces(
  paseo: WorkspaceLister,
  pageLimit: number = WORKSPACE_PAGE_LIMIT,
): Promise<WorkspaceRef[]> {
  const workspaces: WorkspaceRef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pageLimit; page += 1) {
    const result = await paseo.workspaces.list({
      filter: { includeBackground: true },
      page: { limit: WORKSPACE_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...result.entries);
    if (!result.pageInfo.hasMore) return workspaces;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor) throw new Error("Workspace list reports more pages but gave no cursor");
  }
  throw new Error(`Workspace list is longer than ${pageLimit} pages`);
}
