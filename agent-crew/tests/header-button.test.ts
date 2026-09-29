import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, test, vi } from "vitest";
import { registerCrewHeaderButtons } from "../client/header-button";

type Update = { kind: "upsert"; workspace: { id: string } } | { kind: "remove"; id: string };

function fakeClient(pages: Array<{ ids: string[]; next?: string }>) {
  let onUpdate!: (update: Update) => void;
  const removed: string[] = [];
  const unsubscribe = vi.fn();
  const list = vi.fn(async ({ page }: { page: { cursor?: string } }) => {
    const index = page.cursor ? Number(page.cursor) : 0;
    const current = pages[index] ?? { ids: [] };
    return {
      entries: current.ids.map((id) => ({ id })),
      pageInfo: { hasMore: Boolean(current.next), nextCursor: current.next ?? null },
    };
  });
  const addHeaderButton = vi.fn(({ workspaceId }: { workspaceId: string }) => ({
    update: vi.fn(),
    remove: vi.fn(() => removed.push(workspaceId)),
  }));
  const openPanel = vi.fn();
  const client = {
    paseo: {
      workspaces: {
        list,
        subscribe: vi.fn((callback: (update: Update) => void) => {
          onUpdate = callback;
          return unsubscribe;
        }),
      },
    },
    addHeaderButton,
    openPanel,
  } as unknown as PluginClientContext;
  return {
    client,
    list,
    addHeaderButton,
    openPanel,
    removed,
    unsubscribe,
    emit: (u: Update) => onUpdate(u),
  };
}

const buttonFor = (calls: unknown[][], workspaceId: string) =>
  (
    calls.map((c) => c[0]) as Array<{
      workspaceId: string;
      id: string;
      button: { behavior: { onPress(): void } };
    }>
  ).find((c) => c.workspaceId === workspaceId);

describe("crew header buttons", () => {
  test("adds one button per listed workspace across pages", async () => {
    const fake = fakeClient([{ ids: ["w1", "w2"], next: "1" }, { ids: ["w3"] }]);
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(3));
    expect(fake.list).toHaveBeenCalledTimes(2);
    expect(fake.list.mock.calls[0][0]).toMatchObject({ subscribe: {} });
    expect((fake.list.mock.calls[0][0] as { subscribe?: object }).subscribe).not.toHaveProperty(
      "subscriptionId",
    );
    expect(fake.list.mock.calls[1][0]).not.toHaveProperty("subscribe");
    expect(buttonFor(fake.addHeaderButton.mock.calls, "w3")?.id).toBe("open-crew");
    cleanup();
  });

  test("pressing the button opens the crew panel in that workspace's explorer", async () => {
    const fake = fakeClient([{ ids: ["w1"] }]);
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(1));
    buttonFor(fake.addHeaderButton.mock.calls, "w1")?.button.behavior.onPress();
    expect(fake.openPanel).toHaveBeenCalledWith("crew", {
      workspaceId: "w1",
      location: "explorer",
    });
    cleanup();
  });

  test("tracks new and removed workspaces without duplicating buttons", async () => {
    const fake = fakeClient([{ ids: ["w1"] }]);
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(1));
    fake.emit({ kind: "upsert", workspace: { id: "w1" } });
    fake.emit({ kind: "upsert", workspace: { id: "w2" } });
    expect(fake.addHeaderButton).toHaveBeenCalledTimes(2);
    fake.emit({ kind: "remove", id: "w1" });
    expect(fake.removed).toEqual(["w1"]);
    fake.emit({ kind: "upsert", workspace: { id: "w1" } });
    expect(fake.addHeaderButton).toHaveBeenCalledTimes(3);
    cleanup();
  });

  test("a stale listing page does not resurrect a workspace removed while it loaded", async () => {
    const fake = fakeClient([{ ids: ["w1", "w2"] }]);
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = fake.list.getMockImplementation();
    fake.list.mockImplementationOnce(async (args) => {
      await gate;
      return original?.(args) as ReturnType<NonNullable<typeof original>>;
    });
    const cleanup = registerCrewHeaderButtons(fake.client);
    fake.emit({ kind: "remove", id: "w1" });
    release();
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 0));
    expect(fake.addHeaderButton.mock.calls.map((c) => c[0].workspaceId)).toEqual(["w2"]);
    fake.emit({ kind: "upsert", workspace: { id: "w1" } });
    expect(fake.addHeaderButton).toHaveBeenCalledTimes(2);
    cleanup();
  });

  test("a stale later page does not resurrect a workspace upserted then removed", async () => {
    const fake = fakeClient([{ ids: ["w1"], next: "1" }, { ids: ["w2", "w9"] }]);
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = fake.list.getMockImplementation();
    fake.list
      .mockImplementationOnce(
        async (args) => original?.(args) as ReturnType<NonNullable<typeof original>>,
      )
      .mockImplementationOnce(async (args) => {
        await gate;
        return original?.(args) as ReturnType<NonNullable<typeof original>>;
      });
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    fake.emit({ kind: "upsert", workspace: { id: "w9" } });
    fake.emit({ kind: "remove", id: "w9" });
    release();
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(3));
    await new Promise((done) => setTimeout(done, 0));
    expect(fake.addHeaderButton.mock.calls.map((c) => c[0].workspaceId)).toEqual([
      "w1",
      "w9",
      "w2",
    ]);
    expect(fake.removed).toEqual(["w9"]);
    cleanup();
  });

  test("lists every page past the old 2,000-workspace cap and stops on a repeated cursor", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      ids: [`w${i}`],
      next: i < 11 ? String(i + 1) : undefined,
    }));
    const fake = fakeClient(pages);
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(12));
    cleanup();

    const looping = fakeClient([
      { ids: ["a"], next: "1" },
      { ids: ["b"], next: "1" },
    ]);
    const stop = registerCrewHeaderButtons(looping.client);
    await vi.waitFor(() => expect(looping.addHeaderButton).toHaveBeenCalledTimes(2));
    await new Promise((done) => setTimeout(done, 0));
    expect(looping.list).toHaveBeenCalledTimes(2);
    stop();
  });

  test("a listing page that resolves after cleanup registers nothing", async () => {
    const fake = fakeClient([{ ids: ["w1"] }]);
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = fake.list.getMockImplementation();
    fake.list.mockImplementationOnce(async (args) => {
      await gate;
      return original?.(args) as ReturnType<NonNullable<typeof original>>;
    });
    const cleanup = registerCrewHeaderButtons(fake.client);
    cleanup();
    release();
    await new Promise((done) => setTimeout(done, 0));
    expect(fake.addHeaderButton).not.toHaveBeenCalled();
  });

  test("cleanup removes every button, unsubscribes, and ignores later updates", async () => {
    const fake = fakeClient([{ ids: ["w1", "w2"] }]);
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() => expect(fake.addHeaderButton).toHaveBeenCalledTimes(2));
    cleanup();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.removed.sort()).toEqual(["w1", "w2"]);
    fake.emit({ kind: "upsert", workspace: { id: "w9" } });
    expect(fake.addHeaderButton).toHaveBeenCalledTimes(2);
  });

  test("a listing failure or a throwing addHeaderButton does not break the plugin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeClient([]);
    fake.list.mockRejectedValueOnce(new Error("daemon down"));
    fake.addHeaderButton.mockImplementationOnce(() => {
      throw new Error("host refused");
    });
    const cleanup = registerCrewHeaderButtons(fake.client);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not list"),
        expect.any(Error),
      ),
    );
    expect(() => fake.emit({ kind: "upsert", workspace: { id: "w1" } })).not.toThrow();
    fake.emit({ kind: "upsert", workspace: { id: "w1" } });
    expect(fake.addHeaderButton).toHaveBeenCalledTimes(2);
    cleanup();
    warn.mockRestore();
  });
});
