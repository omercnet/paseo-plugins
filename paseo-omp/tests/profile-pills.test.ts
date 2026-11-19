import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../client/hub-icon", () => ({ OMP_ICON: { svg: "<svg></svg>" } }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
vi.mock("../client/config-sidebar", () => ({ ConfigSidebarItem: () => null }));
vi.mock("../client/mcp-authorization", () => ({ OmpMcpAuthorizationCard: () => null }));
vi.mock("../client/mcp-popover", () => ({ McpPopover: () => null }));
vi.mock("../client/memory-panel", () => ({ OmpMemoryPanel: () => null }));
vi.mock("../client/memory-popover", () => ({ MemoryPopover: () => null }));
vi.mock("../client/omp-config-surface", () => ({
  OmpConfigSurface: () => null,
  OmpWorkspacePanel: () => null,
}));
vi.mock("../client/provider-icon", () => ({ quotaProviderIcon: () => () => null }));
vi.mock("../client/provider-image", () => ({ OmpImageTimeline: () => null }));
vi.mock("../client/quota-popover", () => ({ QuotaPopover: () => null }));
vi.mock("../client/subagents-strip", () => ({ OmpSubagentStrip: () => null }));
vi.mock("../client/rule-notice", () => ({ OmpRuleNoticeRow: () => null }));
vi.mock("../client/lsp-diagnostics", () => ({ OmpLspDiagnosticsCard: () => null }));
vi.mock("../client/generated-image", () => ({ OmpGeneratedImagesRow: () => null }));
vi.mock("../client/ast-edit", () => ({ OmpAstEditCard: () => null }));

import contribute from "../index.client";
import { getOmpSessionModelProvider, listOmpQuotas } from "../shared/quota";

// Settings that relocate OMP's store; none may reach a test from the runner's environment.
const OMP_LOCATION_ENV = [
  "OMP_AGENT_DIR",
  "OMP_PROFILE",
  "PASEO_OMP_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
];

beforeEach(() => {
  for (const name of OMP_LOCATION_ENV) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("owned agent directory updates reconcile new agent pills and cached quota results", async () => {
  vi.useFakeTimers();
  const agents = [
    { id: "alpha", provider: "omp-plugin-team-alpha", model: "omp:model:opaque-a" },
    { id: "team-beta", provider: "omp-plugin-team-beta", model: "omp:model:opaque-b" },
    { id: "default", provider: "omp", model: "anthropic/claude-fable-5" },
    { id: "codex", provider: "codex", model: "gpt-5.6-sol" },
  ];
  let onDirectoryUpdate = () => {};
  const listOptions: Array<{ filter?: { includeBackground?: boolean }; subscribe?: object }> = [];
  const buttons: Array<{
    id: string;
    agentId: string;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }> = [];
  const rpc = vi.fn(async (definition, input) => {
    if (definition.name === "settings.composer-pills.read") {
      return {
        status: "ready",
        revision: "revision-1",
        values: { mcp: true, hub: true, memory: true, quota: true },
      };
    }
    if (definition !== listOmpQuotas) return { processes: [] };
    const profile = input.store?.profile;
    const fraction = profile === "team-alpha" ? 0.9 : profile === "team-beta" ? 0.2 : 0.5;
    return {
      quotas: [
        {
          provider: "anthropic",
          label: "Five hour",
          windowLabel: "5h",
          usedFraction: fraction,
          status: "ok",
          resetsAt: null,
          recordedAt: 1,
        },
      ],
    };
  });
  const registration = () => () => {};
  const client = {
    paseo: {
      agents: {
        list: async (options?: {
          filter?: { includeBackground?: boolean };
          subscribe?: object;
        }) => {
          listOptions.push(options ?? {});
          const result = {
            entries: agents.map((agent) => ({
              agent: {
                ...agent,
                cwd: "/same-workspace",
                workspaceId: "workspace",
                archivedAt: null,
              },
            })),
            pageInfo: { hasMore: false },
          };
          if (!options?.subscribe) return result;
          return {
            ...result,
            subscriptionId: "agents",
            subscription: {
              ready: Promise.resolve({ ...result, subscriptionId: "agents" }),
              subscribe: (observer: { update: () => void }) => {
                onDirectoryUpdate = observer.update;
                return () => {};
              },
              release: async () => {},
            },
          };
        },
      },
    },
    rpc,
    addWorkspacePanel: registration,
    addCommandCenterItem: registration,
    addScreen: registration,
    addSidebarHeaderItem: registration,
    openScreen: vi.fn(),
    addTimelineRenderer: registration,
    addTimelineTransformer: registration,
    addComposerPill: (options: { id: string; agentId: string }) => {
      const button = { ...options, update: vi.fn(), remove: vi.fn() };
      buttons.push(button);
      return button;
    },
  } as unknown as PluginClientContext;
  const dispose = contribute(client);
  await Promise.resolve();
  await Promise.resolve();
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(buttons.filter((button) => button.id === "mcp").map((button) => button.agentId)).toEqual(
      ["alpha", "team-beta"],
    );
    // Subagent controls live in the timeline, beside Paseo's own subagent pill.
    expect(buttons.some((button) => button.id === "subagents")).toBe(false);
    const quota = (agentId: string) => {
      const button = buttons.findLast(
        (button) => button.id === "quota" && button.agentId === agentId,
      );
      if (!button) throw new Error(`Missing quota pill for ${agentId}`);
      return button;
    };
    expect(quota("alpha").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 90%" }),
    );
    expect(quota("team-beta").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 20%" }),
    );
    expect(quota("default").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "50%" }),
    );
    expect(quota("codex").update).not.toHaveBeenCalled();
    expect(
      rpc.mock.calls
        .filter(([definition]) => definition === listOmpQuotas)
        .map(([, input]) => input.store?.profile),
    ).toEqual(["team-alpha", "team-beta", undefined]);
    // Pills must attach to agents in background workspaces, for the page fetch and the subscription.
    expect(listOptions.some((options) => options.subscribe)).toBe(true);
    expect(listOptions.map((options) => options.filter)).toEqual(
      listOptions.map(() => ({ includeBackground: true })),
    );

    agents.push({
      id: "new-agent",
      provider: "omp-plugin-team-alpha",
      model: "omp:model:opaque-new",
    });
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(buttons.filter((button) => button.id === "mcp").map((button) => button.agentId)).toEqual(
      ["alpha", "team-beta", "new-agent"],
    );

    agents[0].provider = "omp-plugin-team-beta";
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(quota("alpha").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 20%" }),
    );
    expect(rpc.mock.calls.filter(([definition]) => definition === listOmpQuotas)).toHaveLength(3);
  } finally {
    dispose();
  }
});

test("summarizes an OMP Plugin agent's quota by the provider its live session names", async () => {
  vi.useFakeTimers();
  const agents = [
    { id: "live", provider: "omp-plugin", model: "omp:model:opaque", status: "idle" },
    { id: "ended", provider: "omp-plugin", model: "omp:model:opaque", status: "closed" },
    // A server without the RPC (older, or reloading) rejects it.
    { id: "older", provider: "omp-plugin", model: "omp:model:opaque", status: "idle" },
    // A live session whose OMP runtime is down answers null until it recovers.
    { id: "recovering", provider: "omp-plugin", model: "omp:model:opaque", status: "idle" },
  ];
  let runtimeRecovered = false;
  let onDirectoryUpdate = () => {};
  const buttons: Array<{ id: string; agentId: string; update: ReturnType<typeof vi.fn> }> = [];
  const rpc = vi.fn(async (definition, input) => {
    if (definition.name === "settings.composer-pills.read") {
      return { status: "ready", revision: "r", values: { quota: true } };
    }
    if (definition === getOmpSessionModelProvider) {
      if (input.agentId === "older") throw new Error("unknown operation");
      if (input.agentId === "recovering") {
        return { provider: runtimeRecovered ? "openai-codex" : null };
      }
      return { provider: input.agentId === "live" ? "openai-codex" : null };
    }
    if (definition !== listOmpQuotas) return { processes: [] };
    const row = { label: "Window", windowLabel: null, status: "ok", resetsAt: null, recordedAt: 1 };
    return {
      quotas: [
        { ...row, provider: "anthropic", usedFraction: 0.9 },
        { ...row, provider: "openai-codex", usedFraction: 0.3 },
      ],
    };
  });
  const registration = () => () => {};
  let passes = 0;
  const list = async (options?: { subscribe?: object }) => {
    if (!options?.subscribe) passes += 1;
    const result = {
      entries: agents.map((agent) => ({
        agent: { ...agent, cwd: "/workspace", workspaceId: "workspace", archivedAt: null },
      })),
      pageInfo: { hasMore: false },
    };
    if (!options?.subscribe) return result;
    return {
      ...result,
      subscription: {
        ready: Promise.resolve(result),
        subscribe: (observer: { update: () => void }) => {
          onDirectoryUpdate = observer.update;
          return () => {};
        },
        release: async () => {},
      },
    };
  };
  const client = {
    paseo: { agents: { list } },
    rpc,
    addWorkspacePanel: registration,
    addCommandCenterItem: registration,
    addScreen: registration,
    addSidebarHeaderItem: registration,
    openScreen: vi.fn(),
    addTimelineRenderer: registration,
    addTimelineTransformer: registration,
    addComposerPill: (options: { id: string; agentId: string }) => {
      const button = { ...options, update: vi.fn(), remove: vi.fn() };
      buttons.push(button);
      return button;
    },
  } as unknown as PluginClientContext;
  const dispose = contribute(client);
  const quota = (agentId: string) =>
    buttons.findLast((button) => button.id === "quota" && button.agentId === agentId)?.update;
  const askedAll = () =>
    rpc.mock.calls
      .filter(([definition]) => definition === getOmpSessionModelProvider)
      .map(([, input]) => input.agentId);
  const asked = () => askedAll().filter((id) => id !== "recovering");
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(quota("live")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "30%", title: expect.stringMatching(/^OpenAI · /u) }),
    );
    // A closed agent has no session to ask and keeps the all-provider summary.
    expect(quota("ended")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 90%" }),
    );
    // A rejected lookup also keeps it, and so does a null answer while the runtime is down.
    expect(quota("older")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 90%" }),
    );
    expect(quota("recovering")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 90%" }),
    );
    expect(asked()).toEqual(["live", "older"]);
    // Each lookup names the model it saw, so a late answer cannot label a model the agent left.
    expect(rpc).toHaveBeenCalledWith(getOmpSessionModelProvider, {
      agentId: "live",
      model: "omp:model:opaque",
    });

    // The same model and status reuse the answer, a rejection included; a new model asks again.
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(asked()).toEqual(["live", "older"]);
    agents[0].model = "omp:model:other";
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(asked()).toEqual(["live", "older", "live"]);

    // The session closes, then resumes with the same model: closed is not asked and shows every
    // provider; resumed, it shows the known provider again without asking, since the opaque id is
    // a hash of OMP's provider and model, so one id always names the same provider.
    agents[0].status = "closed";
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(asked()).toEqual(["live", "older", "live"]);
    expect(quota("live")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 90%" }),
    );
    agents[0].status = "idle";
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    expect(asked()).toEqual(["live", "older", "live"]);
    expect(quota("live")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "30%", title: expect.stringMatching(/^OpenAI · /u) }),
    );

    // Missing answers are retried once the back-off ends, with no directory update: the directory
    // may never change again, so the plugin schedules that pass itself.
    expect(askedAll().filter((id) => id === "recovering")).toHaveLength(1);
    runtimeRecovered = true;
    await vi.advanceTimersByTimeAsync(60_000 + 250);
    expect(asked().filter((id) => id === "older")).toHaveLength(2);
    expect(askedAll().filter((id) => id === "recovering")).toHaveLength(2);
    expect(quota("recovering")).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "30%", title: expect.stringMatching(/^OpenAI · /u) }),
    );
    // The recovered answer is kept; only the rejection keeps its back-off.
    await vi.advanceTimersByTimeAsync(60_000 + 250);
    expect(asked().filter((id) => id === "older")).toHaveLength(3);
    expect(askedAll().filter((id) => id === "recovering")).toHaveLength(2);

    // The failing agent closes: its missing answer is dropped, so no retry pass is left to repeat.
    agents[2].status = "closed";
    onDirectoryUpdate();
    await vi.advanceTimersByTimeAsync(250);
    const passesAfterClose = passes;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(passes).toBe(passesAfterClose);
    expect(asked().filter((id) => id === "older")).toHaveLength(3);
  } finally {
    dispose();
  }
});
