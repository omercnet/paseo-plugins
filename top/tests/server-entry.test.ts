import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { startSampler } from "../server/usage";
import { getUsage, type Session } from "../shared/usage";

vi.mock("../server/usage", () => ({ startSampler: vi.fn() }));

const base = {
  cpu: 1,
  memory: 2,
  disk: 3,
  io: 4,
  history: [],
  totalMemory: 8,
  other: { cores: 0, rss: 0 },
};

const session: Session = {
  agentId: "a1",
  title: null,
  workspace: null,
  cores: 1,
  rss: 1,
  command: "x",
  processes: 1,
  heavy: false,
};

function setup(sessions: Session[] | null) {
  const stop = vi.fn();
  vi.mocked(startSampler).mockReturnValue({ usage: () => ({ ...base, sessions }), stop } as never);
  const handle = vi.fn();
  const cleanup = contribute({ handle } as unknown as PluginServerContext);
  const list = vi.fn();
  const paseo = {
    agents: {
      list: list.mockResolvedValue({
        entries: [{ agent: { id: "a1", title: "Fix login", workspaceId: "w1" } }],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue({
        entries: [{ id: "w1", title: null, name: "main" }],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  const handler = handle.mock.calls[0]?.[1] as (input: object, ctx: { paseo: PaseoApi }) => unknown;
  return { stop, cleanup, call: () => handler({}, { paseo }), list };
}

describe("server entry", () => {
  it("returns output the RPC contract accepts, with listed sessions, names, and folded-in load", async () => {
    const foreign = { ...session, agentId: "other-daemon", cores: 0.1 + 0.2, rss: 40 };
    const { call } = setup([{ ...session, command: "", heavy: true }, foreign]);
    const output = await call();
    expect(() => getUsage.output.parse(output)).not.toThrow();
  });

  it("lists only sessions of this daemon's agents and counts the rest as other load", async () => {
    const { call } = setup([session, { ...session, agentId: "other-daemon", cores: 4, rss: 40 }]);
    expect(await call()).toMatchObject({
      sessions: [{ agentId: "a1" }],
      other: { cores: 4, rss: 40 },
    });
  });

  it("answers with the sampler's usage and the user's own names on each session", async () => {
    const { call } = setup([session]);
    expect(await call()).toMatchObject({
      cpu: 1,
      sessions: [{ agentId: "a1", title: "Fix login", workspace: "main" }],
    });
  });

  it("passes an unsupported host through without asking the daemon for names", async () => {
    const { call, list } = setup(null);
    expect(await call()).toMatchObject({ sessions: null });
    expect(list).not.toHaveBeenCalled();
  });

  it("stops the sampler when the plugin is torn down", () => {
    const { cleanup, stop } = setup([]);
    expect(stop).not.toHaveBeenCalled();
    cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cancels a daemon read that is still in flight when the plugin is torn down", async () => {
    const { cleanup, call, list } = setup([session]);
    list.mockImplementation(() => new Promise(() => {})); // the daemon never answers
    const answered = call();
    await Promise.resolve();
    const options = list.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    cleanup();
    expect(options.signal.aborted).toBe(true);
    expect(await answered).toMatchObject({ sessions: [], other: { cores: 1, rss: 1 } });
  });
});
