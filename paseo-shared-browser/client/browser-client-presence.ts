/** Own composer-pill presence subscription and paging; teardown fences late directory replies and releases only this contribution. */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listOpenBrowserWorkspacesRpc } from "../shared/browser";

const PILL_PRESENCE_POLL_MS = 2_000;
const AGENT_DIRECTORY_PAGE_LIMIT = 200;

interface AgentDirectoryPage {
  entries: Array<{ agent: { id: string; workspaceId?: string | undefined } }>;
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

type AgentDirectoryUpdate =
  | { kind: "remove"; agentId: string }
  | { kind: "upsert"; agent: { id: string; workspaceId?: string | undefined } };
type AgentPlacement = { id: string; workspaceId: string };

/** Add workspace browser pills for active agents; cleanup is idempotent and stops late publication. */
export function contributeSharedBrowserClient(client: PluginClientContext) {
  const agents = new Map<string, AgentPlacement>();
  const pills = new Map<string, { workspaceId: string; remove: () => void }>();
  const lifetime = new AbortController();
  let openWorkspaceIds = new Set<string>();
  let refreshing = false;
  let stopped = false;
  let directoryGeneration = 0;
  let pendingDirectory: { generation: number; updates: AgentDirectoryUpdate[] } | null = null;
  let unsubscribeDirectory: (() => void) | null = null;
  let releaseDirectory: (() => Promise<void>) | null = null;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };
  const syncPill = (agent: AgentPlacement) => {
    const current = pills.get(agent.id);
    if (!openWorkspaceIds.has(agent.workspaceId)) {
      removePill(agent.id);
      return;
    }
    if (current?.workspaceId === agent.workspaceId) return;
    removePill(agent.id);
    const workspaceId = agent.workspaceId;
    const pill = client.addComposerPill({
      id: "open-shared-browser",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Open Shared Browser",
        icon: "PanelsTopLeft",
        label: "Shared Browser",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("shared-browser", { workspaceId });
          },
        },
      },
    });
    pills.set(agent.id, { workspaceId, remove: pill.remove });
  };
  const syncAllPills = () => {
    for (const agent of agents.values()) syncPill(agent);
  };
  const refreshPresence = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const result = await client.rpc(listOpenBrowserWorkspacesRpc, {});
      if (stopped) return;
      openWorkspaceIds = new Set(result.workspaceIds);
      syncAllPills();
    } catch {
      return;
    } finally {
      refreshing = false;
    }
  };
  const applyUpdate = (target: Map<string, AgentPlacement>, update: AgentDirectoryUpdate) => {
    if (update.kind === "remove") {
      target.delete(update.agentId);
      return;
    }
    const { id, workspaceId } = update.agent;
    if (workspaceId) target.set(id, { id, workspaceId });
    else target.delete(id);
  };
  const applyLiveUpdate = (update: AgentDirectoryUpdate) => {
    if (stopped) return;
    pendingDirectory?.updates.push(update);
    applyUpdate(agents, update);
    if (update.kind === "remove") {
      removePill(update.agentId);
      return;
    }
    const { id, workspaceId } = update.agent;
    if (!workspaceId) {
      removePill(id);
      return;
    }
    syncPill({ id, workspaceId });
    void refreshPresence();
  };
  const replaceAgents = (next: Map<string, AgentPlacement>) => {
    for (const agentId of agents.keys()) {
      if (!next.has(agentId)) removePill(agentId);
    }
    agents.clear();
    for (const [agentId, agent] of next) agents.set(agentId, agent);
    syncAllPills();
  };
  const followSnapshot = async (snapshot: AgentDirectoryPage) => {
    if (stopped) return;
    const generation = ++directoryGeneration;
    const transaction = { generation, updates: [] as AgentDirectoryUpdate[] };
    pendingDirectory = transaction;
    const next = new Map<string, AgentPlacement>();
    for (const { agent } of snapshot.entries) {
      if (agent.workspaceId) next.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId });
    }

    try {
      let cursor = snapshot.pageInfo.hasMore ? snapshot.pageInfo.nextCursor : null;
      while (cursor) {
        const page = await client.paseo.agents.list({
          scope: "active",
          page: { limit: AGENT_DIRECTORY_PAGE_LIMIT, cursor },
          signal: lifetime.signal,
        });
        if (stopped || pendingDirectory?.generation !== generation) return;
        for (const { agent } of page.entries) {
          if (agent.workspaceId)
            next.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId });
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      }
      if (stopped || pendingDirectory?.generation !== generation) return;
      for (const update of transaction.updates) applyUpdate(next, update);
      pendingDirectory = null;
      replaceAgents(next);
      await refreshPresence();
    } catch {
      if (!stopped && pendingDirectory?.generation === generation) pendingDirectory = null;
    }
  };

  void client.paseo.agents
    .list({
      scope: "active",
      page: { limit: AGENT_DIRECTORY_PAGE_LIMIT },
      subscribe: {},
      signal: lifetime.signal,
    })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release().catch(() => undefined);
        return undefined;
      }
      releaseDirectory = subscription.release;
      unsubscribeDirectory = subscription.subscribe({
        snapshot: (snapshot) => void followSnapshot(snapshot),
        update: (message) => {
          if (message.type === "agent_update") applyLiveUpdate(message.payload);
        },
      });
      return undefined;
    })
    .catch(() => undefined);
  const presenceTimer = setInterval(() => void refreshPresence(), PILL_PRESENCE_POLL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    directoryGeneration += 1;
    pendingDirectory = null;
    clearInterval(presenceTimer);
    unsubscribeDirectory?.();
    void releaseDirectory?.().catch(() => undefined);
    lifetime.abort();
    for (const { remove } of pills.values()) remove();
    pills.clear();
    agents.clear();
  };
}
