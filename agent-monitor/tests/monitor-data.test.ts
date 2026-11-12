import { beforeEach, describe, expect, test, vi } from "vitest";
import { type PaseoApi, projectIndexKey } from "../client/monitor";
import { loadAgents, loadWorkspaces, useAllHostsMonitor } from "../client/monitor-data";

const hooks = vi.hoisted(() => ({
  hosts: [] as Array<{ serverId: string; label: string; status: string }>,
  clients: {} as Record<string, unknown>,
  effects: [] as Array<() => undefined | (() => void)>,
  query: undefined as undefined | { queryFn: () => Promise<unknown> },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useHosts: () => hooks.hosts,
  getPaseoClient: (serverId: string) => hooks.clients[serverId],
}));
vi.mock("@tanstack/react-query", () => ({
  focusManager: { isFocused: () => true },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryFn: () => Promise<unknown> }) => {
    hooks.query = options;
    return options;
  },
}));
vi.mock("react", () => ({
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => undefined | (() => void)) => {
    hooks.effects.push(effect);
  },
}));

function pagedList<T>(...pages: T[][]) {
  let next = 0;
  return vi.fn(async (_options: Record<string, unknown>) => {
    const index = next++;
    const last = index === pages.length - 1;
    return {
      entries: pages[index] ?? [],
      pageInfo: { hasMore: !last, nextCursor: last ? null : `cursor-${index}` },
    };
  });
}

beforeEach(() => {
  hooks.hosts = [];
  hooks.clients = {};
  hooks.effects.length = 0;
  hooks.query = undefined;
});

describe("directory loaders", () => {
  test("agent pages include background workspaces and follow the cursor", async () => {
    const list = pagedList([{ agent: { id: "a" } }], [{ agent: { id: "b" } }]);
    const paseo = { agents: { list } } as unknown as PaseoApi;

    const result = await loadAgents(paseo);

    expect(result).toEqual({
      entries: [{ agent: { id: "a" } }, { agent: { id: "b" } }],
      truncated: false,
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls.map(([options]) => options.includeBackground)).toEqual([true, true]);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ page: { cursor: "cursor-0" } });
  });

  test("agent pages use a key an update cannot reorder, newest first", async () => {
    const list = pagedList([{ agent: { id: "a" } }]);
    const paseo = { agents: { list } } as unknown as PaseoApi;

    await loadAgents(paseo);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ key: "created_at", direction: "desc" }] }),
    );
  });

  test("workspace pages include background workspaces", async () => {
    const list = pagedList([{ id: "w" }]);
    const paseo = { workspaces: { list } } as unknown as PaseoApi;

    await loadWorkspaces(paseo);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ includeBackground: true }));
  });

  test("drops background helpers but keeps agents in background workspaces", async () => {
    const list = pagedList(
      [{ agent: { id: "lead", background: false } }, { agent: { id: "title", background: true } }],
      [
        { agent: { id: "in-background-workspace" } },
        { agent: { id: "summary", background: true } },
      ],
    );
    const paseo = { agents: { list } } as unknown as PaseoApi;

    const result = await loadAgents(paseo);

    expect(result.entries.map((entry) => entry.agent.id)).toEqual([
      "lead",
      "in-background-workspace",
    ]);
  });

  test("reports a truncated roster when the page cap is hit", async () => {
    const list = vi.fn(async () => ({
      entries: [{ agent: { id: "a" } }],
      pageInfo: { hasMore: true, nextCursor: "next" },
    }));
    const paseo = { agents: { list } } as unknown as PaseoApi;

    const result = await loadAgents(paseo);

    expect(result.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(10);
  });
});

describe("useAllHostsMonitor", () => {
  function connect(entryId: string) {
    const release = vi.fn(async () => {});
    const subscription = { subscribe: vi.fn(() => () => {}), release };
    const agents = {
      list: vi.fn(async (options: Record<string, unknown>) =>
        options.subscribe
          ? { subscription }
          : {
              entries: [
                { id: entryId, agent: { id: entryId } },
                { id: `${entryId}-helper`, agent: { id: `${entryId}-helper`, background: true } },
              ],
              pageInfo: { hasMore: false, nextCursor: null },
            },
      ),
    };
    const workspaces = {
      list: vi.fn(async (options: Record<string, unknown>) =>
        options.subscribe
          ? { subscription }
          : {
              entries: [
                {
                  id: "w1",
                  name: "main",
                  projectId: "p1",
                  projectDisplayName: "Proj",
                  pinnedAt: "now",
                  diffStat: { additions: 3, deletions: 1 },
                },
              ],
              pageInfo: { hasMore: false, nextCursor: null },
            },
      ),
    };
    const projects = {
      list: vi.fn(async () => ({
        projects: [
          {
            projectId: "p1",
            projectKey: "k1",
            projectCustomName: " Renamed ",
            projectDisplayName: "Proj",
          },
        ],
      })),
      subscribe: vi.fn(() => () => {}),
    };
    return { agents, workspaces, projects };
  }

  test("merges every online host and observes each one", async () => {
    const hostA = connect("alpha-entry");
    const hostB = connect("beta-entry");
    hooks.clients = { "srv-a": hostA, "srv-b": hostB };
    hooks.hosts = [
      { serverId: "srv-a", label: "alpha", status: "online" },
      { serverId: "srv-off", label: "offline", status: "offline" },
      { serverId: "srv-b", label: "beta", status: "online" },
    ];

    const alpha = { serverId: "srv-a", label: "alpha" };
    const beta = { serverId: "srv-b", label: "beta" };
    const monitor = useAllHostsMonitor();
    const data = (await hooks.query?.queryFn()) as {
      entries: Array<{ id: string; hostScope?: { label: string } }>;
      directory: { workspaces: Map<string, unknown>; projects: Map<string, { name: string }> };
      truncated: boolean;
    };

    expect(monitor.hosts.map((host) => host.label)).toEqual(["alpha", "beta"]);
    expect(data.entries.map((entry) => entry.id).sort()).toEqual(["alpha-entry", "beta-entry"]);
    expect(data.entries.map((entry) => entry.hostScope?.label).sort()).toEqual(["alpha", "beta"]);
    expect(data.truncated).toBe(false);
    expect(data.directory.workspaces.get("w1")).toMatchObject({
      name: "main",
      pinned: true,
      additions: 3,
      deletions: 1,
    });
    // The same project key on two hosts stays two records, one per host.
    expect(data.directory.projects.get(projectIndexKey(alpha, "k1"))?.name).toBe("Renamed");
    expect(data.directory.projects.get(projectIndexKey(beta, "k1"))?.name).toBe("Renamed");
    expect(data.directory.projects.has("k1")).toBe(false);

    const cleanups = hooks.effects.map((effect) => effect()).filter(Boolean);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const client of [hostA, hostB]) {
      expect(client.agents.list).toHaveBeenCalledWith({ subscribe: {}, includeBackground: true });
      expect(client.workspaces.list).toHaveBeenCalledWith({
        subscribe: {},
        includeBackground: true,
      });
    }
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  });

  test("names a host that fails to load and keeps the others", async () => {
    hooks.clients = { "srv-a": connect("alpha-entry") };
    hooks.hosts = [
      { serverId: "srv-a", label: "alpha", status: "online" },
      { serverId: "srv-b", label: "beta", status: "online" },
    ];

    useAllHostsMonitor();
    const data = (await hooks.query?.queryFn()) as {
      entries: Array<{ id: string }>;
      failedHosts: string[];
    };

    expect(data.failedHosts).toEqual(["beta"]);
    expect(data.entries.map((entry) => entry.id)).toEqual(["alpha-entry"]);
  });
});
