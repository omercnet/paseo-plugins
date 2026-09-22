import type { PluginClientContext } from "@getpaseo/plugin/client";
import { claimOpenedWorkspaces } from "../shared/auto-open";

const FLUSH_DELAY_MS = 400;
const RETRY_DELAY_MS = 2000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

async function listAllWorkspaceIds(paseo: PluginClientContext["paseo"]): Promise<string[]> {
  const workspaceIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of result.entries) workspaceIds.push(workspace.id);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return workspaceIds;
}

export function startAutoOpen(client: PluginClientContext): () => void {
  const seen = new Set<string>();
  const retried = new Set<string>();
  let pending: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleFlush(delayMs: number) {
    if (stopped || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  }

  function enqueue(workspaceId: string) {
    if (stopped || seen.has(workspaceId)) return;
    seen.add(workspaceId);
    pending.push(workspaceId);
    scheduleFlush(FLUSH_DELAY_MS);
  }

  async function flush() {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    try {
      const { claimed } = await client.rpc(claimOpenedWorkspaces, { workspaceIds: batch });
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
      const retryable = batch.filter((workspaceId) => !retried.has(workspaceId));
      for (const workspaceId of retryable) {
        retried.add(workspaceId);
        seen.delete(workspaceId);
        pending.push(workspaceId);
      }
      if (retryable.length > 0) scheduleFlush(RETRY_DELAY_MS);
    }
  }

  const unsubscribeWorkspaces = client.paseo.workspaces.subscribe((update) => {
    if (update.kind !== "upsert") return;
    enqueue(update.workspace.id);
  });

  void listAllWorkspaceIds(client.paseo)
    .then((workspaceIds) => {
      for (const workspaceId of workspaceIds) enqueue(workspaceId);
    })
    .catch((error: unknown) => {
      console.error("Agent Crew auto-open directory listing failed", error);
    });

  return () => {
    stopped = true;
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribeWorkspaces();
  };
}
