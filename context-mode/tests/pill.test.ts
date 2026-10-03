import { describe, expect, test, vi } from "vitest";
import { contributeContextModeComposerPills } from "../client/context-mode-pill";

test("pill opens Knowledge by IDs on new hosts and the unscoped surface on old hosts", async () => {
  for (const supported of [true, false]) {
    let press: () => void = () => {};
    const client = {
      paseo: {
        agents: {
          list: async () => ({
            subscription: {
              subscribe(observer: { snapshot(input: unknown): void }) {
                observer.snapshot({
                  entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }],
                });
                return () => {};
              },
              release: vi.fn(),
            },
          }),
        },
      },
      addComposerPill: vi.fn((input) => {
        press = input.button.behavior.onPress;
        return { remove: vi.fn() };
      }),
      addScreen: supported ? vi.fn() : undefined,
      openScreen: supported ? vi.fn() : undefined,
      openSurface: vi.fn(),
    };
    const cleanup = contributeContextModeComposerPills(client as never);
    await Promise.resolve();
    press();
    if (supported) {
      expect(client.openScreen).toHaveBeenCalledWith({
        screenId: "context-mode",
        params: { section: "knowledge", agentId: "a", workspaceId: "w" },
      });
      expect(client.openSurface).not.toHaveBeenCalled();
    } else expect(client.openSurface).toHaveBeenCalledWith("context-mode");
    cleanup();
  }
});

type Agent = { id: string; workspaceId: string; status: string };
type Observer = {
  snapshot(input: { entries: { agent: Agent }[] }): void;
  update(message: { type: string; payload?: unknown }): void;
};

function harness(list?: () => Promise<unknown>) {
  const pills: { workspaceId: string; press(): void; remove: ReturnType<typeof vi.fn> }[] = [];
  let observer: Observer | undefined;
  const release = vi.fn().mockResolvedValue(undefined);
  const client = {
    paseo: {
      agents: {
        list:
          list ??
          (async () => ({
            subscription: {
              subscribe(next: Observer) {
                observer = next;
                return vi.fn();
              },
              release,
            },
          })),
      },
    },
    addComposerPill: vi.fn((input) => {
      const remove = vi.fn();
      pills.push({ workspaceId: input.workspaceId, press: input.button.behavior.onPress, remove });
      return { remove };
    }),
    addScreen: vi.fn(),
    openScreen: vi.fn(),
    openSurface: vi.fn(),
  };
  return { client, pills, release, observer: () => observer };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const upsert = (agent: Agent) => ({ type: "agent_update", payload: { kind: "upsert", agent } });

describe("pill lifecycle", () => {
  test("moving an agent to another workspace re-scopes the pill", async () => {
    const h = harness();
    contributeContextModeComposerPills(h.client as never);
    await flush();
    h.observer()?.update(upsert({ id: "a", workspaceId: "w1", status: "idle" }));
    h.observer()?.update(upsert({ id: "a", workspaceId: "w2", status: "idle" }));
    expect(h.pills[0].remove).toHaveBeenCalledOnce();
    h.pills[1].press();
    expect(h.client.openScreen).toHaveBeenCalledWith({
      screenId: "context-mode",
      params: { section: "knowledge", agentId: "a", workspaceId: "w2" },
    });
  });

  test("closed agents, removals, and snapshot omissions drop their pills", async () => {
    const h = harness();
    contributeContextModeComposerPills(h.client as never);
    await flush();
    const observer = h.observer();
    observer?.update(upsert({ id: "a", workspaceId: "w1", status: "idle" }));
    observer?.update(upsert({ id: "a", workspaceId: "w1", status: "closed" }));
    expect(h.pills[0].remove).toHaveBeenCalledOnce();
    observer?.update(upsert({ id: "b", workspaceId: "w1", status: "idle" }));
    observer?.update({ type: "agent_update", payload: { kind: "remove", agentId: "b" } });
    expect(h.pills[1].remove).toHaveBeenCalledOnce();
    observer?.update({ type: "other" });
    observer?.snapshot({ entries: [{ agent: { id: "c", workspaceId: "w1", status: "idle" } }] });
    observer?.snapshot({ entries: [] });
    expect(h.pills[2].remove).toHaveBeenCalledOnce();
  });

  test("cleanup before the subscription resolves releases it without subscribing", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn();
    const h = harness(async () => ({ subscription: { subscribe, release } }));
    contributeContextModeComposerPills(h.client as never)();
    await flush();
    expect(release).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("a failed observation logs while running and stays silent after cleanup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = harness(async () => {
      throw new Error("down");
    });
    contributeContextModeComposerPills(failing.client as never);
    await flush();
    expect(error).toHaveBeenCalledOnce();
    error.mockClear();
    const stopped = harness(async () => {
      throw new Error("down");
    });
    contributeContextModeComposerPills(stopped.client as never)();
    await flush();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
