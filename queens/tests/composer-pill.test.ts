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
  test("tracks live agents without replacing unchanged registrations", async () => {
    const registrations: Array<{
      input: Parameters<PluginClientContext["addComposerPill"]>[0];
      remove: ReturnType<typeof vi.fn>;
    }> = [];
    let subscriber: ((update: unknown) => void) | null = null;
    const unsubscribe = vi.fn();
    const client = {
      addComposerPill(input: Parameters<PluginClientContext["addComposerPill"]>[0]) {
        const remove = vi.fn();
        registrations.push({ input, remove });
        return { update: vi.fn(), remove };
      },
      paseo: {
        agents: {
          subscribe(callback: (update: unknown) => void) {
            subscriber = callback;
            return unsubscribe;
          },
          async list() {
            return {
              entries: [
                { agent: { id: "active", workspaceId: "workspace-a", status: "idle" } },
                { agent: { id: "closed", workspaceId: "workspace-a", status: "closed" } },
              ],
              pageInfo: { hasMore: false, nextCursor: null },
            };
          },
        },
      },
    } as unknown as PluginClientContext;

    const cleanup = registerQueensComposerPills(client);
    await flushBootstrap();

    expect(registrations).toHaveLength(1);
    expect(registrations[0].input).toMatchObject({
      id: "queens",
      workspaceId: "workspace-a",
      agentId: "active",
      button: { title: "Queens", label: "Queens", behavior: { kind: "popover" } },
    });

    const emit = subscriber as unknown as (update: unknown) => void;
    emit({
      kind: "update",
      agent: { id: "active", workspaceId: "workspace-a", status: "running" },
    });
    expect(registrations).toHaveLength(1);

    emit({ kind: "update", agent: { id: "active", workspaceId: "workspace-b", status: "idle" } });
    expect(registrations).toHaveLength(2);
    expect(registrations[0].remove).toHaveBeenCalledOnce();
    expect(registrations[1].input.workspaceId).toBe("workspace-b");

    emit({ kind: "remove", agentId: "active" });
    expect(registrations[1].remove).toHaveBeenCalledOnce();

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
