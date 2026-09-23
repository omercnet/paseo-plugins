import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: () => null,
  Modal: () => null,
  ScrollView: () => null,
  TextInput: () => null,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Image: () => null,
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Pressable: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: () => null,
  View: () => null,
}));

import { contributeSharedBrowserClient } from "../client/browser";

type Agent = { id: string; workspaceId?: string };
type AgentUpdate = { kind: "remove"; agentId: string } | { kind: "upsert"; agent: Agent };
type AgentPage = {
  entries: Array<{ agent: Agent }>;
  pageInfo: { hasMore: boolean; nextCursor: string | null };
};
type AgentObserver = {
  snapshot(snapshot: AgentPage): void;
  update(message: { type: "agent_update"; payload: AgentUpdate }): void;
};

function page(entries: Agent[], nextCursor: string | null = null): AgentPage {
  return {
    entries: entries.map((agent) => ({ agent })),
    pageInfo: { hasMore: nextCursor !== null, nextCursor },
  };
}

function createHarness(pages: Array<AgentPage | Promise<AgentPage>>) {
  let observer: AgentObserver | null = null;
  const removeObserver = vi.fn();
  const releaseDirectory = vi.fn(async () => undefined);
  const removePill = vi.fn();
  const list = vi.fn(async (options: { subscribe?: object; signal?: AbortSignal }) => {
    if (options.subscribe) {
      return {
        subscription: {
          release: releaseDirectory,
          subscribe(nextObserver: AgentObserver) {
            observer = nextObserver;
            return removeObserver;
          },
        },
      };
    }
    const next = pages.shift();
    if (!next) throw new Error("Unexpected agent directory page");
    return next;
  });
  const addComposerPill = vi.fn(() => ({ remove: removePill }));
  const client = {
    paseo: { agents: { list } },
    rpc: vi.fn(async () => ({ workspaceIds: ["workspace-one", "workspace-two"] })),
    addComposerPill,
    openPanel: vi.fn(),
  };

  return {
    addComposerPill,
    cleanup: () => contributeSharedBrowserClient(client as never),
    list,
    observer: () => observer,
    removeObserver,
    releaseDirectory,
    removePill,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Shared Browser composer pills", () => {
  it("follows every directory page and adds pills for newly created agents", async () => {
    const harness = createHarness([page([{ id: "agent-two", workspaceId: "workspace-two" }])]);
    const cleanup = harness.cleanup();
    await settle();

    harness
      .observer()
      ?.snapshot(page([{ id: "agent-one", workspaceId: "workspace-one" }], "next-page"));
    await settle();

    expect(harness.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: { cursor: "next-page", limit: 200 } }),
    );
    expect(harness.addComposerPill).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-one", workspaceId: "workspace-one" }),
    );
    expect(harness.addComposerPill).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-two", workspaceId: "workspace-two" }),
    );

    harness.observer()?.update({
      type: "agent_update",
      payload: { kind: "upsert", agent: { id: "agent-three", workspaceId: "workspace-one" } },
    });
    await settle();

    expect(harness.addComposerPill).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-three", workspaceId: "workspace-one" }),
    );
    cleanup();
  });

  it("reconciles composer pills when the owned observation restores after reconnect", async () => {
    const harness = createHarness([]);
    const cleanup = harness.cleanup();
    await settle();

    harness.observer()?.snapshot(page([{ id: "agent-one", workspaceId: "workspace-one" }]));
    await settle();
    harness.observer()?.snapshot(page([{ id: "agent-two", workspaceId: "workspace-two" }]));
    await settle();

    expect(harness.removePill).toHaveBeenCalledOnce();
    expect(harness.addComposerPill).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-two", workspaceId: "workspace-two" }),
    );
    cleanup();
  });

  it("ignores late directory work after cleanup", async () => {
    let resolvePage: (value: AgentPage) => void = () => {
      throw new Error("Delayed page resolver is unavailable");
    };
    const delayedPage = new Promise<AgentPage>((resolve) => {
      resolvePage = resolve;
    });
    const harness = createHarness([delayedPage]);
    const cleanup = harness.cleanup();
    await settle();

    harness
      .observer()
      ?.snapshot(page([{ id: "agent-one", workspaceId: "workspace-one" }], "next-page"));
    cleanup();
    expect(harness.releaseDirectory).toHaveBeenCalledOnce();
    resolvePage(page([{ id: "agent-two", workspaceId: "workspace-two" }]));
    await settle();

    expect(harness.removeObserver).toHaveBeenCalledOnce();
    expect(harness.addComposerPill).not.toHaveBeenCalled();
  });
});
