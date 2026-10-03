import { usePaseo } from "@getpaseo/plugin/client";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { createDebouncedInvalidator, observeDirectoryInvalidation } from "./directory-observation";
import {
  type AgentEntry,
  indexProjects,
  type MonitorDirectory,
  type PaseoApi,
  type PaseoWorkspace,
  type WorkspaceSummary,
} from "./monitor";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const REFRESH_DEBOUNCE_MS = 750;
const BACKSTOP_REFETCH_MS = 30_000;

export type MonitorData = {
  entries: AgentEntry[];
  directory: MonitorDirectory;
  /** True when the agent list hit the page cap, so the roster is a prefix of the host's agents. */
  truncated: boolean;
};

async function loadAgents(paseo: PaseoApi): Promise<{ entries: AgentEntry[]; truncated: boolean }> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

async function loadWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return workspaces;
}

async function loadDirectory(paseo: PaseoApi): Promise<MonitorData> {
  const [agents, workspaces, registry] = await Promise.all([
    loadAgents(paseo),
    loadWorkspaces(paseo),
    paseo.projects.list(),
  ]);
  const workspaceSummaries = new Map<string, WorkspaceSummary>();
  for (const workspace of workspaces) {
    workspaceSummaries.set(workspace.id, {
      id: workspace.id,
      navigationId: workspace.id,
      name: workspace.name,
      projectId: workspace.projectId,
      projectName: workspace.projectDisplayName,
      pinned: workspace.pinnedAt != null,
      labels: workspace.labels ?? [],
      additions: workspace.diffStat?.additions ?? 0,
      deletions: workspace.diffStat?.deletions ?? 0,
    });
  }
  const projects = indexProjects(
    registry.projects.map((project) => ({
      id: project.projectId,
      key: project.projectKey,
      name: project.projectCustomName?.trim() || project.projectDisplayName,
    })),
  );
  return {
    entries: agents.entries,
    directory: { workspaces: workspaceSummaries, projects },
    truncated: agents.truncated,
  };
}

type Feed = { holders: number; stop(): void };
const feeds = new WeakMap<QueryClient, Map<string, Feed>>();

/**
 * Keeps one observation and one backstop timer alive per query client and host, however many
 * components (the screen, the sidebar row, the popover) read the data.
 */
function retainFeed(
  queryClient: QueryClient,
  paseo: PaseoApi,
  queryKey: readonly string[],
): () => void {
  const id = queryKey.join("/");
  let byKey = feeds.get(queryClient);
  if (!byKey) {
    byKey = new Map();
    feeds.set(queryClient, byKey);
  }
  let feed = byKey.get(id);
  if (!feed) {
    const invalidate = () => void queryClient.invalidateQueries({ queryKey });
    const invalidator = createDebouncedInvalidator(invalidate, REFRESH_DEBOUNCE_MS);
    const stopObserving = observeDirectoryInvalidation(paseo, invalidator.invalidate);
    const backstop = setInterval(invalidate, BACKSTOP_REFETCH_MS);
    feed = {
      holders: 0,
      stop() {
        clearInterval(backstop);
        invalidator.cancel();
        stopObserving();
      },
    };
    byKey.set(id, feed);
  }
  const held = feed;
  held.holders += 1;
  return () => {
    held.holders -= 1;
    if (held.holders > 0) return;
    held.stop();
    byKey.delete(id);
  };
}

/** The monitor's directory query. `select` derives a view without a second request. */
export function useMonitorQuery<Selected = MonitorData>(
  hostId: string,
  select?: (data: MonitorData) => Selected,
) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["agent-monitor", "agents", hostId], [hostId]);
  useEffect(() => retainFeed(queryClient, paseo, queryKey), [paseo, queryClient, queryKey]);
  return useQuery({ queryKey, queryFn: () => loadDirectory(paseo), select });
}
