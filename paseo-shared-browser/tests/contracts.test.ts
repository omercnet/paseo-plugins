import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import {
  type BrowserState,
  browserFrameSchema,
  browserInputEventSchema,
  browserStateSchema,
  didBrowserRuntimeRestart,
  isBrowserStateCurrent,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  mapDisplayedPoint,
  viewportSchema,
} from "../shared/browser";

const browserMocks = vi.hoisted(() => ({
  bindAgentTicket: vi.fn(),
  cleanupBrowserServer: vi.fn(),
  handleAcquireControl: vi.fn(),
  handleApplyDevicePreset: vi.fn(),
  handleAttachBrowser: vi.fn(),
  handleCaptureBrowser: vi.fn(),
  handleCloseBrowser: vi.fn(),
  handleCloseBrowserTab: vi.fn(),
  handleCreateBrowserTab: vi.fn(),
  handleListBrowserTabs: vi.fn(),
  handleReopenBrowser: vi.fn(),
  handleSetCaptureDensity: vi.fn(),
  handleReadBrowserVideo: vi.fn(),
  handleDetachBrowser: vi.fn(),
  handleListOpenBrowserWorkspaces: vi.fn(),
  handleNavigateBrowser: vi.fn(),
  handleReleaseControl: vi.fn(),
  handleResizeBrowser: vi.fn(),
  handleSendBrowserInput: vi.fn(),
  handleBeginBrowserGesture: vi.fn(),
  handleUpdateBrowserGesture: vi.fn(),
  handleEndBrowserGesture: vi.fn(),
  handleKeepAliveBrowserGesture: vi.fn(),
  handleGetBrowserVideoSettings: vi.fn(),
  handleSetBrowserVideoSettings: vi.fn(),
  handleWorkspaceArchived: vi.fn(),
  issueAgentTicket: vi.fn().mockResolvedValue(undefined),
  revokeAgentBrowserAccess: vi.fn(),
}));
const testDirectory = dirname(fileURLToPath(import.meta.url));

vi.mock("../server/browser", () => browserMocks);

type AgentCreateRequest = {
  config: {
    provider: string;
    cwd: string;
    internal?: boolean;
    mcpServers?: Record<string, unknown>;
  };
  env?: Record<string, string>;
};

type AgentCreateHook = (
  input: { request: AgentCreateRequest },
  context?: unknown,
) => Promise<AgentCreateRequest>;

type SessionOpenRequest = {
  agentId: string;
  workspaceId: string | null;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  background: boolean;
  labels: Record<string, string>;
  env: Record<string, string>;
  mcpServers: Record<string, unknown>;
};

type SessionOpenHook = (input: { request: SessionOpenRequest }) => Promise<SessionOpenRequest>;

function captureHooks(readAccess?: () => Promise<unknown>): {
  create: AgentCreateHook;
  open: SessionOpenHook;
} {
  let create: AgentCreateHook | undefined;
  let open: SessionOpenHook | undefined;
  contribute({
    registerSettings: vi.fn((definition: { id: string }) =>
      definition.id === "agent-access" && readAccess ? { read: readAccess } : undefined,
    ),
    handle: vi.fn(),
    before: vi.fn((name: string, handler: unknown) => {
      if (name === "agent.create") create = handler as AgentCreateHook;
      if (name === "agent.session_open") open = handler as SessionOpenHook;
      return () => {};
    }),
    on: vi.fn(),
  } as never);
  if (!create || !open) throw new Error("the agent hooks were not registered");
  return { create, open };
}

function captureAgentCreateHook(readAccess?: () => Promise<unknown>): AgentCreateHook {
  return captureHooks(readAccess).create;
}

const BASE_STATE: BrowserState = {
  sessionId: "s".repeat(32),
  workspaceId: "workspace",
  status: "ready",
  url: "https://example.com/",
  title: "Example",
  canGoBack: false,
  canGoForward: false,
  viewport: { width: 1280, height: 800 },
  navigationGeneration: 4,
  viewportGeneration: 2,
  devicePresetId: null,
  captureScale: 1,
  userAgent: "Chromium",
  controller: "none",
  controllerLabel: null,
  controllerExpiresAt: null,
  viewerCount: 1,
  error: null,
};

describe("mapDisplayedPoint", () => {
  it("maps a contained image point into canonical CSS pixels", () => {
    expect(
      mapDisplayedPoint({ x: 320, y: 180, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toEqual({ x: 640, y: 360 });
  });

  it("rejects coordinates outside the displayed image", () => {
    expect(() =>
      mapDisplayedPoint({ x: 641, y: 20, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toThrow("outside the displayed frame");
  });

  it("clamps an inclusive bottom-right edge inside the browser viewport", () => {
    expect(
      mapDisplayedPoint({ x: 640, y: 360, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toEqual({ x: 1279, y: 719 });
  });
});

describe("shared RPC validation", () => {
  it("bounds the canonical viewport independently of viewer size", () => {
    expect(viewportSchema.safeParse(MIN_VIEWPORT).success).toBe(true);
    expect(viewportSchema.safeParse(MAX_VIEWPORT).success).toBe(true);
    expect(viewportSchema.safeParse({ width: 320, height: 240 }).success).toBe(false);
    expect(viewportSchema.safeParse({ width: 2560, height: 1440 }).success).toBe(true);
    expect(viewportSchema.safeParse({ width: 2560, height: 2560 }).success).toBe(true);
    expect(viewportSchema.safeParse({ width: 3841, height: 1440 }).success).toBe(false);
    expect(viewportSchema.safeParse({ width: 1280, height: 3841 }).success).toBe(false);
  });

  it("rejects unbounded input text and scroll deltas", () => {
    expect(
      browserInputEventSchema.safeParse({ kind: "type", text: "x".repeat(4_001) }).success,
    ).toBe(false);
    expect(
      browserInputEventSchema.safeParse({
        kind: "scroll",
        point: { x: 1, y: 1, width: 10, height: 10 },
        deltaX: 0,
        deltaY: 4_001,
      }).success,
    ).toBe(false);
  });
});

describe("recovery schema validation", () => {
  it("bounds optional supervisor epochs and typed recovery state", () => {
    expect(
      browserStateSchema.safeParse({
        ...BASE_STATE,
        runtimeId: "r".repeat(32),
        runtimeCreatedAt: Date.now(),
        bridgeEpoch: Number.MAX_SAFE_INTEGER,
        recoveryState: "runtime-unavailable",
      }).success,
    ).toBe(true);
    expect(
      browserStateSchema.safeParse({
        ...BASE_STATE,
        bridgeEpoch: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      browserFrameSchema.safeParse({
        sessionId: BASE_STATE.sessionId,
        frameId: "f".repeat(32),
        mimeType: "image/jpeg",
        transport: "screenshot",
        dataBase64: "eA==",
        byteLength: 1,
        width: 1280,
        height: 800,
        navigationGeneration: 4,
        viewportGeneration: 2,
        runtimeId: "r".repeat(32),
        captureEpoch: Number.MAX_SAFE_INTEGER + 1,
        capturedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("browser epoch fencing", () => {
  it("rejects a stale bridge response from the same runtime", () => {
    const current = { ...BASE_STATE, runtimeId: "r".repeat(32), bridgeEpoch: 8 };
    const stale = { ...current, bridgeEpoch: 7 };
    expect(isBrowserStateCurrent(current, stale)).toBe(false);
  });

  it("rejects an older runtime after a restart was observed", () => {
    const current = {
      ...BASE_STATE,
      runtimeId: "b".repeat(32),
      runtimeCreatedAt: 20,
      bridgeEpoch: 9,
    };
    const stale = {
      ...current,
      runtimeId: "a".repeat(32),
      runtimeCreatedAt: 10,
      bridgeEpoch: 8,
    };
    expect(isBrowserStateCurrent(current, stale)).toBe(false);
  });

  it("accepts viewer reconnects without reporting a runtime restart", () => {
    const current = { ...BASE_STATE, runtimeId: "r".repeat(32), bridgeEpoch: 8 };
    const reconnected = { ...current, bridgeEpoch: 9, viewerCount: 2 };
    expect(isBrowserStateCurrent(current, reconnected)).toBe(true);
    expect(didBrowserRuntimeRestart(current, reconnected)).toBe(false);
  });

  it("accepts reset generations and reports a changed runtime", () => {
    const current = { ...BASE_STATE, runtimeId: "a".repeat(32), bridgeEpoch: 8 };
    const restarted = {
      ...current,
      runtimeId: "b".repeat(32),
      bridgeEpoch: 9,
      navigationGeneration: 0,
      viewportGeneration: 0,
      recoveryState: "browser-restarted" as const,
    };
    expect(isBrowserStateCurrent(current, restarted)).toBe(true);
    expect(didBrowserRuntimeRestart(current, restarted)).toBe(true);
  });
});

describe("agent MCP injection", () => {
  beforeEach(() => {
    browserMocks.issueAgentTicket.mockClear();
  });

  it("injects the adapter for the built-in OMP provider", async () => {
    const hook = captureAgentCreateHook();
    const request: AgentCreateRequest = {
      config: { provider: "omp", cwd: "/workspace" },
      env: { EXISTING: "value" },
    };

    const transformed = await hook({ request });
    const ticket = transformed.env?.PASEO_SHARED_BROWSER_TICKET;
    expect(ticket).toEqual(expect.any(String));
    expect(browserMocks.issueAgentTicket).toHaveBeenCalledWith(ticket);
    expect(transformed.config.mcpServers).toMatchObject({
      "shared-browser": { type: "stdio", env: { PASEO_SHARED_BROWSER_TICKET: ticket } },
    });
  });

  it("never injects into internal agents", async () => {
    const hook = captureAgentCreateHook();
    const request: AgentCreateRequest = {
      config: { provider: "omp", cwd: "/workspace", internal: true },
    };

    await expect(hook({ request })).resolves.toBe(request);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
  });

  it("injects the adapter for providers that accept external MCP servers", async () => {
    const hook = captureAgentCreateHook();
    const request: AgentCreateRequest = {
      config: { provider: "codex", cwd: "/workspace" },
      env: { EXISTING: "value" },
    };

    const transformed = await hook({ request });
    const ticket = transformed.env?.PASEO_SHARED_BROWSER_TICKET;
    expect(ticket).toEqual(expect.any(String));
    expect(browserMocks.issueAgentTicket).toHaveBeenCalledWith(ticket);
    expect(transformed.config.mcpServers).toMatchObject({
      "shared-browser": { type: "stdio", env: { ELECTRON_RUN_AS_NODE: "1" } },
    });
  });
});

describe("agent access", () => {
  beforeEach(() => {
    browserMocks.issueAgentTicket.mockClear();
  });

  const ready = (values: Record<string, unknown>) => async () => ({
    status: "ready",
    values: { mode: "listed", providers: [], workspaces: [], projects: [], labels: [], ...values },
  });
  const request = (provider: string, cwd = "/repos/one"): AgentCreateRequest => ({
    config: { provider, cwd },
    env: { EXISTING: "value" },
  });
  const workspaceContext = (entries: unknown[]) => ({
    paseo: {
      workspaces: {
        list: vi
          .fn()
          .mockResolvedValue({ entries, pageInfo: { nextCursor: null, hasMore: false } }),
      },
    },
  });

  it("injects only agents whose provider is listed", async () => {
    const hook = captureAgentCreateHook(ready({ providers: ["codex"] }));
    const allowed = await hook({ request: request("codex") });
    expect(allowed.config.mcpServers).toHaveProperty("shared-browser");
    expect(browserMocks.issueAgentTicket).toHaveBeenCalledTimes(1);

    const other = request("claude");
    await expect(hook({ request: other })).resolves.toBe(other);
    expect(browserMocks.issueAgentTicket).toHaveBeenCalledTimes(1);
  });

  it("injects nothing and issues no ticket when listed and the lists are empty", async () => {
    const hook = captureAgentCreateHook(ready({}));
    const input = request("codex");
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
  });

  it("injects every agent in a listed workspace or project, found by directory", async () => {
    const entries = [{ id: "ws_a", projectId: "proj_1", workspaceDirectory: "/repos/one" }];
    const byWorkspace = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
    const first = await byWorkspace(
      { request: request("claude", "/repos/one/src") },
      workspaceContext(entries),
    );
    expect(first.config.mcpServers).toHaveProperty("shared-browser");

    const byProject = captureAgentCreateHook(ready({ projects: ["proj_1"] }));
    const second = await byProject({ request: request("claude") }, workspaceContext(entries));
    expect(second.config.mcpServers).toHaveProperty("shared-browser");

    const outside = request("claude", "/repos/two");
    await expect(byProject({ request: outside }, workspaceContext(entries))).resolves.toBe(outside);
  });

  it("treats a failed workspace lookup as no match", async () => {
    const hook = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
    const input = request("claude");
    const context = {
      paseo: { workspaces: { list: vi.fn().mockRejectedValue(new Error("down")) } },
    };
    await expect(hook({ request: input }, context)).resolves.toBe(input);
  });

  it("lists background workspaces too, and a list cut off at the page limit is no match", async () => {
    const hook = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
    const entries = [{ id: "ws_a", projectId: "proj_1", workspaceDirectory: "/repos/one" }];
    const context = workspaceContext(entries);
    await hook({ request: request("claude") }, context);
    expect(context.paseo.workspaces.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { includeBackground: true } }),
    );

    const endless = {
      paseo: {
        workspaces: {
          list: vi
            .fn()
            .mockResolvedValue({ entries, pageInfo: { nextCursor: "c", hasMore: true } }),
        },
      },
    };
    const input = request("claude");
    await expect(hook({ request: input }, endless)).resolves.toBe(input);
    expect(endless.paseo.workspaces.list).toHaveBeenCalledTimes(20);
  });

  it("does not match a directory that climbs out of a listed workspace", async () => {
    const hook = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
    const entries = [{ id: "ws_a", projectId: "proj_1", workspaceDirectory: "/repos/one" }];
    const input = request("claude", "/repos/one/../outside");
    await expect(hook({ request: input }, workspaceContext(entries))).resolves.toBe(input);
  });

  describe("deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a stalled settings read falls back to every agent, with a log line", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const hook = captureAgentCreateHook(() => new Promise<never>(() => {}));
        const pending = hook({ request: request("claude") });
        await vi.advanceTimersByTimeAsync(2_000);
        const transformed = await pending;
        expect(transformed.config.mcpServers).toHaveProperty("shared-browser");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/timed out/);
      } finally {
        warn.mockRestore();
      }
    });

    it("a stalled workspace lookup counts as no match, with a log line", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const hook = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
        const input = request("claude");
        const context = { paseo: { workspaces: { list: () => new Promise<never>(() => {}) } } };
        const pending = hook({ request: input }, context);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toBe(input);
        expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/lookup failed.*timed out/);
      } finally {
        warn.mockRestore();
      }
    });

    it("a read that rejects after the timeout fired is not an unhandled rejection", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const hook = captureAgentCreateHook(
          () =>
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 3_000)),
        );
        const pending = hook({ request: request("claude") });
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toMatchObject({
          config: { mcpServers: { "shared-browser": expect.anything() } },
        });
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", listener);
        warn.mockRestore();
      }
    });

    it("leaves no timer behind when the read and the lookup finish in time", async () => {
      vi.useFakeTimers();
      const hook = captureAgentCreateHook(ready({ workspaces: ["ws_a"] }));
      const entries = [{ id: "ws_a", projectId: "proj_1", workspaceDirectory: "/repos/one" }];
      const transformed = await hook({ request: request("claude") }, workspaceContext(entries));
      expect(transformed.config.mcpServers).toHaveProperty("shared-browser");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not time out a decision that finishes in time", async () => {
      vi.useFakeTimers();
      const hook = captureAgentCreateHook(ready({ providers: ["codex"] }));
      const pending = hook({ request: request("codex") });
      await vi.advanceTimersByTimeAsync(1_999);
      await expect(pending).resolves.toMatchObject({
        config: { mcpServers: { "shared-browser": expect.anything() } },
      });
    });
  });

  it.each([
    ["rejects", async () => Promise.reject(new Error("unreadable"))],
    [
      "throws synchronously",
      () => {
        throw new Error("unreadable");
      },
    ],
    ["is invalid", async () => ({ status: "invalid", revision: "1", error: "bad" })],
  ])("falls back to every agent, with one log line, when the setting %s", async (_name, read) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hook = captureAgentCreateHook(read as () => Promise<unknown>);
      const transformed = await hook({ request: request("anything") });
      expect(transformed.config.mcpServers).toHaveProperty("shared-browser");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/every new agent gets the browser tool/);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs nothing when the setting is readable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hook = captureAgentCreateHook(ready({ providers: ["codex"] }));
      await hook({ request: request("codex") });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("injects every agent in the default mode", async () => {
    const hook = captureAgentCreateHook(async () => ({
      status: "ready",
      values: { mode: "all", providers: [], workspaces: [], projects: [], labels: [] },
    }));
    const transformed = await hook({ request: request("anything") });
    expect(transformed.config.mcpServers).toHaveProperty("shared-browser");
  });
});

describe("agent access by label", () => {
  beforeEach(() => {
    vi.stubEnv("PASEO_HOME", join(tmpdir(), "shared-browser-label-tests-no-home"));
    browserMocks.issueAgentTicket.mockReset();
    browserMocks.bindAgentTicket.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const ready = (values: Record<string, unknown>) => async () => ({
    status: "ready",
    values: { mode: "listed", providers: [], workspaces: [], projects: [], labels: [], ...values },
  });
  const open = (over: Partial<SessionOpenRequest> = {}): SessionOpenRequest => ({
    agentId: "agent-1",
    workspaceId: "ws_a",
    reason: "create",
    purpose: "interactive",
    background: false,
    labels: { team: "blue" },
    env: { EXISTING: "value" },
    mcpServers: { other: { type: "stdio" } },
    ...over,
  });

  it("injects the adapter and binds a fresh ticket for an agent with a matching label", async () => {
    const { open: hook } = captureHooks(ready({ labels: ["team=blue"] }));
    const result = await hook({ request: open() });
    expect(result.mcpServers).toMatchObject({
      other: { type: "stdio" },
      "shared-browser": { type: "stdio", env: { ELECTRON_RUN_AS_NODE: "1" } },
    });
    const ticket = (result.mcpServers["shared-browser"] as { env: Record<string, string> }).env
      .PASEO_SHARED_BROWSER_TICKET;
    expect(ticket).toEqual(expect.any(String));
    expect(browserMocks.issueAgentTicket).toHaveBeenCalledWith(ticket);
    expect(browserMocks.bindAgentTicket).toHaveBeenCalledWith(ticket, "agent-1", "ws_a");
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  it("leaves a session alone when the server was already stored on the agent at creation", async () => {
    // The host sends mcpServers as {} to out-of-process plugins; the env ticket is the only sign of a stored server.
    const { open: hook } = captureHooks(ready({ labels: ["team"] }));
    const request = open({
      reason: "resume",
      mcpServers: {},
      env: { PASEO_SHARED_BROWSER_TICKET: "t".repeat(32) },
    });
    expect(await hook({ request })).toBe(request);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
  });

  it.each(["create", "resume", "refresh", "import"] as const)(
    "does it again, with a new ticket, when the session reopens (%s)",
    async (reason) => {
      const { open: hook } = captureHooks(ready({ labels: ["team"] }));
      const first = await hook({ request: open({ reason: "create" }) });
      const second = await hook({ request: open({ reason }) });
      const ticketOf = (r: SessionOpenRequest) =>
        (r.mcpServers["shared-browser"] as { env: Record<string, string> }).env
          .PASEO_SHARED_BROWSER_TICKET;
      expect(ticketOf(second)).toEqual(expect.any(String));
      expect(ticketOf(second)).not.toBe(ticketOf(first));
      expect(browserMocks.bindAgentTicket).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["a different value", { team: "red" }, ["team=blue"]],
    ["a different key", { squad: "blue" }, ["team"]],
    ["no labels", {}, ["team"]],
    ["a key only inherited from Object", { other: "x" }, ["toString"]],
  ])("leaves an agent with %s alone", async (_name, labels, entries) => {
    const { open: hook } = captureHooks(ready({ labels: entries }));
    const input = open({ labels });
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
    expect(browserMocks.bindAgentTicket).not.toHaveBeenCalled();
  });

  it("does not read the setting for an agent with no labels", async () => {
    const read = vi.fn(ready({ labels: ["team"] }));
    const { open: hook } = captureHooks(read);
    const input = open({ labels: {} });
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["a helper agent", { background: true }],
    ["a history session", { purpose: "history" as const }],
    ["a session without a workspace", { workspaceId: null }],
  ])("leaves %s alone even with a matching label", async (_name, over) => {
    const { open: hook } = captureHooks(ready({ labels: ["team"] }));
    const input = open(over);
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
  });

  it.each([
    [
      "all mode",
      async () => ({
        status: "ready",
        values: { mode: "all", providers: [], workspaces: [], projects: [], labels: ["team"] },
      }),
    ],
    ["an invalid setting", async () => ({ status: "invalid", revision: "1", error: "bad" })],
    ["an unreadable setting", async () => Promise.reject(new Error("down"))],
  ])(
    "does nothing in %s (every new agent already has the tool, or the default applies)",
    async (_name, read) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { open: hook } = captureHooks(read as () => Promise<unknown>);
        const input = open();
        await expect(hook({ request: input })).resolves.toBe(input);
        expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("does nothing on a Paseo release whose session-open request has no labels, background flag or MCP servers", async () => {
    const { open: hook } = captureHooks(ready({ labels: ["team"] }));
    const { labels: _labels, background: _background, mcpServers: _mcpServers, ...older } = open();
    const input = older as unknown as SessionOpenRequest;
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
  });

  it("does not add a second ticket to an agent the create hook already gave one", async () => {
    const { open: hook } = captureHooks(ready({ labels: ["team"], providers: ["codex"] }));
    const input = open({ env: { PASEO_SHARED_BROWSER_TICKET: "t".repeat(32) } });
    const result = await hook({ request: input });
    expect(browserMocks.bindAgentTicket).toHaveBeenCalledTimes(1);
    expect(browserMocks.bindAgentTicket).toHaveBeenCalledWith("t".repeat(32), "agent-1", "ws_a");
    expect(result.mcpServers).not.toHaveProperty("shared-browser");
    expect(result.env).not.toHaveProperty("PASEO_SHARED_BROWSER_TICKET");
  });

  it("leaves a resumed agent that carries a create-hook ticket in its env untouched", async () => {
    const { open: hook } = captureHooks(ready({ labels: ["team"] }));
    const input = open({ reason: "resume", env: { PASEO_SHARED_BROWSER_TICKET: "t".repeat(32) } });
    await expect(hook({ request: input })).resolves.toBe(input);
    expect(browserMocks.bindAgentTicket).not.toHaveBeenCalled();
  });

  it("opens the session without the tool, and does not throw, when the ticket cannot be issued or bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { open: hook } = captureHooks(ready({ labels: ["team"] }));
      browserMocks.issueAgentTicket.mockRejectedValueOnce(new Error("supervisor down"));
      const first = open();
      await expect(hook({ request: first })).resolves.toBe(first);
      expect(browserMocks.bindAgentTicket).not.toHaveBeenCalled();
      browserMocks.bindAgentTicket.mockRejectedValueOnce(new Error("Unknown agent ticket"));
      const second = open();
      await expect(hook({ request: second })).resolves.toBe(second);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not issue/);
      expect(String(warn.mock.calls[1]?.[0])).toMatch(/could not bind/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runtime installation compatibility", () => {
  it("requires at least the Node major required by agent-browser", async () => {
    const pluginPackage = JSON.parse(
      await readFile(resolve(testDirectory, "..", "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const agentBrowserPackage = JSON.parse(
      await readFile(
        resolve(testDirectory, "..", "node_modules", "agent-browser", "package.json"),
        "utf8",
      ),
    ) as { engines?: { node?: string } };
    const pluginMajor = Number(pluginPackage.engines?.node?.match(/^>=(\d+)/)?.[1]);
    const agentBrowserMajor = Number(agentBrowserPackage.engines?.node?.match(/^>=(\d+)/)?.[1]);

    expect(Number.isInteger(pluginMajor)).toBe(true);
    expect(Number.isInteger(agentBrowserMajor)).toBe(true);
    expect(pluginMajor).toBeGreaterThanOrEqual(agentBrowserMajor);
  });

  it("packages every runtime preparation module", async () => {
    const pluginPackage = JSON.parse(
      await readFile(resolve(testDirectory, "..", "package.json"), "utf8"),
    ) as { files?: string[] };

    expect(pluginPackage.files).toContain("scripts/replace-runtime.mjs");
  });
});
