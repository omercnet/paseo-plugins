import type { PluginClientContext } from "@getpaseo/plugin/client";
import { claimOpenedWorkspaces, MAX_AUTO_OPEN_CLAIM_BATCH } from "../shared/auto-open";
import {
  agentCrewSettingsRpc,
  agentCrewSettingsSchema,
  DEFAULT_AUTO_OPEN_EXPLORER,
} from "../shared/settings";

const FLUSH_DELAY_MS = 400;
const RETRY_DELAY_MS = 2000;
const PAGE_LIMIT = 200;
const SETTINGS_POLL_MS = 15_000;

export interface AutoOpenManager {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

async function listAllWorkspaceIds(paseo: PluginClientContext["paseo"]): Promise<string[]> {
  const workspaceIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of result.entries) workspaceIds.push(workspace.id);
    if (!result.pageInfo.hasMore) break;
    const nextCursor = result.pageInfo.nextCursor ?? undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return workspaceIds;
}

export function startAutoOpen(client: PluginClientContext): () => void {
  const seen = new Set<string>();
  const failureCounts = new Map<string, number>();
  let pending: string[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function scheduleFlush(delayMs: number, force = false) {
    if (closed) return;
    if (flushTimer && !force) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, delayMs);
  }

  function enqueue(workspaceId: string) {
    if (closed || seen.has(workspaceId)) return;
    seen.add(workspaceId);
    pending.push(workspaceId);
    scheduleFlush(FLUSH_DELAY_MS);
  }

  function queueRetry(workspaceIds: readonly string[]): string[] {
    const retryable: string[] = [];
    for (const workspaceId of workspaceIds) {
      const failures = failureCounts.get(workspaceId) ?? 0;
      if (failures >= 1) continue;
      failureCounts.set(workspaceId, failures + 1);
      seen.delete(workspaceId);
      retryable.push(workspaceId);
    }
    return retryable;
  }

  async function flush() {
    const batch = pending;
    pending = [];
    if (batch.length === 0 || closed) return;
    let chunkIndex = 0;
    let currentChunk: string[] = [];
    try {
      for (chunkIndex = 0; chunkIndex < batch.length; chunkIndex += MAX_AUTO_OPEN_CLAIM_BATCH) {
        if (closed) return;
        currentChunk = batch.slice(chunkIndex, chunkIndex + MAX_AUTO_OPEN_CLAIM_BATCH);
        const { claimed } = await client.rpc(claimOpenedWorkspaces, { workspaceIds: currentChunk });
        for (const workspaceId of claimed) {
          try {
            client.openPanel("crew", { workspaceId, location: "explorer" });
          } catch (error) {
            console.error(
              `Agent Crew auto-open could not open the panel for workspace ${workspaceId}`,
              error,
            );
          }
        }
      }
    } catch (error) {
      console.error("Agent Crew auto-open claim failed", error);
      if (closed) return;
      const failedChunk = queueRetry(currentChunk);
      const remainder = batch.slice(chunkIndex + MAX_AUTO_OPEN_CLAIM_BATCH);
      const spillover = pending;
      pending = [...failedChunk, ...remainder, ...spillover];
      if (pending.length > 0) scheduleFlush(RETRY_DELAY_MS, true);
    }
  }

  const unsubscribeWorkspaces = client.paseo.workspaces.subscribe((update) => {
    if (update.kind !== "upsert") return;
    enqueue(update.workspace.id);
  });

  void listAllWorkspaceIds(client.paseo)
    .then((workspaceIds) => {
      if (closed) return;
      for (const workspaceId of workspaceIds) enqueue(workspaceId);
    })
    .catch((error: unknown) => {
      if (closed) return;
      console.error("Agent Crew auto-open directory listing failed", error);
    });

  return () => {
    closed = true;
    clearTimeout(flushTimer);
    unsubscribeWorkspaces();
  };
}

export function createAutoOpenManager(client: PluginClientContext): AutoOpenManager {
  let enabled = DEFAULT_AUTO_OPEN_EXPLORER;
  let activeCleanup: (() => void) | undefined;
  let disposed = false;
  let refreshRunning = false;
  let generation = 0;
  const pollTimer = setInterval(() => {
    void refreshEnabled();
  }, SETTINGS_POLL_MS);

  function syncEnabled(nextEnabled: boolean) {
    if (disposed || nextEnabled === enabled) return;
    enabled = nextEnabled;
    activeCleanup?.();
    activeCleanup = enabled ? startAutoOpen(client) : undefined;
  }

  async function refreshEnabled() {
    if (disposed || refreshRunning) return;
    refreshRunning = true;
    const requestGeneration = generation;
    try {
      const result = await client.rpc(agentCrewSettingsRpc.read, {});
      if (disposed || requestGeneration !== generation) return;
      if (result.status !== "ready") {
        syncEnabled(DEFAULT_AUTO_OPEN_EXPLORER);
        return;
      }
      const parsed = agentCrewSettingsSchema.safeParse(result.values);
      if (!parsed.success) {
        syncEnabled(DEFAULT_AUTO_OPEN_EXPLORER);
        return;
      }
      syncEnabled(parsed.data.autoOpenExplorer);
    } catch (error) {
      if (disposed || requestGeneration !== generation) return;
      console.error("Agent Crew auto-open settings read failed", error);
      syncEnabled(DEFAULT_AUTO_OPEN_EXPLORER);
    } finally {
      refreshRunning = false;
    }
  }

  void refreshEnabled();

  return {
    setEnabled(nextEnabled: boolean) {
      generation += 1;
      syncEnabled(nextEnabled);
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearInterval(pollTimer);
      activeCleanup?.();
      activeCleanup = undefined;
    },
  };
}
