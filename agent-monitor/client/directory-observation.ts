import type { PaseoApi } from "./monitor";

export function createDebouncedInvalidator(invalidate: () => void, delayMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return {
    invalidate() {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = undefined;
        invalidate();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timeout);
      timeout = undefined;
    },
  };
}

type SharedEntry = { holders: number; stop(): void };
const sharedEntries = new WeakMap<object, Map<string, SharedEntry>>();

/**
 * Runs `start` once per owner and key however many holders retain it, and calls the cleanup it
 * returns when the last holder releases. Each release is idempotent, so a repeated call cannot
 * stop work another holder still uses.
 */
export function retainShared(owner: object, key: string, start: () => () => void): () => void {
  let byKey = sharedEntries.get(owner);
  if (!byKey) {
    byKey = new Map();
    sharedEntries.set(owner, byKey);
  }
  const entries = byKey;
  let entry = entries.get(key);
  if (!entry) {
    entry = { holders: 0, stop: start() };
    entries.set(key, entry);
  }
  const held = entry;
  held.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    entries.delete(key);
    held.stop();
  };
}

export function observeDirectoryInvalidation(paseo: PaseoApi, invalidate: () => void): () => void {
  const subscriptions = new Set<{
    kind: "agent" | "workspace";
    unsubscribe: () => void;
    release: () => Promise<void>;
  }>();
  let stopped = false;

  const attachAgents = async () => {
    const { subscription } = await paseo.agents.list({ subscribe: {} });
    if (stopped) {
      await subscription.release().catch((error: unknown) => {
        console.error("Agent Monitor agent observation cleanup failed", error);
      });
      return;
    }
    subscriptions.add({
      kind: "agent",
      unsubscribe: subscription.subscribe({ snapshot: invalidate, update: invalidate }),
      release: subscription.release,
    });
  };

  const attachWorkspaces = async () => {
    const { subscription } = await paseo.workspaces.list({ subscribe: {} });
    if (stopped) {
      await subscription.release().catch((error: unknown) => {
        console.error("Agent Monitor workspace observation cleanup failed", error);
      });
      return;
    }
    subscriptions.add({
      kind: "workspace",
      unsubscribe: subscription.subscribe({ snapshot: invalidate, update: invalidate }),
      release: subscription.release,
    });
  };

  const reportFailure = (kind: "agent" | "workspace") => (error: unknown) => {
    if (!stopped) console.error(`Agent Monitor ${kind} observation failed`, error);
  };

  void attachAgents().catch(reportFailure("agent"));
  void attachWorkspaces().catch(reportFailure("workspace"));
  const unsubscribeProjects = paseo.projects.subscribe(invalidate);

  return () => {
    stopped = true;
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
      void subscription.release().catch((error: unknown) => {
        console.error(`Agent Monitor ${subscription.kind} observation cleanup failed`, error);
      });
    }
    subscriptions.clear();
    unsubscribeProjects();
  };
}
