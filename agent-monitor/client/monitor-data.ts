import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  createDebouncedInvalidator,
  observeDirectoryInvalidation,
  retainShared,
} from "./directory-observation";
import {
  type AgentEntry,
  type HostScope,
  indexProjects,
  isHelper,
  type MonitorDirectory,
  type PaseoApi,
  type PaseoWorkspace,
  type ProjectSummary,
  projectIndexKey,
  type WorkspaceSummary,
  withHostScope,
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

export async function loadAgents(
  paseo: PaseoApi,
): Promise<{ entries: AgentEntry[]; truncated: boolean }> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      includeBackground: true,
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    // Helpers ride along with includeBackground, which the monitor needs for background workspaces.
    entries.push(...result.entries.filter((entry) => !isHelper(entry.agent)));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

export async function loadWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      includeBackground: true,
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

export type MultiHostMonitor = {
  /** Online hosts in a stable order. */
  hosts: HostScope[];
  /** Entries from every host, tagged with the host they were listed from. */
  entries: AgentEntry[];
  directory: MonitorDirectory;
  /** True when any host's agent list hit the page cap. */
  truncated: boolean;
  /** Labels of hosts whose directory failed to load; their agents are missing. */
  failedHosts: string[];
  isPending: boolean;
  isFetching: boolean;
  /** True while the previous host set's roster stands in for a new one that is still loading. */
  isPlaceholderData: boolean;
  refetchAll: () => void;
};

function emptyDirectory(): MonitorDirectory {
  return { workspaces: new Map(), projects: new Map() };
}

function clientFor(serverId: string): PaseoApi | null {
  try {
    return getPaseoClient(serverId);
  } catch {
    return null;
  }
}

async function loadHostDirectory(host: HostScope): Promise<MonitorData> {
  const client = clientFor(host.serverId);
  if (!client) throw new Error(`host ${host.label} is not available`);
  return loadDirectory(client);
}

/**
 * Merge per-host directories. Workspace ids are daemon-scoped UUIDs and never
 * collide; project index keys can (the same repo registered on two hosts), so
 * each host's projects are indexed under `projectIndexKey(host, key)`.
 */
export function mergeHostDirectories(
  loaded: ReadonlyArray<{ host: HostScope; data: MonitorData }>,
): { entries: AgentEntry[]; directory: MonitorDirectory; truncated: boolean } {
  const entries: AgentEntry[] = [];
  const workspaces = new Map<string, WorkspaceSummary>();
  const projects = new Map<string, ProjectSummary>();
  let truncated = false;
  for (const { host, data } of loaded) {
    for (const entry of data.entries) entries.push(withHostScope(entry, host));
    for (const [id, workspace] of data.directory.workspaces) workspaces.set(id, workspace);
    for (const [key, project] of data.directory.projects) {
      projects.set(projectIndexKey(host, key), project);
    }
    truncated = truncated || data.truncated;
  }
  return { entries, directory: { workspaces, projects }, truncated };
}

/**
 * The monitor's multi-host directory query: one directory load per online
 * host, merged into a single entry list. Offline hosts are skipped; a host
 * that fails is left out of the merged data and reported by label.
 */
export function useAllHostsMonitor(): MultiHostMonitor {
  const hosts = useHosts();
  const online = useMemo(
    () =>
      hosts
        .filter((host) => host.status === "online")
        .map((host) => ({ serverId: host.serverId, label: host.label }))
        .sort((left, right) => left.serverId.localeCompare(right.serverId)),
    [hosts],
  );
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["agent-monitor", "agents", "all", online.map((host) => host.serverId).join(",")],
    [online],
  );
  // One observation and backstop per host client, however many components read
  // the data (the screen, the sidebar row, the popover). Keyed by connection so
  // a reconnect restarts it. Hidden windows skip refreshes; React Query refetches
  // the stale roster on refocus, which keeps the always-mounted sidebar row from
  // polling a backgrounded app.
  useEffect(() => {
    const releases = online.map((host) => {
      const client = clientFor(host.serverId);
      if (!client) return () => {};
      return retainShared(client, [...queryKey, host.serverId].join("/"), () => {
        const invalidate = () => {
          // cancelRefetch: false lets a slow in-flight load finish instead of restarting it.
          if (focusManager.isFocused()) {
            void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
          }
        };
        const invalidator = createDebouncedInvalidator(invalidate, REFRESH_DEBOUNCE_MS);
        const stopObserving = observeDirectoryInvalidation(client, invalidator.invalidate);
        const backstop = setInterval(invalidate, BACKSTOP_REFETCH_MS);
        return () => {
          clearInterval(backstop);
          invalidator.cancel();
          stopObserving();
        };
      });
    });
    return () => {
      for (const release of releases) release();
    };
  }, [online, queryClient, queryKey]);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const settled = await Promise.all(
        online.map(async (host) => {
          try {
            return { host, data: await loadHostDirectory(host), failed: false as const };
          } catch {
            return { host, data: null, failed: true as const };
          }
        }),
      );
      const failedHosts: string[] = [];
      const loaded: Array<{ host: HostScope; data: MonitorData }> = [];
      for (const part of settled) {
        if (part.failed) failedHosts.push(part.host.label);
        else loaded.push({ host: part.host, data: part.data as MonitorData });
      }
      const merged = mergeHostDirectories(loaded);
      return {
        entries: merged.entries,
        directory: merged.directory,
        truncated: merged.truncated,
        failedHosts,
      };
    },
    staleTime: 20_000,
    // A host going online or offline changes the key; keep the last roster on
    // screen (and the badge up) until the new host set loads.
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  return {
    hosts: online,
    entries: data?.entries ?? [],
    directory: data?.directory ?? emptyDirectory(),
    truncated: data?.truncated ?? false,
    failedHosts: data?.failedHosts ?? [],
    isPending: query.isPending,
    isFetching: query.isFetching,
    isPlaceholderData: query.isPlaceholderData,
    refetchAll: () => void query.refetch(),
  };
}
