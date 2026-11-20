import { isHelperAgent, type PaseoApi } from "./radar";

interface AgentUpdate {
  id?: unknown;
  workspaceId?: unknown;
  title?: unknown;
  status?: unknown;
  requiresAttention?: unknown;
  attentionReason?: unknown;
  pendingPermissions?: unknown;
  archivedAt?: unknown;
}

// The agent fields buildRadarSnapshot and toRadarAgent read, minus `updatedAt`. The daemon touches
// `updatedAt` and re-publishes a running agent on every usage report, so refetching on it rescanned
// the directory every second or two. `updatedAt` only orders agents inside a row; the poll keeps it.
// `archivedAt` is in, so archiving or restoring an agent that nothing else changed still refreshes.
function rowFields(agent: AgentUpdate): string {
  return JSON.stringify([
    agent.workspaceId,
    agent.title,
    agent.status,
    agent.requiresAttention,
    agent.attentionReason,
    agent.pendingPermissions,
    agent.archivedAt,
  ]);
}

function isArchived(agent: AgentUpdate): boolean {
  return typeof agent.archivedAt === "string";
}

/**
 * Skips agent updates that cannot change a row: helpers (fixed at creation, so an upsert
 * identifies one and the later removal reuses that knowledge) and repeat upserts of a user agent
 * whose row fields are unchanged. Anything unrecognised still invalidates.
 */
function quietUpdateFilter() {
  const helperIds = new Set<string>();
  const shownFields = new Map<string, string>();
  return (message: unknown): boolean => {
    if (typeof message !== "object" || message === null) return false;
    const { type, payload } = message as {
      type?: unknown;
      payload?: {
        kind?: unknown;
        agent?: AgentUpdate | null;
        agentId?: unknown;
      };
    };
    if (type !== "agent_update" || !payload) return false;
    if (payload.kind === "upsert" && payload.agent && typeof payload.agent.id === "string") {
      if (isHelperAgent(payload.agent)) {
        helperIds.add(payload.agent.id);
        return true;
      }
      const fields = rowFields(payload.agent);
      const unchanged = shownFields.get(payload.agent.id) === fields;
      // An archived agent has no row to keep current, so its snapshot (title, permissions, ...) is
      // freed now instead of at removal. A repeat archive upsert then invalidates once more.
      if (isArchived(payload.agent)) {
        shownFields.delete(payload.agent.id);
      } else {
        shownFields.set(payload.agent.id, fields);
      }
      return unchanged;
    }
    if (payload.kind === "remove" && typeof payload.agentId === "string") {
      shownFields.delete(payload.agentId);
      return helperIds.delete(payload.agentId);
    }
    return false;
  };
}

export function observeDirectoryInvalidation(
  paseo: PaseoApi,
  invalidate: () => void,
  debounceMs: number,
): () => void {
  const lifetime = new AbortController();
  const subscriptions: Array<{ release(): Promise<void> }> = [];
  const unsubscribes: Array<() => void> = [];
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const scheduleInvalidation = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) invalidate();
    }, debounceMs);
  };
  const attach = (
    subscription: {
      subscribe(observer: { snapshot(): void; update(message: unknown): void }): () => void;
      release(): Promise<void>;
    },
    ignore: (message: unknown) => boolean = () => false,
  ) => {
    subscriptions.push(subscription);
    if (stopped) {
      void subscription.release().catch(() => undefined);
      return;
    }
    unsubscribes.push(
      subscription.subscribe({
        snapshot: scheduleInvalidation,
        update: (message) => {
          if (!ignore(message)) scheduleInvalidation();
        },
      }),
    );
  };

  void paseo.agents
    .list({ subscribe: {}, includeBackground: true, signal: lifetime.signal })
    .then(({ subscription }) => attach(subscription, quietUpdateFilter()))
    .catch(() => undefined);
  void paseo.workspaces
    .list({ subscribe: {}, includeBackground: true })
    .then(({ subscription }) => attach(subscription))
    .catch(() => undefined);

  return () => {
    stopped = true;
    lifetime.abort();
    if (timer !== undefined) clearTimeout(timer);
    for (const unsubscribe of unsubscribes) unsubscribe();
    void Promise.all(subscriptions.map((subscription) => subscription.release())).catch(
      () => undefined,
    );
  };
}
