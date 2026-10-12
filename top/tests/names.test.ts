import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnership, MAX_PAGES, MAX_SESSIONS } from "../server/names";
import type { Session } from "../shared/usage";

const session = (agentId: string, cores = 1, rss = 10): Session => ({
  agentId,
  title: null,
  workspace: null,
  cores,
  rss,
  command: "x",
  processes: 1,
  heavy: false,
});

const NONE = { cores: 0, rss: 0 };

interface Agent {
  id: string;
  title: string | null;
  workspaceId: string | null;
}

interface Workspace {
  id: string;
  title: string | null;
  name: string;
}

const mine = (...ids: string[]): Agent[] =>
  ids.map((id) => ({ id, title: `Title ${id}`, workspaceId: "w1" }));

const MAIN: Workspace = { id: "w1", title: null, name: "main" };

/** Lets background refreshes that are already in flight run to completion. */
async function settle() {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

interface ListOptions {
  filter?: { includeArchived?: boolean };
  sort?: Array<{ key: string; direction: string }>;
  page?: { cursor?: string; limit: number };
}

/** A daemon whose lists come back a page at a time, and that can be made slow or broken. */
function fakeDaemon(init: { agents?: Agent[][]; workspaces?: Workspace[][] } = {}) {
  const state = {
    agents: init.agents ?? [mine("a1")],
    workspaces: init.workspaces ?? [[MAIN]],
    fail: false,
    forever: false,
    gate: null as Promise<void> | null,
  };
  const page = <T>(pages: T[][], options: ListOptions) => {
    const index = Number(options.page?.cursor ?? 0);
    const more = state.forever || index < pages.length - 1;
    return {
      entries: state.forever ? [] : (pages[index] ?? []),
      pageInfo: { hasMore: more, nextCursor: more ? String(index + 1) : null },
    };
  };
  const agents = vi.fn(async (options: ListOptions) => {
    if (state.gate) await state.gate;
    if (state.fail) throw new Error("daemon busy");
    const result = page(state.agents, options);
    return { ...result, entries: result.entries.map((agent) => ({ agent })) };
  });
  const workspaces = vi.fn(async (options: ListOptions) => {
    if (state.gate) await state.gate;
    return page(state.workspaces, options);
  });
  const paseo = {
    agents: { list: agents },
    workspaces: { list: workspaces },
  } as unknown as PaseoApi;
  return { paseo, state, agents, workspaces };
}

afterEach(() => vi.useRealTimers());

describe("createOwnership: who owns a session", () => {
  it("lists only this daemon's agents, named with the user's own titles and workspaces", async () => {
    const { paseo } = fakeDaemon();
    const result = await createOwnership()(paseo, [session("a1")], NONE);
    expect(result.sessions).toMatchObject([
      { agentId: "a1", title: "Title a1", workspace: "main" },
    ]);
  });

  it("moves sessions of agents that belong to another daemon into other load, keeping the total", async () => {
    const { paseo } = fakeDaemon();
    const sessions = [session("a1", 2, 100), session("foreign", 3, 50)];
    const result = await createOwnership()(paseo, sessions, { cores: 0.5, rss: 7 });
    expect(result.sessions.map((s) => s.agentId)).toEqual(["a1"]);
    expect(result.other).toEqual({ cores: 3.5, rss: 57 });
    const total = result.sessions.reduce((sum, s) => sum + s.cores, 0) + result.other.cores;
    expect(total).toBeCloseTo(5.5);
  });

  it("does not let another daemon's busy agents crowd this host's own out of the list", async () => {
    const { paseo } = fakeDaemon();
    const foreign = Array.from({ length: MAX_SESSIONS + 2 }, (_, n) => session(`f${n}`, 9));
    const result = await createOwnership()(paseo, [...foreign, session("a1", 0.1)], NONE);
    expect(result.sessions.map((s) => s.agentId)).toEqual(["a1"]);
  });

  it("caps the list, keeping the order it was given, and counts the rest as other load", async () => {
    const ids = Array.from({ length: MAX_SESSIONS + 3 }, (_, n) => `a${n}`);
    const { paseo } = fakeDaemon({ agents: [mine(...ids)] });
    const sessions = ids.map((id) => session(id, 1, 10));
    const result = await createOwnership()(paseo, sessions, NONE);
    expect(result.sessions.map((s) => s.agentId)).toEqual(ids.slice(0, MAX_SESSIONS));
    expect(result.other).toEqual({ cores: 3, rss: 30 });
  });

  it("leaves a session unnamed when its agent has no title or its workspace is unknown", async () => {
    const { paseo } = fakeDaemon({ agents: [[{ id: "a1", title: null, workspaceId: "gone" }]] });
    const result = await createOwnership()(paseo, [session("a1")], NONE);
    expect(result.sessions[0]).toMatchObject({ title: null, workspace: null });
  });

  it("names a workspace by its title when it has one, else by its name", async () => {
    const { paseo } = fakeDaemon({
      agents: [[{ id: "a1", title: "T", workspaceId: "w2" }]],
      workspaces: [[MAIN, { id: "w2", title: "Titled", name: "ignored" }]],
    });
    const result = await createOwnership()(paseo, [session("a1")], NONE);
    expect(result.sessions[0]?.workspace).toBe("Titled");
  });
});

describe("createOwnership: reading the daemon's lists", () => {
  it("follows every page, archived agents included, oldest first so paging is stable", async () => {
    const { paseo, agents } = fakeDaemon({ agents: [mine("a1"), mine("a2"), mine("a3")] });
    const result = await createOwnership()(paseo, [session("a3")], NONE);
    expect(result.sessions.map((s) => s.agentId)).toEqual(["a3"]);
    expect(agents).toHaveBeenCalledTimes(3);
    for (const [options] of agents.mock.calls) {
      expect(options).toMatchObject({
        filter: { includeArchived: true },
        sort: [{ key: "created_at", direction: "asc" }],
      });
    }
    expect(agents.mock.calls.map(([options]) => options.page?.cursor)).toEqual([
      undefined,
      "1",
      "2",
    ]);
  });

  it("follows the workspace pages too, so an agent in a later page's workspace is named", async () => {
    const { paseo, workspaces } = fakeDaemon({
      agents: [[{ id: "a1", title: "T", workspaceId: "w9" }]],
      workspaces: [[MAIN], [{ id: "w9", title: null, name: "second page" }]],
    });
    const result = await createOwnership()(paseo, [session("a1")], NONE);
    expect(result.sessions[0]?.workspace).toBe("second page");
    expect(workspaces.mock.calls.map(([options]) => options.page?.cursor)).toEqual([
      undefined,
      "1",
    ]);
  });

  it("stops after a bounded number of pages, and when a page promises more but gives no cursor", async () => {
    const endless = fakeDaemon();
    endless.state.forever = true;
    await createOwnership()(endless.paseo, [session("a1")], NONE);
    expect(endless.agents).toHaveBeenCalledTimes(MAX_PAGES);

    const stuck = fakeDaemon();
    stuck.agents.mockResolvedValue({
      entries: [{ agent: mine("a1")[0] }],
      pageInfo: { hasMore: true, nextCursor: null },
    } as never);
    await createOwnership()(stuck.paseo, [session("a1")], NONE);
    expect(stuck.agents).toHaveBeenCalledTimes(1);
  });

  it("does not read the lists at all when there is nothing to resolve", async () => {
    const { paseo, agents } = fakeDaemon();
    await createOwnership()(paseo, [], NONE);
    expect(agents).not.toHaveBeenCalled();
  });
});

describe("createOwnership: how often it reads", () => {
  it("reads once for steady sessions, including another daemon's, then again after thirty seconds", async () => {
    let clock = 0;
    const { paseo, agents } = fakeDaemon();
    const own = createOwnership(() => clock);
    const sessions = [session("a1"), session("foreign")];
    for (const at of [0, 5000, 10_000, 29_999]) {
      clock = at;
      await own(paseo, sessions, NONE);
    }
    await settle();
    expect(agents).toHaveBeenCalledTimes(1);
    clock = 30_000;
    await own(paseo, sessions, NONE);
    await settle();
    expect(agents).toHaveBeenCalledTimes(2);
  });

  it("looks again within seconds when a session of an unknown agent appears, but not constantly", async () => {
    let clock = 0;
    const { paseo, state, agents } = fakeDaemon();
    const own = createOwnership(() => clock);
    await own(paseo, [session("a1")], NONE);
    expect(agents).toHaveBeenCalledTimes(1);

    state.agents = [mine("a1", "a2")]; // a2 is created after the first read
    clock = 1000;
    await own(paseo, [session("a1"), session("a2")], NONE);
    await settle();
    expect(agents).toHaveBeenCalledTimes(1); // too soon to read again

    clock = 5000;
    const stale = await own(paseo, [session("a1"), session("a2")], NONE);
    await settle();
    expect(agents).toHaveBeenCalledTimes(2);
    expect(stale.sessions.map((s) => s.agentId)).toEqual(["a1"]); // answered from the old read

    clock = 5001;
    const fresh = await own(paseo, [session("a1"), session("a2")], NONE);
    expect(fresh.sessions.map((s) => s.agentId)).toEqual(["a1", "a2"]);
  });

  it("retries after a failed first read within seconds, not after thirty", async () => {
    let clock = 0;
    const { paseo, state, agents } = fakeDaemon();
    state.fail = true;
    const own = createOwnership(() => clock);
    const first = await own(paseo, [session("a1", 2, 5)], NONE);
    expect(first).toEqual({ sessions: [], other: { cores: 2, rss: 5 } });
    state.fail = false;
    clock = 5000;
    await own(paseo, [session("a1")], NONE);
    await settle();
    expect(agents).toHaveBeenCalledTimes(2);
    clock = 5001;
    expect((await own(paseo, [session("a1")], NONE)).sessions).toHaveLength(1);
  });

  it("keeps the last known agents when a refresh fails", async () => {
    let clock = 0;
    const { paseo, state } = fakeDaemon();
    const own = createOwnership(() => clock);
    await own(paseo, [session("a1")], NONE);
    state.fail = true;
    clock = 30_000;
    await own(paseo, [session("a1")], NONE);
    await settle();
    const result = await own(paseo, [session("a1")], NONE);
    expect(result.sessions).toMatchObject([{ agentId: "a1", title: "Title a1" }]);
  });
});

describe("createOwnership: a slow or hung daemon", () => {
  it("shares one read between callers that arrive while it is in flight", async () => {
    const { paseo, state, agents } = fakeDaemon();
    let release: () => void = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const own = createOwnership();
    const calls = [own(paseo, [session("a1")], NONE), own(paseo, [session("a1")], NONE)];
    await settle();
    release();
    const [first, second] = await Promise.all(calls);
    expect(first?.sessions).toHaveLength(1);
    expect(second?.sessions).toHaveLength(1);
    expect(agents).toHaveBeenCalledTimes(1);
  });

  it("does not wait forever for the first read: all load is other until the daemon answers", async () => {
    vi.useFakeTimers();
    const { paseo, state } = fakeDaemon();
    let release: () => void = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const own = createOwnership(Date.now, 3000);
    const pending = own(paseo, [session("a1", 2, 5)], NONE);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ sessions: [], other: { cores: 2, rss: 5 } });

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await own(paseo, [session("a1")], NONE)).sessions).toHaveLength(1);
  });

  it("does not start another read while one is still within its lifetime", async () => {
    let clock = 0;
    const { paseo, state, agents } = fakeDaemon();
    const own = createOwnership(() => clock);
    await own(paseo, [session("a1")], NONE);
    state.gate = new Promise<void>(() => {}); // the next read never returns
    for (const at of [30_000, 40_000, 59_999]) {
      clock = at;
      await own(paseo, [session("a1")], NONE);
    }
    await settle();
    expect(agents).toHaveBeenCalledTimes(2); // the first read, plus the one that is hanging
  });

  describe("a read that never answers, and ignores cancellation", () => {
    const reply = (id: string, title: string) => ({
      entries: [{ agent: { id, title, workspaceId: null } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    /** Every agents read stays pending until the test settles it; the abort signal is only recorded. */
    function deferredDaemon() {
      const reads: Array<{ signal: AbortSignal | undefined; resolve: (page: unknown) => void }> =
        [];
      const paseo = {
        agents: {
          list: vi.fn((options: { signal?: AbortSignal }) => {
            const { promise, resolve } = Promise.withResolvers<unknown>();
            reads.push({ signal: options.signal, resolve });
            return promise;
          }),
        },
        workspaces: {
          list: vi.fn(async () => ({
            entries: [],
            pageInfo: { hasMore: false, nextCursor: null },
          })),
        },
      } as unknown as PaseoApi;
      return { paseo, reads };
    }

    it("is cancelled after its lifetime, and the next caller reads again instead of waiting on it", async () => {
      let clock = 0;
      const { paseo, reads } = deferredDaemon();
      const own = createOwnership(() => clock, 10);
      await own(paseo, [session("a1")], NONE);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.signal?.aborted).toBe(false);

      clock = 40_000;
      const result = await own(paseo, [session("a1", 2, 5)], NONE);
      expect(reads[0]?.signal?.aborted).toBe(true);
      expect(reads).toHaveLength(2);
      expect(result).toEqual({ sessions: [], other: { cores: 2, rss: 5 } });

      reads[1]?.resolve(reply("a1", "Fresh"));
      await settle();
      clock = 40_001;
      expect((await own(paseo, [session("a1")], NONE)).sessions).toMatchObject([
        { title: "Fresh" },
      ]);
    });

    it("cannot publish a stale result, nor release the read that replaced it", async () => {
      let clock = 0;
      const { paseo, reads } = deferredDaemon();
      const own = createOwnership(() => clock, 10);
      await own(paseo, [session("a1")], NONE);
      clock = 40_000;
      await own(paseo, [session("a1")], NONE); // abandons the first read, starts a second

      reads[0]?.resolve(reply("a1", "Stale"));
      await settle();
      // The second read is still in flight, so a caller that wants a new read shares it.
      clock = 46_000;
      const during = await own(paseo, [session("a1"), session("a2")], NONE);
      expect(during.sessions).toEqual([]); // nothing was published by the stale read
      expect(reads).toHaveLength(2);

      reads[1]?.resolve(reply("a1", "Fresh"));
      await settle();
      clock = 46_001;
      expect((await own(paseo, [session("a1")], NONE)).sessions).toMatchObject([
        { title: "Fresh" },
      ]);
    });

    it("cannot overwrite a newer result when it answers last", async () => {
      let clock = 0;
      const { paseo, reads } = deferredDaemon();
      const own = createOwnership(() => clock, 10);
      await own(paseo, [session("a1")], NONE);
      clock = 40_000;
      await own(paseo, [session("a1")], NONE);
      reads[1]?.resolve(reply("a1", "Fresh"));
      await settle();
      reads[0]?.resolve(reply("a1", "Stale"));
      await settle();
      clock = 40_001;
      expect((await own(paseo, [session("a1")], NONE)).sessions).toMatchObject([
        { title: "Fresh" },
      ]);
    });

    it("is cancelled when the plugin stops, and releases a caller still waiting for it", async () => {
      const { paseo, reads } = deferredDaemon();
      const own = createOwnership(Date.now, 60_000);
      const waiting = own(paseo, [session("a1", 2, 5)], NONE);
      await settle();
      own.stop();
      expect(reads[0]?.signal?.aborted).toBe(true);
      expect(await waiting).toEqual({ sessions: [], other: { cores: 2, rss: 5 } });
    });
  });

  it("never holds up a reading once it has the lists, however slow a refresh is", async () => {
    let clock = 0;
    const { paseo, state } = fakeDaemon();
    const own = createOwnership(() => clock);
    await own(paseo, [session("a1")], NONE);
    state.gate = new Promise<void>(() => {}); // the next read never returns
    clock = 30_000;
    const result = await own(paseo, [session("a1")], NONE);
    expect(result.sessions).toMatchObject([{ agentId: "a1", title: "Title a1" }]);
  });
});
