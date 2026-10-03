import { usePaseo } from "@getpaseo/plugin/client";
import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  createDebouncedInvalidator,
  observeDirectoryInvalidation,
  retainShared,
} from "./directory-observation";
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

/** The monitor's directory query. `select` derives a view without a second request. */
export function useMonitorQuery<Selected = MonitorData>(
  hostId: string,
  select?: (data: MonitorData) => Selected,
) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["agent-monitor", "agents", hostId], [hostId]);
  // One observation and backstop per connection and host, however many components read the data
  // (the screen, the sidebar row, the popover). Keyed by the connection so a new one restarts it.
  useEffect(
    () =>
      retainShared(paseo, queryKey.join("/"), () => {
        // Hidden windows skip refreshes; React Query refetches the stale roster on refocus, which
        // keeps the always-mounted sidebar row from polling a backgrounded app.
        const invalidate = () => {
          // cancelRefetch: false lets a slow in-flight load finish instead of restarting it each tick.
          if (focusManager.isFocused()) {
            void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
          }
        };
        const invalidator = createDebouncedInvalidator(invalidate, REFRESH_DEBOUNCE_MS);
        const stopObserving = observeDirectoryInvalidation(paseo, invalidator.invalidate);
        const backstop = setInterval(invalidate, BACKSTOP_REFETCH_MS);
        return () => {
          clearInterval(backstop);
          invalidator.cancel();
          stopObserving();
        };
      }),
    [paseo, queryClient, queryKey],
  );
  return useQuery({ queryKey, queryFn: () => loadDirectory(paseo), select });
}
