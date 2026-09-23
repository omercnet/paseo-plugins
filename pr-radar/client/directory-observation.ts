import type { PaseoApi } from "./radar";

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
  const attach = (subscription: {
    subscribe(observer: { snapshot(): void; update(message: unknown): void }): () => void;
    release(): Promise<void>;
  }) => {
    subscriptions.push(subscription);
    if (stopped) {
      void subscription.release().catch(() => undefined);
      return;
    }
    unsubscribes.push(
      subscription.subscribe({
        snapshot: scheduleInvalidation,
        update: scheduleInvalidation,
      }),
    );
  };

  void paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => attach(subscription))
    .catch(() => undefined);
  void paseo.workspaces
    .list({ subscribe: {} })
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
