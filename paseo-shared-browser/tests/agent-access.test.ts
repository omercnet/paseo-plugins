import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CdpUnknownOutcomeError } from "../server/cdp";
import type { BrowserState } from "../shared/browser";
import {
  RuntimeSupervisor,
  startSupervisorServer,
  type RuntimeInstance,
  type RuntimeOwner,
  type SupervisorPaths,
} from "../server/supervisor";
import {
  RUNTIME_PROTOCOL_VERSION,
  type AgentBrowserOperation,
  type BridgeLease,
  type JsonValue,
} from "../server/runtime-protocol";
import { AgentSupervisorClient, SupervisorClient } from "../server/supervisor-client";

interface AgentRuntime extends RuntimeInstance {
  workspaceId: string;
}

interface RuntimeState {
  url: string;
  viewport: { width: number; height: number };
}

class AgentRuntimeOwner implements RuntimeOwner<AgentRuntime> {
  readonly states = new Map<string, RuntimeState>();
  readonly stopped: AgentRuntime[] = [];
  failNextMutationUnknown = false;

  async create(workspaceId: string): Promise<AgentRuntime> {
    this.states.set(workspaceId, {
      url: `https://${workspaceId}.example/`,
      viewport: { width: 1280, height: 800 },
    });
    return { workspaceId, runtimeId: `runtime_${workspaceId}_${"r".repeat(32)}` };
  }

  async request(runtime: AgentRuntime, operation: string, input: JsonValue): Promise<JsonValue> {
    const state = this.states.get(runtime.workspaceId);
    if (!state) throw new Error(`Runtime is stopped: ${runtime.workspaceId}`);
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (this.failNextMutationUnknown && operation === "navigate") {
      this.failNextMutationUnknown = false;
      throw new CdpUnknownOutcomeError("mutation timed out");
    }
    switch (operation) {
      case "identity":
        return { userAgent: "Fake Chromium" };
      case "state":
        return {
          url: state.url,
          title: runtime.workspaceId,
          canGoBack: false,
          canGoForward: false,
        };
      case "navigate":
        state.url = String(data.url);
        return null;
      case "emulate":
        state.viewport = { width: Number(data.width), height: Number(data.height) };
        return null;
      case "frame": {
        const bytes = Buffer.from(`frame:${runtime.workspaceId}`);
        return {
          transport: "cdp-screencast",
          dataBase64: bytes.toString("base64"),
          byteLength: bytes.byteLength,
          width: state.viewport.width,
          height: state.viewport.height,
          capturedAt: "2026-09-12T00:00:00.000Z",
        };
      }
      case "reload":
      case "screencast.start":
      case "screencast.stop":
      case "mouse.move":
      case "mouse.down":
      case "mouse.up":
      case "mouse.wheel":
      case "text.insert":
      case "key.down":
      case "key.up":
        return null;
      default:
        throw new Error(`Unexpected runtime operation: ${operation}`);
    }
  }

  async stop(runtime: AgentRuntime): Promise<void> {
    this.stopped.push(runtime);
    this.states.delete(runtime.workspaceId);
  }
}

const supervisors: RuntimeSupervisor<AgentRuntime>[] = [];
let requestId = 0;

function createHarness(now: () => number = Date.now) {
  const owner = new AgentRuntimeOwner();
  const supervisor = new RuntimeSupervisor({ owner, now });
  supervisors.push(supervisor);
  return { owner, supervisor, bridge: supervisor.claimBridge("plugin-bridge") };
}

function pathsFor(root: string): SupervisorPaths {
  return {
    root,
    socket: join(root, "runtime.sock"),
    token: join(root, "runtime.token"),
    endpoint: join(root, "runtime.json"),
    lock: join(root, "startup.lock"),
  };
}

async function browserRequest<Result>(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  operation: string,
  input: JsonValue,
): Promise<Result> {
  return (await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "browser.request",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    operation,
    input,
  })) as unknown as Result;
}

async function issueTicket(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  ticket: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "ticket.issue",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
  });
}

async function bindTicket(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  ticket: string,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "ticket.bind",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
    agentId,
    workspaceId,
  });
}

async function revokeAgent(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  agentId: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "agent.revoke",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    agentId,
  });
}

async function agentRequest<Result>(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  ticket: string,
  operation: AgentBrowserOperation,
  input: JsonValue = {},
): Promise<Result> {
  return (await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    method: "agent.request",
    ticket,
    operation,
    input,
  })) as unknown as Result;
}

function ticket(label: string): string {
  return `${label}_${"x".repeat(40)}`;
}

function stateOf(result: { state: BrowserState }): BrowserState {
  return result.state;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
});

describe("agent shared-browser authorization", () => {
  it("uses an opaque agent ticket without claiming or fencing the admin bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-browser-agent-client-"));
    const paths = pathsFor(root);
    const owner = new AgentRuntimeOwner();
    const server = await startSupervisorServer(owner, paths);
    const admin = new SupervisorClient({ bridgeId: "plugin-bridge", paths });
    const agentTicket = ticket("opaque");
    const agent = new AgentSupervisorClient({ ticket: agentTicket, paths });
    try {
      await admin.connect();
      await admin.issueAgentTicket(agentTicket);
      await admin.bindAgentTicket(agentTicket, "agent-one", "workspace-one");
      await agent.open();

      const observed = await agent.request("status", {});
      expect(stateOf(observed as unknown as { state: BrowserState })).toMatchObject({
        workspaceId: "workspace-one",
        bridgeEpoch: 1,
      });
      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });

      agent.disconnect();
      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });
      expect(owner.stopped).toEqual([]);
    } finally {
      agent.disconnect();
      admin.disconnect();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims the cached plugin bridge after its socket closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-browser-reconnect-"));
    const paths = pathsFor(root);
    const owner = new AgentRuntimeOwner();
    const server = await startSupervisorServer(owner, paths);
    const admin = new SupervisorClient({ bridgeId: "plugin-bridge", paths });
    try {
      await admin.connect();
      await admin.requestBrowser("attach", { workspaceId: "workspace-one", viewerLabel: "Human" });
      admin.disconnect();

      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });
    } finally {
      admin.disconnect();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a ticket bound to its assigned agent and workspace", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("bound");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");

    await expect(
      bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-two"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(
      bindTicket(supervisor, bridge, agentTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    await browserRequest(supervisor, bridge, "attach", {
      workspaceId: "workspace-two",
      viewerLabel: "Human",
    });
    const observed = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "status",
      {
        workspaceId: "workspace-two",
      },
    );
    expect(observed.state.workspaceId).toBe("workspace-one");

    await agentRequest(supervisor, agentTicket, "acquire-control");
    await agentRequest(supervisor, agentTicket, "navigate", {
      workspaceId: "workspace-two",
      action: { kind: "goto", url: "https://agent.example/" },
    });
    expect(owner.states.get("workspace-one")?.url).toBe("https://agent.example/");
    expect(owner.states.get("workspace-two")?.url).toBe("https://workspace-two.example/");
  });

  it("fails closed for null, unknown, history-only, unbound, and revoked credentials", async () => {
    const { supervisor, bridge } = createHarness();
    const historyOnlyTicket = ticket("history");
    const revokedTicket = ticket("revoked");
    await issueTicket(supervisor, bridge, historyOnlyTicket);
    await issueTicket(supervisor, bridge, revokedTicket);

    await expect(
      agentRequest(supervisor, null as unknown as string, "status"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(agentRequest(supervisor, ticket("unknown"), "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(agentRequest(supervisor, historyOnlyTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });

    await bindTicket(supervisor, bridge, revokedTicket, "agent-revoked", "workspace-one");
    await expect(agentRequest(supervisor, revokedTicket, "status")).resolves.toBeDefined();
    await revokeAgent(supervisor, bridge, "agent-revoked");
    await expect(agentRequest(supervisor, revokedTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("expires unbound tickets while retaining bound credentials", async () => {
    let now = 1_000;
    const owner = new AgentRuntimeOwner();
    const supervisor = new RuntimeSupervisor({ owner, now: () => now });
    supervisors.push(supervisor);
    const bridge = supervisor.claimBridge("plugin-bridge");
    const expiredTicket = ticket("expired");
    const boundTicket = ticket("bound-retained");
    await issueTicket(supervisor, bridge, expiredTicket);
    await issueTicket(supervisor, bridge, boundTicket);
    await bindTicket(supervisor, bridge, boundTicket, "agent-one", "workspace-one");
    while (now < 581_000) {
      now += 29_000;
      supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    }
    now = 601_000;

    await expect(
      bindTicket(supervisor, bridge, expiredTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(agentRequest(supervisor, boundTicket, "status")).resolves.toBeDefined();
  });

  it("fails closed for status and capture while the plugin bridge is unavailable", async () => {
    const { supervisor, bridge } = createHarness();
    const agentTicket = ticket("bridge-unavailable");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    supervisor.bridgeDisconnected(bridge.bridgeId, bridge.epoch);

    await expect(agentRequest(supervisor, agentTicket, "status")).rejects.toMatchObject({
      code: "BRIDGE_FENCED",
    });
    await expect(agentRequest(supervisor, agentTicket, "capture")).rejects.toMatchObject({
      code: "BRIDGE_FENCED",
    });
  });

  it("returns UNKNOWN_OUTCOME and invalidates an agent mutation observation", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("unknown-outcome");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    owner.failNextMutationUnknown = true;

    await expect(
      agentRequest(supervisor, agentTicket, "navigate", {
        action: { kind: "goto", url: "https://unknown-outcome.example/" },
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    await expect(
      agentRequest(supervisor, agentTicket, "navigate", {
        action: { kind: "goto", url: "https://unknown-outcome.example/" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("denies agent takeover and revokes agent mutation authority after human takeover", async () => {
    const { supervisor, bridge } = createHarness();
    const agentTicket = ticket("control");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    const human = await browserRequest<{ viewerToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "attach",
      { workspaceId: "workspace-one", viewerLabel: "Human" },
    );
    const humanControl = await browserRequest<{ controlToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "acquire-control",
      { viewerToken: human.viewerToken, takeover: false },
    );

    await expect(
      agentRequest(supervisor, agentTicket, "acquire-control", { takeover: true }),
    ).rejects.toThrow("held by another viewer");

    await browserRequest(supervisor, bridge, "release-control", {
      viewerToken: human.viewerToken,
      controlToken: humanControl.controlToken,
    });
    await agentRequest(supervisor, agentTicket, "acquire-control");
    await browserRequest(supervisor, bridge, "acquire-control", {
      viewerToken: human.viewerToken,
      takeover: true,
    });

    await expect(
      agentRequest(supervisor, agentTicket, "navigate", { action: { kind: "reload" } }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("does not extend agent control through observation or capture", async () => {
    let now = 1_000;
    const { supervisor, bridge } = createHarness(() => now);
    const agentTicket = ticket("expiry");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");
    const acquired = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "acquire-control",
    );
    expect(acquired.state.controller).toBe("self");

    now = 30_000;
    expect(
      stateOf(await agentRequest(supervisor, agentTicket, "capture", { quality: "medium" }))
        .controller,
    ).toBe("self");
    supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    now = 31_001;
    expect(stateOf(await agentRequest(supervisor, agentTicket, "status")).controller).toBe("none");
    await expect(
      agentRequest(supervisor, agentTicket, "navigate", { action: { kind: "reload" } }),
    ).rejects.toThrow("lease is invalid or expired");
  });

  it("archives the runtime and permanently fences every ticket bound to its workspace", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("archive");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");

    await browserRequest(supervisor, bridge, "archive", { workspaceId: "workspace-one" });

    expect(owner.stopped.map(({ workspaceId }) => workspaceId)).toEqual(["workspace-one"]);
    await expect(agentRequest(supervisor, agentTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(
      supervisor.ensureWorkspace(bridge.bridgeId, bridge.epoch, "workspace-one"),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    const lateTicket = ticket("late");
    await issueTicket(supervisor, bridge, lateTicket);
    await expect(
      bindTicket(supervisor, bridge, lateTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
  });
});
