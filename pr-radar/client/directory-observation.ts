import { isHelperAgent, type PaseoApi } from "./radar";

/**
 * Tracks helpers seen on the agent stream so their updates do not refetch the directory. Helpers
 * are fixed at creation, so an upsert identifies one and the later removal reuses that knowledge.
 * Anything unrecognised still invalidates.
 */
function helperUpdateFilter() {
  const helperIds = new Set<string>();
  return (message: unknown): boolean => {
    if (typeof message !== "object" || message === null) return false;
    const { type, payload } = message as {
      type?: unknown;
      payload?: {
        kind?: unknown;
        agent?: { id?: unknown } | null;
        agentId?: unknown;
      };
    };
    if (type !== "agent_update" || !payload) return false;
    if (payload.kind === "upsert" && payload.agent && typeof payload.agent.id === "string") {
      if (!isHelperAgent(payload.agent)) return false;
      helperIds.add(payload.agent.id);
      return true;
    }
    if (payload.kind === "remove" && typeof payload.agentId === "string") {
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
    .then(({ subscription }) => attach(subscription, helperUpdateFilter()))
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
