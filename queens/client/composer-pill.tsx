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

export function registerQueensComposerPills(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let stopped = false;

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

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      removePill(update.agentId);
      return;
    }
    syncAgent(update.agent);
  });

  void (async () => {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await client.paseo.agents.list({
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      if (stopped) return;
      for (const { agent } of result.entries) syncAgent(agent);
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) return;
    }
  })().catch(() => undefined);

  return () => {
    stopped = true;
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
