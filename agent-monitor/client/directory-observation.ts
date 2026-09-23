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
