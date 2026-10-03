export interface StaleWorkspace {
  id: string;
  projectRootPath: string;
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
  refreshAll(): Promise<RefreshReport>;
}

export type RefreshOutcome = "updated" | "unchanged" | "dirty" | "unavailable";
export interface RefreshReport {
  updated: number;
  unchanged: number;
  dirty: number;
  unavailable: number;
  failed: number;
}

export function describeRefresh(report: RefreshReport): string {
  const parts: string[] = [];
  if (report.updated) parts.push(`Fast-forwarded ${report.updated}.`);
  if (report.dirty) parts.push(`${report.dirty} skipped: source checkout has uncommitted changes.`);
  if (report.unavailable) parts.push(`${report.unavailable} could not be refreshed.`);
  if (report.failed) parts.push(`${report.failed} failed.`);
  if (report.unchanged) parts.push(`${report.unchanged} source already up to date.`);
  return parts.join(" ");
}

export interface RefreshActions {
  refreshRoot(projectRootPath: string): Promise<RefreshOutcome>;
  recheck(workspaceId: string): Promise<void>;
}

export function createWorkspaceSummary({ refreshRoot, recheck }: RefreshActions): WorkspaceSummary {
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
      const byRoot = new Map<string, string[]>();
      for (const { id, projectRootPath } of entries) {
        byRoot.set(projectRootPath, [...(byRoot.get(projectRootPath) ?? []), id]);
      }
      const report: RefreshReport = {
        updated: 0,
        unchanged: 0,
        dirty: 0,
        unavailable: 0,
        failed: 0,
      };
      await Promise.all(
        [...byRoot].map(async ([projectRootPath, ids]) => {
          try {
            report[await refreshRoot(projectRootPath)]++;
          } catch {
            report.failed++;
          }
          await Promise.allSettled(ids.map(recheck));
        }),
      );
      return report;
    },
  };
}
