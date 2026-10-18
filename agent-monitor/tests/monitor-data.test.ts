import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "../client/monitor";
import { loadAgents, loadWorkspaces, useMonitorQuery } from "../client/monitor-data";

const hooks = vi.hoisted(() => ({
  paseo: undefined as unknown,
  effects: [] as Array<() => undefined | (() => void)>,
  query: undefined as undefined | { queryFn: () => Promise<unknown> },
}));

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => hooks.paseo }));
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
  hooks.effects.length = 0;
  hooks.query = undefined;
});

describe("directory loaders", () => {
  test("agent pages include background workspaces and follow the cursor", async () => {
    const list = pagedList([{ id: "a" }], [{ id: "b" }]);
    const paseo = { agents: { list } } as unknown as PaseoApi;

    const result = await loadAgents(paseo);

    expect(result).toEqual({ entries: [{ id: "a" }, { id: "b" }], truncated: false });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls.map(([options]) => options.includeBackground)).toEqual([true, true]);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ page: { cursor: "cursor-0" } });
  });

  test("agent pages use a key an update cannot reorder, newest first", async () => {
    const list = pagedList([{ id: "a" }]);
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

  test("reports a truncated roster when the page cap is hit", async () => {
    const list = vi.fn(async () => ({
      entries: [{ id: "a" }],
      pageInfo: { hasMore: true, nextCursor: "next" },
    }));
    const paseo = { agents: { list } } as unknown as PaseoApi;

    const result = await loadAgents(paseo);

    expect(result.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(10);
  });
});

describe("useMonitorQuery", () => {
  function connect() {
    const release = vi.fn(async () => {});
    const subscription = { subscribe: vi.fn(() => () => {}), release };
    const agents = {
      list: vi.fn(async (options: Record<string, unknown>) =>
        options.subscribe
          ? { subscription }
          : { entries: [{ id: "a" }], pageInfo: { hasMore: false, nextCursor: null } },
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
    hooks.paseo = { agents, workspaces, projects };
    return { agents, workspaces };
  }

  test("loads the directory with background workspaces and observes them", async () => {
    const { agents, workspaces } = connect();

    useMonitorQuery("host");
    const data = (await hooks.query?.queryFn()) as {
      entries: unknown[];
      directory: { workspaces: Map<string, unknown>; projects: Map<string, { name: string }> };
      truncated: boolean;
    };

    expect(data.entries).toEqual([{ id: "a" }]);
    expect(data.truncated).toBe(false);
    expect(data.directory.workspaces.get("w1")).toMatchObject({
      name: "main",
      pinned: true,
      additions: 3,
      deletions: 1,
    });
    expect(data.directory.projects.get("p1")?.name).toBe("Renamed");

    const cleanup = hooks.effects[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(agents.list).toHaveBeenCalledWith({ subscribe: {}, includeBackground: true });
    expect(workspaces.list).toHaveBeenCalledWith({ subscribe: {}, includeBackground: true });
    if (typeof cleanup === "function") cleanup();
  });
});
