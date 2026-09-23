import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QueenPillIcon, QueensPopover } from "./queens-popover";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

type AgentTarget = {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly status: string;
  readonly archivedAt?: string | null;
};

type AgentPage = {
  readonly entries: readonly { readonly agent: AgentTarget }[];
  readonly pageInfo: {
    readonly hasMore: boolean;
    readonly nextCursor?: string | null;
  };
};

export function registerQueensComposerPills(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let stopped = false;
  let removeObserver: (() => void) | undefined;
  let releaseObservation: (() => Promise<void>) | undefined;
  let snapshotGeneration = 0;
  let liveUpdateGeneration = 0;
  const liveUpdateGenerations = new Map<string, number>();
  const lifetime = new AbortController();

  const removePill = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const syncAgent = (agent: AgentTarget) => {
    if (!agent.workspaceId || agent.archivedAt || agent.status === "closed") {
      removePill(agent.id);
      return;
    }

    const current = pills.get(agent.id);
    if (current?.workspaceId === agent.workspaceId) return;
    removePill(agent.id);
    const pill = client.addComposerPill({
      id: "queens",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Queens",
        label: "Queens",
        icon: QueenPillIcon,
        behavior: { kind: "popover", Content: QueensPopover },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, remove: pill.remove });
  };

  const syncSnapshot = async (snapshot: AgentPage) => {
    if (stopped) return;
    const generation = ++snapshotGeneration;
    const liveUpdateGenerationAtStart = liveUpdateGeneration;
    const observedAgentIds = new Set<string>();
    for (const { agent } of snapshot.entries) {
      observedAgentIds.add(agent.id);
      syncAgent(agent);
    }

    let cursor = snapshot.pageInfo.hasMore
      ? (snapshot.pageInfo.nextCursor ?? undefined)
      : undefined;
    for (let page = 1; page < MAX_PAGES && cursor; page += 1) {
      const result = await client.paseo.agents.list({
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: PAGE_LIMIT, cursor },
      });
      if (stopped || generation !== snapshotGeneration) return;
      for (const { agent } of result.entries) {
        observedAgentIds.add(agent.id);
        if ((liveUpdateGenerations.get(agent.id) ?? 0) <= liveUpdateGenerationAtStart) {
          syncAgent(agent);
        }
      }
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    }
    if (cursor || stopped || generation !== snapshotGeneration) return;

    for (const agentId of pills.keys()) {
      if (
        !observedAgentIds.has(agentId) &&
        (liveUpdateGenerations.get(agentId) ?? 0) <= liveUpdateGenerationAtStart
      ) {
        removePill(agentId);
      }
    }
  };

  void client.paseo.agents
    .list({
      signal: lifetime.signal,
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT },
      subscribe: {},
    })
    .then(({ subscription }) => {
      if (stopped) return subscription.release();
      releaseObservation = () => subscription.release();
      removeObserver = subscription.subscribe({
        snapshot: (snapshot) => {
          void syncSnapshot(snapshot).catch(() => undefined);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            liveUpdateGenerations.set(update.agentId, ++liveUpdateGeneration);
            removePill(update.agentId);
          } else {
            liveUpdateGenerations.set(update.agent.id, ++liveUpdateGeneration);
            syncAgent(update.agent);
          }
        },
      });
      return undefined;
    })
    .catch(() => undefined);

  return () => {
    lifetime.abort();
    if (stopped) return;
    stopped = true;
    removeObserver?.();
    removeObserver = undefined;
    const release = releaseObservation;
    releaseObservation = undefined;
    if (release) void release().catch(() => undefined);
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
