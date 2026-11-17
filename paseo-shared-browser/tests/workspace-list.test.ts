import { describe, expect, it, vi } from "vitest";
import { listAllWorkspaces, WORKSPACE_PAGE_LIMIT } from "../server/workspace-list";

const entry = (id: string) => ({ id, projectId: "p", workspaceDirectory: `/w/${id}` });

function pages(count: number, lastHasMore = false) {
  return vi.fn(
    async ({
      page,
    }: {
      filter: { includeBackground: true };
      page: { limit: number; cursor?: string };
    }) => {
      const index = page.cursor ? Number(page.cursor) : 0;
      const more = index + 1 < count || (index + 1 === count && lastHasMore);
      return {
        entries: [entry(`w${index}`)],
        pageInfo: { nextCursor: more ? String(index + 1) : null, hasMore: more },
      };
    },
  );
}

describe("listAllWorkspaces", () => {
  it("asks for background workspaces and follows the cursor until hasMore is false", async () => {
    const list = pages(3);
    const result = await listAllWorkspaces({ workspaces: { list } });
    expect(result.map((w) => w.id)).toEqual(["w0", "w1", "w2"]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map(([options]) => options.page.cursor)).toEqual([undefined, "1", "2"]);
    for (const [options] of list.mock.calls) {
      expect(options.filter).toEqual({ includeBackground: true });
    }
  });

  it("accepts a list that ends exactly on the last allowed page", async () => {
    const list = pages(WORKSPACE_PAGE_LIMIT);
    await expect(listAllWorkspaces({ workspaces: { list } })).resolves.toHaveLength(
      WORKSPACE_PAGE_LIMIT,
    );
  });

  it("throws when hasMore is still set after the page limit", async () => {
    const list = pages(WORKSPACE_PAGE_LIMIT, true);
    await expect(listAllWorkspaces({ workspaces: { list } })).rejects.toThrow(/longer than/);
    expect(list).toHaveBeenCalledTimes(WORKSPACE_PAGE_LIMIT);
  });

  it("throws when a page says more but gives no cursor", async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ entries: [], pageInfo: { nextCursor: null, hasMore: true } });
    await expect(listAllWorkspaces({ workspaces: { list } })).rejects.toThrow(/no cursor/);
  });
});
