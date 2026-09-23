import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: {
    absoluteFillObject: {},
    create<T>(styles: T): T {
      return styles;
    },
    hairlineWidth: 1,
  },
  Text: "Text",
  View: "View",
}));

import { registerQueensComposerPills } from "../client/composer-pill";

async function flushBootstrap() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Queens composer pills", () => {
  test("adds pills for paginated agents and later owned directory updates", async () => {
    const registrations: Array<{
      input: Parameters<PluginClientContext["addComposerPill"]>[0];
      remove: ReturnType<typeof vi.fn>;
    }> = [];
    let observer:
      | {
          snapshot(snapshot: unknown): void;
          update(message: {
            type: "agent_update";
            payload:
              | { kind: "remove"; agentId: string }
              | {
                  kind: "update";
                  agent: { id: string; workspaceId: string; status: string };
                };
          }): void;
        }
      | undefined;
    const release = vi.fn().mockResolvedValue(undefined);
    const firstPage = {
      entries: [{ agent: { id: "active", workspaceId: "workspace-a", status: "idle" } }],
      pageInfo: { hasMore: true, nextCursor: "page-2" },
    };
    const client = {
      addComposerPill(input: Parameters<PluginClientContext["addComposerPill"]>[0]) {
        const remove = vi.fn();
        registrations.push({ input, remove });
        return { update: vi.fn(), remove };
      },
      paseo: {
        agents: {
          async list(options?: { page?: { cursor?: string }; subscribe?: object }) {
            if (options?.subscribe) {
              return {
                ...firstPage,
                subscription: {
                  subscribe(nextObserver: typeof observer) {
                    observer = nextObserver;
                    nextObserver?.snapshot(firstPage);
                    return () => {
                      observer = undefined;
                    };
                  },
                  release,
                },
              };
            }
            return {
              entries: [
                { agent: { id: "paginated", workspaceId: "workspace-b", status: "idle" } },
                { agent: { id: "closed", workspaceId: "workspace-a", status: "closed" } },
              ],
              pageInfo: { hasMore: false, nextCursor: null },
            };
          },
        },
      },
    } as unknown as PluginClientContext;

    const cleanup = registerQueensComposerPills(client);
    await vi.waitFor(() =>
      expect(registrations.map(({ input }) => input.agentId)).toEqual(["active", "paginated"]),
    );

    observer?.update({
      type: "agent_update",
      payload: {
        kind: "update",
        agent: { id: "new-agent", workspaceId: "workspace-c", status: "running" },
      },
    });

    await vi.waitFor(() =>
      expect(registrations.map(({ input }) => input.agentId)).toEqual([
        "active",
        "paginated",
        "new-agent",
      ]),
    );

    cleanup();
    await flushBootstrap();
    expect(release).toHaveBeenCalledOnce();
  });

  test("removes stale pills after reconnect while retaining updates during pagination", async () => {
    const registrations: Array<{
      input: Parameters<PluginClientContext["addComposerPill"]>[0];
      remove: ReturnType<typeof vi.fn>;
    }> = [];
    let observer:
      | {
          snapshot(snapshot: unknown): void;
          update(message: {
            type: "agent_update";
            payload: {
              kind: "update";
              agent: { id: string; workspaceId: string; status: string };
            };
          }): void;
        }
      | undefined;
    let resolvePage!: (page: {
      entries: Array<{ agent: { id: string; workspaceId: string; status: string } }>;
      pageInfo: { hasMore: boolean; nextCursor: null };
    }) => void;
    const nextPage = new Promise<{
      entries: Array<{ agent: { id: string; workspaceId: string; status: string } }>;
      pageInfo: { hasMore: boolean; nextCursor: null };
    }>((resolve) => {
      resolvePage = resolve;
    });
    const initialSnapshot = {
      entries: [
        { agent: { id: "active", workspaceId: "workspace-a", status: "idle" } },
        { agent: { id: "stale", workspaceId: "workspace-b", status: "idle" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const client = {
      addComposerPill(input: Parameters<PluginClientContext["addComposerPill"]>[0]) {
        const remove = vi.fn();
        registrations.push({ input, remove });
        return { update: vi.fn(), remove };
      },
      paseo: {
        agents: {
          async list(options?: { subscribe?: object }) {
            if (!options?.subscribe) return nextPage;
            return {
              ...initialSnapshot,
              subscription: {
                subscribe(nextObserver: typeof observer) {
                  observer = nextObserver;
                  nextObserver?.snapshot(initialSnapshot);
                  return () => {
                    observer = undefined;
                  };
                },
                release: vi.fn().mockResolvedValue(undefined),
              },
            };
          },
        },
      },
    } as unknown as PluginClientContext;

    const cleanup = registerQueensComposerPills(client);
    await vi.waitFor(() => expect(registrations).toHaveLength(2));

    observer?.snapshot({
      entries: [{ agent: { id: "active", workspaceId: "workspace-a", status: "idle" } }],
      pageInfo: { hasMore: true, nextCursor: "page-2" },
    });
    await flushBootstrap();
    observer?.update({
      type: "agent_update",
      payload: {
        kind: "update",
        agent: { id: "paged", workspaceId: "workspace-c", status: "running" },
      },
    });
    resolvePage({
      entries: [{ agent: { id: "paged", workspaceId: "workspace-d", status: "idle" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    await vi.waitFor(() => {
      expect(
        registrations.find(({ input }) => input.agentId === "stale")?.remove,
      ).toHaveBeenCalledOnce();
      expect(
        registrations
          .filter(({ input }) => input.agentId === "paged")
          .map(({ input }) => input.workspaceId),
      ).toEqual(["workspace-c"]);
    });

    cleanup();
  });

  test("aborts a pending owned observation during cleanup", async () => {
    let signal: AbortSignal | undefined;
    const pending = Promise.withResolvers<never>();
    const client = {
      paseo: {
        agents: {
          list(options: { signal?: AbortSignal }) {
            signal = options.signal;
            return pending.promise;
          },
        },
      },
    } as unknown as PluginClientContext;

    const cleanup = registerQueensComposerPills(client);
    await vi.waitFor(() => expect(signal).toBeDefined());
    cleanup();

    expect(signal?.aborted).toBe(true);
  });
});
