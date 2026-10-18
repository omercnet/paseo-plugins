import type { AgentEntry, PaseoApi, PaseoWorkspace } from "./radar";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

export async function loadAgents(paseo: PaseoApi) {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      includeBackground: true,
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    truncated = result.pageInfo.hasMore;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!truncated || !cursor) break;
  }
  return { entries, truncated };
}

export async function loadWorkspaces(paseo: PaseoApi) {
  const entries: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      includeBackground: true,
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    truncated = result.pageInfo.hasMore;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!truncated || !cursor) break;
  }
  return { entries, truncated };
}
