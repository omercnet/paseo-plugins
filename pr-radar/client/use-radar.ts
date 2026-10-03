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
import { radarWarnings, VIEWER_URL_LIMIT } from "./screen-state";

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

// `live` owns the refresh timers. The sidebar is live unless the screen is open (the screen is
// then live); popovers only observe the cache.
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
  // One deduped, ordered, capped list feeds both the query key and the request.
  const scopeUrls = useMemo(
    () => [...new Set(rawRows.map((row) => row.url))].sort().slice(0, VIEWER_URL_LIMIT),
    [rawRows],
  );
  const viewer = useQuery({
    queryKey: ["pr-radar-viewer-scope", hostId, scopeUrls, windowDays],
    queryFn: () => resolveViewerScope({ urls: scopeUrls, windowDays }),
    enabled: Boolean(directory.data),
    staleTime: 5 * 60_000,
    refetchInterval: live ? 5 * 60_000 : false,
  });
  useEffect(() => {
    if (!live) return;
    // Timers pause while not live; catch up on resume instead of waiting out the interval.
    void queryClient.refetchQueries({ queryKey, stale: true });
    void queryClient.refetchQueries({ queryKey: ["pr-radar-viewer-scope", hostId], stale: true });
  }, [live, queryClient, queryKey, hostId]);
  const rows = useMemo(
    () =>
      applyViewerScope(
        directory.data ? mergeInboxRows(directory.data, viewer.data?.inboxItems ?? []) : [],
        viewer.data ?? null,
      ),
    [directory.data, viewer.data],
  );
  const warnings = radarWarnings({
    directoryError: Boolean(directory.error),
    directoryTruncated: Boolean(directory.data?.truncated),
    workspaceWarnings: directory.data?.warnings.length ?? 0,
    viewerKnown: Boolean(viewer.data?.viewer) && !viewer.data?.error && !viewer.error,
    viewerTruncated: Boolean(viewer.data?.truncated),
    urlCount: new Set(rawRows.map((row) => row.url)).size,
  });
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
