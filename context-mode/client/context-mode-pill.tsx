import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

type PillAgent = {
  id: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
};

type PillEntry = {
  workspaceId: string;
  registration: PluginButtonRegistration;
};

function shouldShowPill(agent: PillAgent): agent is PillAgent & { workspaceId: string } {
  return Boolean(agent.workspaceId) && !agent.archivedAt && agent.status !== "closed";
}

/** Adds a neutral Context Mode status shortcut to every active agent composer. */
export function contributeContextModeComposerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PillEntry>();
  const lifetime = new AbortController();
  let removeObserver: (() => void) | undefined;
  let stopped = false;

  function removePill(agentId: string): void {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  function syncAgent(agent: PillAgent): void {
    if (stopped) return;
    if (!shouldShowPill(agent)) {
      removePill(agent.id);
      return;
    }

    const current = pills.get(agent.id);
    if (current?.workspaceId === agent.workspaceId) return;
    removePill(agent.id);

    const registration = client.addComposerPill({
      id: "context-mode",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "View Context Mode status",
        icon: "Gauge",
        label: "Context Mode",
        behavior: {
          kind: "action",
          onPress() {
            client.openSurface("context-mode");
          },
        },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration });
  }

  function syncSnapshot(entries: readonly { agent: PillAgent }[]): void {
    if (stopped) return;
    const observedAgentIds = new Set<string>();
    for (const { agent } of entries) {
      if (shouldShowPill(agent)) observedAgentIds.add(agent.id);
      syncAgent(agent);
    }
    for (const agentId of pills.keys()) {
      if (!observedAgentIds.has(agentId)) removePill(agentId);
    }
  }

  void client.paseo.agents
    .list({
      filter: { includeArchived: false },
      subscribe: {},
      signal: lifetime.signal,
    })
    .then(({ subscription }) => {
      if (stopped) {
        return subscription.release();
      }
      removeObserver = subscription.subscribe({
        snapshot: ({ entries }) => syncSnapshot(entries),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") removePill(update.agentId);
          else syncAgent(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[context-mode] Agent observation failed", error);
    });

  return () => {
    if (stopped) return;
    stopped = true;
    removeObserver?.();
    lifetime.abort();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
