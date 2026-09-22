import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAutoOpenManager } from "../client/auto-open";
import {
  createAutoOpenClaimHandler,
  createFileAutoOpenStore,
  createMemoryAutoOpenStore,
} from "../server/auto-open";
import {
  claimOpenedWorkspaces,
  claimUnclaimedWorkspaces,
  MAX_AUTO_OPEN_CLAIM_BATCH,
} from "../shared/auto-open";
import { agentCrewSettingsRpc } from "../shared/settings";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type SettingsReadResult = {
  status: "ready";
  values: { autoOpenExplorer: boolean };
  revision: string;
};

type ClaimResult = { claimed: string[] };

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockClient(
  options: {
    initialEnabled?: boolean;
    workspaceIds?: string[];
    settingsRead?: Promise<SettingsReadResult>;
    claimDeferred?: Deferred<ClaimResult>;
    claimResponder?: (
      workspaceIds: string[],
      callIndex: number,
    ) => Promise<ClaimResult> | ClaimResult;
  } = {},
) {
  const {
    initialEnabled = false,
    workspaceIds = [],
    settingsRead,
    claimDeferred,
    claimResponder,
  } = options;
  let subscriber: ((update: { kind: string; workspace: { id: string } }) => void) | undefined;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let listCalls = 0;
  const claimCalls: string[][] = [];

  const client = {
    rpc: vi.fn(async (contract: unknown, input: { workspaceIds?: string[] }) => {
      if (contract === agentCrewSettingsRpc.read) {
        if (settingsRead) return settingsRead;
        return {
          status: "ready",
          values: { autoOpenExplorer: initialEnabled },
          revision: "rev-1",
        } satisfies SettingsReadResult;
      }
      if (contract === claimOpenedWorkspaces) {
        const workspaceIds = input.workspaceIds ?? [];
        claimCalls.push(workspaceIds);
        if (claimResponder) return claimResponder(workspaceIds, claimCalls.length);
        if (claimDeferred) return claimDeferred.promise;
        return { claimed: workspaceIds } satisfies ClaimResult;
      }
      throw new Error("unexpected rpc");
    }),
    openPanel: vi.fn(),
    paseo: {
      workspaces: {
        list: vi.fn(async ({ page }: { page?: { limit?: number; cursor?: string } } = {}) => {
          listCalls += 1;
          const limit = page?.limit ?? workspaceIds.length;
          const start = page?.cursor ? Number(page.cursor) : 0;
          const entries = workspaceIds.slice(start, start + limit).map((id) => ({ id }));
          const next = start + limit;
          const hasMore = next < workspaceIds.length;
          return {
            entries,
            pageInfo: { hasMore, nextCursor: hasMore ? String(next) : null },
          };
        }),
        subscribe: vi.fn((callback: typeof subscriber) => {
          subscriber = callback;
          subscribeCalls += 1;
          return () => {
            unsubscribeCalls += 1;
            subscriber = undefined;
          };
        }),
      },
    },
  } as unknown as PluginClientContext;

  return {
    client,
    emitWorkspace(workspaceId: string) {
      subscriber?.({ kind: "upsert", workspace: { id: workspaceId } });
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get listCalls() {
      return listCalls;
    },
    get claimCalls() {
      return claimCalls;
    },
  };
}

function ids(count: number, prefix = "ws"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

describe("claimUnclaimedWorkspaces", () => {
  test("returns only candidates that were never opened", () => {
    const opened = new Set(["ws-1", "ws-2"]);
    expect(claimUnclaimedWorkspaces(opened, ["ws-1", "ws-3", "ws-2", "ws-4"])).toEqual([
      "ws-3",
      "ws-4",
    ]);
  });

  test("removes duplicate candidates within one batch", () => {
    expect(claimUnclaimedWorkspaces(new Set(), ["ws-1", "ws-1", "ws-2", "ws-1"])).toEqual([
      "ws-1",
      "ws-2",
    ]);
  });

  test("returns an empty list when everything was opened", () => {
    const opened = new Set(["ws-1"]);
    expect(claimUnclaimedWorkspaces(opened, ["ws-1"])).toEqual([]);
  });
});

describe("createAutoOpenClaimHandler", () => {
  test("claims and persists each workspace exactly once", async () => {
    const handler = createAutoOpenClaimHandler(createMemoryAutoOpenStore());

    const first = await handler({ workspaceIds: ["ws-1", "ws-2"] });
    const second = await handler({ workspaceIds: ["ws-1", "ws-2", "ws-3"] });

    expect(first.claimed).toEqual(["ws-1", "ws-2"]);
    expect(second.claimed).toEqual(["ws-3"]);
  });

  test("returns nothing new for a repeated workspace after a restart", async () => {
    const store = createMemoryAutoOpenStore();
    const firstHandler = createAutoOpenClaimHandler(store);
    await firstHandler({ workspaceIds: ["ws-1"] });

    const secondHandler = createAutoOpenClaimHandler(store);
    const result = await secondHandler({ workspaceIds: ["ws-1"] });

    expect(result.claimed).toEqual([]);
  });

  test("serializes concurrent claims so no workspace opens twice", async () => {
    const store = createMemoryAutoOpenStore();
    const handler = createAutoOpenClaimHandler(store);

    const [first, second] = await Promise.all([
      handler({ workspaceIds: ["ws-1"] }),
      handler({ workspaceIds: ["ws-1"] }),
    ]);

    const totalClaims = first.claimed.length + second.claimed.length;
    expect(totalClaims).toBe(1);
  });
});

describe("createFileAutoOpenStore", () => {
  test("loads an empty set when the file does not exist", async () => {
    const store = createFileAutoOpenStore("/nonexistent/agent-crew/auto-open.json");
    expect(await store.load()).toEqual(new Set());
  });

  test("persists and reloads claimed workspaces", async () => {
    const directory = await mkdtemp("/tmp/agent-crew-");
    const filePath = `${directory}/auto-open.json`;
    const store = createFileAutoOpenStore(filePath);

    await store.persist(new Set(["ws-1", "ws-2"]));
    expect(await store.load()).toEqual(new Set(["ws-1", "ws-2"]));

    await store.persist(new Set(["ws-1"]));
    expect(await store.load()).toEqual(new Set(["ws-1"]));

    await rm(directory, { recursive: true });
  });

  test("rejects corrupted JSON instead of reopening every workspace", async () => {
    const directory = await mkdtemp("/tmp/agent-crew-");
    const filePath = `${directory}/auto-open.json`;
    await writeFile(filePath, "not json", "utf8");

    const store = createFileAutoOpenStore(filePath);
    await expect(store.load()).rejects.toThrow();

    await rm(directory, { recursive: true });
  });

  test("rejects non-array state instead of treating it as empty", async () => {
    const directory = await mkdtemp("/tmp/agent-crew-");
    const filePath = `${directory}/auto-open.json`;
    await writeFile(filePath, "{}", "utf8");

    const store = createFileAutoOpenStore(filePath);
    await expect(store.load()).rejects.toThrow();

    await rm(directory, { recursive: true });
  });

  test("rejects arrays with empty or mixed invalid entries", async () => {
    const directory = await mkdtemp("/tmp/agent-crew-");
    const filePath = `${directory}/auto-open.json`;
    await writeFile(filePath, JSON.stringify(["ws-1", "", null]), "utf8");

    const store = createFileAutoOpenStore(filePath);
    await expect(store.load()).rejects.toThrow();

    await rm(directory, { recursive: true });
  });
});

describe("createAutoOpenManager", () => {
  test("stays idle while the setting is disabled", async () => {
    vi.useFakeTimers();
    const harness = createMockClient();
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);

    expect(harness.client.paseo.workspaces.subscribe).not.toHaveBeenCalled();
    expect(harness.client.rpc).toHaveBeenCalledWith(agentCrewSettingsRpc.read, {});
    expect(harness.client.openPanel).not.toHaveBeenCalled();

    manager.dispose();
  });

  test("starts enabled without seeding existing workspaces", async () => {
    vi.useFakeTimers();
    const harness = createMockClient({
      initialEnabled: true,
      workspaceIds: ["existing-workspace"],
    });
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);

    expect(harness.subscribeCalls).toBe(1);
    expect(harness.listCalls).toBe(0);
    expect(harness.client.openPanel).not.toHaveBeenCalled();

    harness.emitWorkspace("future-workspace");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.claimCalls).toEqual([["future-workspace"]]);
    expect(harness.client.openPanel).toHaveBeenCalledTimes(1);

    manager.dispose();
  });

  test("restarts exactly one subscription across disable and re-enable", async () => {
    vi.useFakeTimers();
    const harness = createMockClient();
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);

    manager.setEnabled(true);
    expect(harness.subscribeCalls).toBe(1);

    manager.setEnabled(false);
    expect(harness.unsubscribeCalls).toBe(1);

    manager.setEnabled(true);
    expect(harness.subscribeCalls).toBe(2);

    manager.dispose();
  });

  test("finishes an already-started chunk after disable and stops before the next chunk", async () => {
    vi.useFakeTimers();
    const claimDeferred = deferred<ClaimResult>();
    const workspaceIds = ids(MAX_AUTO_OPEN_CLAIM_BATCH + 1);
    const harness = createMockClient({ initialEnabled: true, claimDeferred });
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);
    for (const workspaceId of workspaceIds) harness.emitWorkspace(workspaceId);
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.claimCalls).toEqual([ids(MAX_AUTO_OPEN_CLAIM_BATCH)]);
    manager.setEnabled(false);
    claimDeferred.resolve({ claimed: ids(MAX_AUTO_OPEN_CLAIM_BATCH) });
    await claimDeferred.promise;
    await Promise.resolve();

    expect(harness.claimCalls).toHaveLength(1);
    expect(harness.client.openPanel).toHaveBeenCalledTimes(MAX_AUTO_OPEN_CLAIM_BATCH);

    manager.dispose();
  });

  test("does not start a second claim while one is in flight", async () => {
    vi.useFakeTimers();
    const claimDeferred = deferred<ClaimResult>();
    const harness = createMockClient({ claimDeferred });
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);
    manager.setEnabled(true);
    harness.emitWorkspace("workspace-1");
    await vi.advanceTimersByTimeAsync(400);

    harness.emitWorkspace("workspace-2");
    await vi.advanceTimersByTimeAsync(400);
    expect(harness.claimCalls).toEqual([["workspace-1"]]);

    manager.setEnabled(false);
    claimDeferred.resolve({ claimed: ["workspace-1"] });
    await claimDeferred.promise;
    await Promise.resolve();

    expect(harness.claimCalls).toHaveLength(1);
    expect(harness.client.openPanel).toHaveBeenCalledTimes(1);

    manager.dispose();
  });

  test("retries chunk 2 and chunk 3 separately when each fails once", async () => {
    vi.useFakeTimers();
    const workspaceIds = ids(2501);
    const harness = createMockClient({
      initialEnabled: true,
      claimResponder(workspaceIds, callIndex) {
        if (callIndex === 2 || callIndex === 4) {
          throw new Error(`chunk ${callIndex} failed`);
        }
        return { claimed: workspaceIds };
      },
    });
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);
    for (const workspaceId of workspaceIds) harness.emitWorkspace(workspaceId);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.claimCalls).toHaveLength(5);
    expect(harness.claimCalls[0]).toHaveLength(MAX_AUTO_OPEN_CLAIM_BATCH);
    expect(harness.claimCalls[1]).toHaveLength(MAX_AUTO_OPEN_CLAIM_BATCH);
    expect(harness.claimCalls[2]).toHaveLength(MAX_AUTO_OPEN_CLAIM_BATCH);
    expect(harness.claimCalls[3]).toHaveLength(501);
    expect(harness.claimCalls[4]).toHaveLength(501);
    expect(harness.client.openPanel).toHaveBeenCalledTimes(2501);

    manager.dispose();
  });

  test("ignores a stale rejected settings read after re-enabling", async () => {
    vi.useFakeTimers();
    const settingsRead = deferred<SettingsReadResult>();
    const harness = createMockClient({ settingsRead: settingsRead.promise });
    const manager = createAutoOpenManager(harness.client);

    await vi.advanceTimersByTimeAsync(0);
    manager.setEnabled(true);
    settingsRead.reject(new Error("stale settings read"));
    await Promise.resolve();

    harness.emitWorkspace("workspace-1");
    await vi.advanceTimersByTimeAsync(400);

    expect(harness.subscribeCalls).toBe(1);
    expect(harness.client.openPanel).toHaveBeenCalledWith("crew", {
      workspaceId: "workspace-1",
      location: "explorer",
    });

    manager.dispose();
  });
});
