import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { viewerScope } from "../shared/viewer-scope";
import { observeDirectoryInvalidation } from "./directory-observation";
import {
  type AgentEntry,
  applyViewerScope,
  buildRadarSnapshot,
  mergeInboxRows,
  type PaseoApi,
  type PaseoWorkspace,
} from "./radar";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

async function loadAgents(paseo: PaseoApi) {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    truncated = result.pageInfo.hasMore;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!truncated || !cursor) break;
  }
  return { entries, truncated };
}

async function loadWorkspaces(paseo: PaseoApi) {
  const entries: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    truncated = result.pageInfo.hasMore;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!truncated || !cursor) break;
  }
  return { entries, truncated };
}

// On 0.11 the sidebar owns refreshes; screens and popovers only observe the cache.
export function useRadar(hostId: string, windowDays = 30, live = true) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const resolveViewerScope = useRpc(viewerScope);
  const queryKey = useMemo(() => ["pr-radar", hostId], [hostId]);
  const directory = useQuery({
    queryKey,
    queryFn: async () => {
      const [workspaces, agents] = await Promise.all([loadWorkspaces(paseo), loadAgents(paseo)]);
      return {
        ...buildRadarSnapshot(workspaces.entries, agents.entries),
        truncated: workspaces.truncated || agents.truncated,
      };
    },
    staleTime: 60_000,
    refetchInterval: live ? 60_000 : false,
  });
  useEffect(() => {
    if (!live) return;
    return observeDirectoryInvalidation(
      paseo,
      () => void queryClient.invalidateQueries({ queryKey }),
      500,
    );
  }, [live, paseo, queryClient, queryKey]);
  const rawRows = directory.data?.rows ?? [];
  const scopeUrls = useMemo(() => rawRows.map((row) => row.url), [rawRows]);
  const viewer = useQuery({
    queryKey: ["pr-radar-viewer-scope", hostId, scopeUrls, windowDays],
    queryFn: () => resolveViewerScope({ urls: scopeUrls.slice(0, 200), windowDays }),
    enabled: Boolean(directory.data),
    staleTime: 5 * 60_000,
    refetchInterval: live ? 5 * 60_000 : false,
  });
  const rows = useMemo(
    () =>
      applyViewerScope(
        directory.data ? mergeInboxRows(directory.data, viewer.data?.inboxItems ?? []) : [],
        viewer.data ?? null,
      ),
    [directory.data, viewer.data],
  );
  const warnings: string[] = [];
  if (directory.error) warnings.push("Could not load the delivery queue.");
  if (directory.data?.truncated)
    warnings.push("Directory pagination limit reached; results are partial.");
  if (directory.data?.warnings.length)
    warnings.push("Some workspaces have unavailable pull request status.");
  if (!viewer.data || viewer.error || viewer.data.error || !viewer.data.viewer) {
    warnings.push("GitHub viewer identity is unavailable. Action buckets are conservative.");
  }
  if (scopeUrls.length > 200)
    warnings.push("Viewer lookup is limited to 200 linked pull requests.");
  if (viewer.data?.truncated) warnings.push("Results reached the 100-item inbox cap.");
  return {
    paseo,
    queryKey,
    rows,
    rawRows,
    warnings,
    data: directory.data,
    error: directory.error,
    isPending: directory.isPending,
    isFetching: directory.isFetching || viewer.isFetching,
    refetch: directory.refetch,
    viewerData: viewer.data,
    viewerError: viewer.data?.error ?? viewer.error,
    refetchViewer: viewer.refetch,
    loading: directory.isPending || (Boolean(directory.data) && viewer.isPending),
  };
}
