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

type ClaimJob = {
  workspaceIds: string[];
  retried: boolean;
};

type AutoOpenManager = {
  setEnabled(enabled: boolean): void;
  dispose(): void;
};

async function listWorkspaceIds(paseo: PluginClientContext["paseo"]): Promise<Set<string>> {
  const workspaceIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of result.entries) workspaceIds.add(workspace.id);
    if (!result.pageInfo.hasMore) return workspaceIds;
    const nextCursor = result.pageInfo.nextCursor ?? undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) return workspaceIds;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function startAutoOpen(client: PluginClientContext): () => void {
  const pending = new Set<string>();
  const buffered = new Set<string>();
  const jobs: ClaimJob[] = [];
  let known: Set<string> | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let removeObserver: (() => void) | undefined;
  let releaseSubscription: (() => Promise<void>) | undefined;
  let pumping = false;
  let closed = false;

  function schedule(delayMs: number) {
    if (closed || pumping || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void pump();
    }, delayMs);
  }

  function enqueue(workspaceId: string) {
    if (closed) return;
    pending.add(workspaceId);
    schedule(FLUSH_DELAY_MS);
  }

  function observe(workspaceId: string) {
    if (!known) {
      buffered.add(workspaceId);
      return;
    }
    if (known.has(workspaceId)) return;
    known.add(workspaceId);
    enqueue(workspaceId);
  }

  function drainPending() {
    const workspaceIds = [...pending];
    pending.clear();
    for (let index = 0; index < workspaceIds.length; index += MAX_AUTO_OPEN_CLAIM_BATCH) {
      jobs.push({
        workspaceIds: workspaceIds.slice(index, index + MAX_AUTO_OPEN_CLAIM_BATCH),
        retried: false,
      });
    }
  }

  async function pump() {
    if (closed || pumping) return;
    pumping = true;
    drainPending();
    while (!closed && jobs.length > 0) {
      const job = jobs.shift();
      if (!job) break;
      try {
        const { claimed } = await client.rpc(claimOpenedWorkspaces, {
          workspaceIds: job.workspaceIds,
        });
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
      } catch (error) {
        console.error("Agent Crew auto-open claim failed", error);
        if (!job.retried) {
          jobs.unshift({ ...job, retried: true });
          pumping = false;
          schedule(RETRY_DELAY_MS);
          return;
        }
      }
    }
    pumping = false;
    if (!closed && pending.size > 0) schedule(FLUSH_DELAY_MS);
  }

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (closed) return subscription.release();
      releaseSubscription = () => subscription.release();
      removeObserver = subscription.subscribe({
        snapshot() {},
        update(message) {
          if (message.type !== "workspace_update" || message.payload.kind !== "upsert") return;
          observe(message.payload.workspace.id);
        },
      });
      return listWorkspaceIds(client.paseo).then((workspaceIds) => {
        if (closed) return;
        known = workspaceIds;
        for (const workspaceId of buffered) observe(workspaceId);
        buffered.clear();
      });
    })
    .catch((error: unknown) => {
      if (!closed) console.error("Agent Crew auto-open observation failed", error);
    });

  return () => {
    closed = true;
    pending.clear();
    buffered.clear();
    jobs.length = 0;
    clearTimeout(flushTimer);
    removeObserver?.();
    void releaseSubscription?.();
    releaseSubscription = undefined;
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
      syncEnabled(parsed.success ? parsed.data.autoOpenExplorer : DEFAULT_AUTO_OPEN_EXPLORER);
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
    setEnabled(nextEnabled) {
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
