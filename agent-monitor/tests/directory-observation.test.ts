import { describe, expect, test, vi } from "vitest";
import {
  createDebouncedInvalidator,
  observeDirectoryInvalidation,
} from "../client/directory-observation";
import type { PaseoApi } from "../client/monitor";

type DirectoryObserver = {
  snapshot(): void;
  update(): void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createDirectorySubscription() {
  let observer: DirectoryObserver | undefined;
  const release = vi.fn(async () => {});
  const subscription = {
    subscribe(next: DirectoryObserver) {
      observer = next;
      next.snapshot();
      return () => {
        observer = undefined;
      };
    },
    release,
  };
  return {
    subscription,
    emitUpdate() {
      observer?.update();
    },
  };
}

function createPaseoHarness() {
  const agents = createDirectorySubscription();
  const workspaces = createDirectorySubscription();
  let projectListener: (() => void) | undefined;
  const unsubscribeProjects = vi.fn(() => {
    projectListener = undefined;
  });
  const paseo = {
    agents: { list: vi.fn(async () => ({ subscription: agents.subscription })) },
    workspaces: { list: vi.fn(async () => ({ subscription: workspaces.subscription })) },
    projects: {
      subscribe(listener: () => void) {
        projectListener = listener;
        return unsubscribeProjects;
      },
    },
  } as unknown as PaseoApi;
  return {
    agents,
    workspaces,
    paseo,
    emitProjectUpdate() {
      projectListener?.();
    },
    unsubscribeProjects,
  };
}

async function settleObservations() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("directory invalidation observations", () => {
  test("invalidates for owned agent and workspace snapshots and updates", async () => {
    const harness = createPaseoHarness();
    const invalidate = vi.fn();

    const stop = observeDirectoryInvalidation(harness.paseo, invalidate);
    await settleObservations();

    expect(harness.paseo.agents.list).toHaveBeenCalledWith({ subscribe: {} });
    expect(harness.paseo.workspaces.list).toHaveBeenCalledWith({ subscribe: {} });
    expect(invalidate).toHaveBeenCalledTimes(2);

    harness.agents.emitUpdate();
    harness.workspaces.emitUpdate();

    expect(invalidate).toHaveBeenCalledTimes(4);

    stop();

    expect(harness.agents.subscription.release).toHaveBeenCalledOnce();
    expect(harness.workspaces.subscription.release).toHaveBeenCalledOnce();
    expect(harness.unsubscribeProjects).toHaveBeenCalledOnce();

    harness.agents.emitUpdate();
    harness.workspaces.emitUpdate();

    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  test("keeps project updates on their existing subscription", async () => {
    const harness = createPaseoHarness();
    const invalidate = vi.fn();

    const stop = observeDirectoryInvalidation(harness.paseo, invalidate);
    await settleObservations();
    harness.emitProjectUpdate();

    expect(invalidate).toHaveBeenCalledTimes(3);

    stop();
  });

  test("reports rejected releases from observations resolving after cleanup", async () => {
    const agents = createDirectorySubscription();
    const workspaces = createDirectorySubscription();
    const listedAgents = deferred<{ subscription: typeof agents.subscription }>();
    const listedWorkspaces = deferred<{ subscription: typeof workspaces.subscription }>();
    const releaseFailure = new Error("release failed");
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const paseo = {
      agents: { list: vi.fn(() => listedAgents.promise) },
      workspaces: { list: vi.fn(() => listedWorkspaces.promise) },
      projects: { subscribe: vi.fn(() => () => {}) },
    } as unknown as PaseoApi;

    const stop = observeDirectoryInvalidation(paseo, vi.fn());
    stop();
    agents.subscription.release.mockRejectedValueOnce(releaseFailure);
    workspaces.subscription.release.mockRejectedValueOnce(releaseFailure);
    listedAgents.resolve({ subscription: agents.subscription });
    listedWorkspaces.resolve({ subscription: workspaces.subscription });
    await settleObservations();

    expect(agents.subscription.release).toHaveBeenCalledOnce();
    expect(workspaces.subscription.release).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      "Agent Monitor agent observation cleanup failed",
      releaseFailure,
    );
    expect(reportError).toHaveBeenCalledWith(
      "Agent Monitor workspace observation cleanup failed",
      releaseFailure,
    );
    reportError.mockRestore();
  });
});

describe("debounced directory invalidation", () => {
  test("cancels pending invalidation during effect cleanup", async () => {
    vi.useFakeTimers();
    try {
      const invalidate = vi.fn();
      const debounced = createDebouncedInvalidator(invalidate, 750);

      debounced.invalidate();
      debounced.invalidate();
      debounced.cancel();
      await vi.runAllTimersAsync();

      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
