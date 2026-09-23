import type { PaseoApi } from "@getpaseo/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AgentDirectoryFollower,
  followAgentDirectory,
  MAX_AGENT_PAGES,
} from "../client/agents";

type Agent = { id: string; workspaceId: string };
type ListRequest = {
  subscribe?: object;
  signal?: AbortSignal;
  sort?: unknown;
  page?: { limit: number; cursor?: string };
};
type Observer = {
  snapshot(list: unknown): void;
  update(message: { type: string; payload: unknown }): void;
  error?(error: unknown): void;
};

function agent(id: string): Agent {
  return { id, workspaceId: `ws-${id}` };
}

function page(agents: Agent[], next?: string) {
  return {
    requestId: "req",
    subscriptionId: "sub",
    entries: agents.map((item) => ({ agent: item, project: {} })),
    pageInfo: { hasMore: next !== undefined, nextCursor: next ?? null },
  };
}

/**
 * A host whose directory is `pages()`, one array per page. `observing` makes it
 * a 0.9 client (observation from `list({ subscribe })`); otherwise a 0.8 one.
 * `gate` holds plain page reads until released, to land updates mid-paging.
 */
function fakeHost(options: { observing: boolean; pages: () => Agent[][] }) {
  const requests: ListRequest[] = [];
  const observers: Observer[] = [];
  let listener: ((update: unknown) => void) | null = null;
  let released = 0;
  let gate: Promise<void> | null = null;
  const pageAt = (cursor?: string) => {
    const pages = options.pages();
    const index = cursor ? Number(cursor) : 0;
    return page(pages[index] ?? [], index + 1 < pages.length ? String(index + 1) : undefined);
  };
  const agents = {
    subscribe(handler: (update: unknown) => void) {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    async list(request: ListRequest = {}) {
      requests.push(request);
      if (!request.subscribe) {
        if (gate) await gate;
        return pageAt(request.page?.cursor);
      }
      return {
        ...pageAt(),
        subscription: {
          subscribe(next: Observer) {
            observers.push(next);
            next.snapshot(pageAt());
            return () => undefined;
          },
          async release() {
            released += 1;
          },
        },
      };
    },
  };
  const observer = () => observers.at(-1);
  return {
    paseo: (options.observing ? { observeEvents() {}, agents } : { agents }) as unknown as PaseoApi,
    requests,
    get released() {
      return released;
    },
    get listening() {
      return listener !== null;
    },
    hold() {
      let open = () => {};
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    update(payload: unknown) {
      observer()?.update({ type: "agent_update", payload });
      listener?.(payload);
    },
    reconnect() {
      observer()?.snapshot(pageAt());
    },
    fail(error: unknown) {
      observer()?.error?.(error);
    },
  };
}

function recorder() {
  const snapshots: { ids: string[]; complete: boolean }[] = [];
  const upserts: string[] = [];
  const removes: string[] = [];
  const follower: AgentDirectoryFollower = {
    snapshot(agents, complete) {
      snapshots.push({ ids: agents.map((item) => item.id).sort(), complete });
    },
    upsert(item) {
      upserts.push(item.id);
    },
    remove(agentId) {
      removes.push(agentId);
    },
  };
  return { follower, snapshots, upserts, removes };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("followAgentDirectory on a 0.9 client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens one observation and applies its snapshot and updates", async () => {
    const host = fakeHost({ observing: true, pages: () => [[agent("a1"), agent("a2")]] });
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await flush();

    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({
      subscribe: {},
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });
    expect(host.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(host.listening).toBe(false);
    expect(seen.snapshots).toEqual([{ ids: ["a1", "a2"], complete: true }]);

    host.update({ kind: "upsert", agent: agent("a3") });
    host.update({ kind: "remove", agentId: "a1" });
    expect(seen.upserts).toEqual(["a3"]);
    expect(seen.removes).toEqual(["a1"]);

    stop();
    await flush();
    expect(host.requests[0]?.signal?.aborted).toBe(true);
    expect(host.released).toBe(1);
    host.update({ kind: "upsert", agent: agent("a4") });
    expect(seen.upserts).toEqual(["a3"]);
  });

  test("reads later pages plainly and lets updates that land meanwhile win", async () => {
    const host = fakeHost({
      observing: true,
      pages: () => [[agent("a1")], [agent("a2"), agent("a3")]],
    });
    const release = host.hold();
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await flush();
    expect(seen.snapshots).toEqual([]);

    // The second page was computed before these; it must not resurrect a3 or drop a9.
    host.update({ kind: "remove", agentId: "a3" });
    host.update({ kind: "upsert", agent: agent("a9") });
    release();
    await flush();

    expect(host.requests[1]).toMatchObject({ page: { limit: 200, cursor: "1" } });
    expect(host.requests[1]?.subscribe).toBeUndefined();
    expect(seen.snapshots).toEqual([{ ids: ["a1", "a2", "a9"], complete: true }]);
    stop();
  });

  test("stops at the page cap and marks the snapshot incomplete", async () => {
    const pages = Array.from({ length: MAX_AGENT_PAGES + 2 }, (_, index) => [agent(`a${index}`)]);
    const host = fakeHost({ observing: true, pages: () => pages });
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await flush();

    expect(host.requests).toHaveLength(MAX_AGENT_PAGES);
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.snapshots[0]?.complete).toBe(false);
    expect(seen.snapshots[0]?.ids).toHaveLength(MAX_AGENT_PAGES);
    stop();
  });

  test("a reconnect snapshot supersedes paging still in flight", async () => {
    let pages = [[agent("a1")], [agent("a2")]];
    const host = fakeHost({ observing: true, pages: () => pages });
    const release = host.hold();
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await flush();

    pages = [[agent("b1")]];
    host.reconnect();
    await flush();
    release();
    await flush();

    expect(seen.snapshots).toEqual([{ ids: ["b1"], complete: true }]);
    stop();
  });

  test("reopens a failed observation with backoff and leaves no timer behind", async () => {
    let pages = [[agent("a1")]];
    const host = fakeHost({ observing: true, pages: () => pages });
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await flush();

    pages = [[agent("a2")]];
    host.fail(new Error("reconnect request failed"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(host.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.requests).toHaveLength(2);
    expect(seen.snapshots.at(-1)).toEqual({ ids: ["a2"], complete: true });

    host.fail(new Error("again"));
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("followAgentDirectory on a 0.8 client", () => {
  test("keeps the listener and one upsert-only read, and never subscribes", async () => {
    const host = fakeHost({ observing: false, pages: () => [[agent("a1")]] });
    const seen = recorder();
    const stop = followAgentDirectory(host.paseo, seen.follower);
    await vi.waitFor(() => expect(seen.snapshots).toHaveLength(1));

    expect(host.requests.every((request) => request.subscribe === undefined)).toBe(true);
    expect(host.listening).toBe(true);
    expect(seen.snapshots).toEqual([{ ids: ["a1"], complete: false }]);

    host.update({ kind: "upsert", agent: agent("a2") });
    expect(seen.upserts).toEqual(["a2"]);

    stop();
    expect(host.listening).toBe(false);
  });
});
