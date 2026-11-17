import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

function captureAgentCreateHook(readAccess?: () => Promise<unknown>): AgentCreateHook {
  let hook: AgentCreateHook | undefined;
  contribute({
    registerSettings: vi.fn((definition: { id: string }) =>
      definition.id === "agent-access" && readAccess ? { read: readAccess } : undefined,
    ),
    handle: vi.fn(),
    before: vi.fn((name: string, handler: unknown) => {
      if (name === "agent.create") hook = handler as AgentCreateHook;
      return () => {};
    }),
    on: vi.fn(),
  } as never);
  if (!hook) throw new Error("agent.create hook was not registered");
  return hook;
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
    values: { mode: "listed", providers: [], workspaces: [], projects: [], ...values },
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

    it.each([
      ["the settings read", () => new Promise<never>(() => {}), undefined],
      [
        "the workspace lookup",
        ready({ workspaces: ["ws_a"] }),
        { paseo: { workspaces: { list: () => new Promise<never>(() => {}) } } },
      ],
    ])(
      "a stalled %s counts as no match and does not block creation",
      async (_name, read, context) => {
        vi.useFakeTimers();
        const hook = captureAgentCreateHook(read as () => Promise<unknown>);
        const input = request("claude");
        const pending = hook({ request: input }, context);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toBe(input);
        expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
      },
    );

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
      values: { mode: "all", providers: [], workspaces: [], projects: [] },
    }));
    const transformed = await hook({ request: request("anything") });
    expect(transformed.config.mcpServers).toHaveProperty("shared-browser");
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
