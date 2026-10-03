export interface StaleWorkspace {
  id: string;
  directory: string;
  remoteRef: string;
  behindBy: number;
}

export interface WorkspaceSummary {
  getSnapshot(): readonly StaleWorkspace[];
  subscribe(listener: () => void): () => void;
  set(entry: StaleWorkspace): void;
  remove(id: string): void;
  clear(): void;
  refreshAll(): Promise<void>;
}

export function createWorkspaceSummary(check: (id: string) => Promise<void>): WorkspaceSummary {
  let entries: readonly StaleWorkspace[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly StaleWorkspace[]) {
    entries = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(entry: StaleWorkspace) {
      publish([...entries.filter(({ id }) => id !== entry.id), entry]);
    },
    remove(id: string) {
      if (entries.some((entry) => entry.id === id)) {
        publish(entries.filter((entry) => entry.id !== id));
      }
    },
    clear() {
      publish([]);
    },
    async refreshAll() {
      const results = await Promise.allSettled(entries.map(({ id }) => check(id)));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new Error(`Could not refresh ${failures.length} workspace(s).`);
    },
  };
}
