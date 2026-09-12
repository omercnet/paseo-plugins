import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  browserFrameSchema,
  browserInputEventSchema,
  browserStateSchema,
  didBrowserRuntimeRestart,
  isBrowserStateCurrent,
  mapDisplayedPoint,
  viewportSchema,
  type BrowserState,
} from "../shared/browser";
import contribute from "../index.server";

const browserMocks = vi.hoisted(() => ({
  bindAgentTicket: vi.fn(),
  cleanupBrowserServer: vi.fn(),
  handleAcquireControl: vi.fn(),
  handleApplyDevicePreset: vi.fn(),
  handleAttachBrowser: vi.fn(),
  handleCaptureBrowser: vi.fn(),
  handleDetachBrowser: vi.fn(),
  handleListOpenBrowserWorkspaces: vi.fn(),
  handleNavigateBrowser: vi.fn(),
  handleReleaseControl: vi.fn(),
  handleResizeBrowser: vi.fn(),
  handleSendBrowserInput: vi.fn(),
  handleWorkspaceArchived: vi.fn(),
  issueAgentTicket: vi.fn().mockResolvedValue(undefined),
  revokeAgentBrowserAccess: vi.fn(),
}));

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

type AgentCreateHook = (input: { request: AgentCreateRequest }) => Promise<AgentCreateRequest>;

function captureAgentCreateHook(): AgentCreateHook {
  let hook: AgentCreateHook | undefined;
  contribute({
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
    expect(viewportSchema.safeParse({ width: 2560, height: 1440 }).success).toBe(false);
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
  it.each(["omp", "pi"])(
    "leaves %s agent creation untouched when external MCP support is unavailable",
    async (provider) => {
      const hook = captureAgentCreateHook();
      const request: AgentCreateRequest = {
        config: { provider, cwd: "/workspace" },
        env: { EXISTING: "value" },
      };

      await expect(hook({ request })).resolves.toBe(request);
      expect(browserMocks.issueAgentTicket).not.toHaveBeenCalled();
    },
  );

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
      "shared-browser": { type: "stdio" },
    });
  });
});

describe("runtime installation compatibility", () => {
  it("requires at least the Node major required by agent-browser", async () => {
    const pluginPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const agentBrowserPackage = JSON.parse(
      await readFile(
        new URL("../node_modules/agent-browser/package.json", import.meta.url),
        "utf8",
      ),
    ) as { engines?: { node?: string } };
    const pluginMajor = Number(pluginPackage.engines?.node?.match(/^>=(\d+)/)?.[1]);
    const agentBrowserMajor = Number(agentBrowserPackage.engines?.node?.match(/^>=(\d+)/)?.[1]);

    expect(Number.isInteger(pluginMajor)).toBe(true);
    expect(Number.isInteger(agentBrowserMajor)).toBe(true);
    expect(pluginMajor).toBeGreaterThanOrEqual(agentBrowserMajor);
  });
});
