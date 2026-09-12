import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserFrame, BrowserInputEvent, BrowserState, Viewport } from "../shared/browser";
import { SessionManager } from "./browser-policy";
import { CdpUnknownOutcomeError } from "./cdp";
import {
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_ORPHAN_GRACE_MS,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeProtocolError,
  parseRuntimeRequest,
  type BridgeLease,
  type JsonValue,
  type RuntimeDescriptor,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeResult,
} from "./runtime-protocol";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SOCKET_MODE = 0o600;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SUPERVISOR_WORKSPACES = 8;
const MAX_SOCKET_IN_FLIGHT = 16;
const MAX_GLOBAL_IN_FLIGHT = 64;
const AGENT_TICKET_TTL_MS = 10 * 60_000;
const MAX_UNBOUND_AGENT_TICKETS = 256;
type SupervisorTimer = NodeJS.Timeout;

export interface RuntimeInstance {
  runtimeId: string;
}

export interface RuntimeOwner<Runtime extends RuntimeInstance = RuntimeInstance> {
  create(workspaceId: string): Promise<Runtime>;
  request(runtime: Runtime, operation: string, input: JsonValue): Promise<JsonValue>;
  stop(runtime: Runtime): Promise<void>;
}

export interface RuntimeSupervisorOptions<Runtime extends RuntimeInstance> {
  owner: RuntimeOwner<Runtime>;
  now?: () => number;
  orphanGraceMs?: number;
  heartbeatIntervalMs?: number;
  bridgeTimeoutMs?: number;
  maxWorkspaces?: number;
  schedule?: (callback: () => void, delayMs: number) => SupervisorTimer;
  cancel?: (timer: SupervisorTimer) => void;
}

interface WorkspaceEntry<Runtime extends RuntimeInstance> {
  createdAt: number;
  runtime: Runtime;
}

interface ActiveBridge {
  bridgeId: string;
  epoch: number;
  expiresAt: number;
  ready: Promise<void>;
}

interface AgentBinding {
  issuedAt: number;
  ticket: string;
  agentId: string | null;
  workspaceId: string | null;
  viewerToken: string | null;
  controlToken: string | null;
  lastState: BrowserState | null;
  lastFrame: BrowserFrame | null;
}

export class RuntimeSupervisor<Runtime extends RuntimeInstance = RuntimeInstance> {
  private readonly owner: RuntimeOwner<Runtime>;
  private readonly now: () => number;
  private readonly orphanGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly bridgeTimeoutMs: number;
  private readonly maxWorkspaces: number;
  private readonly schedule: (callback: () => void, delayMs: number) => SupervisorTimer;
  private readonly cancel: (timer: SupervisorTimer) => void;
  private readonly workspaces = new Map<string, WorkspaceEntry<Runtime>>();
  private readonly creations = new Map<string, Promise<WorkspaceEntry<Runtime>>>();
  private readonly workspaceOperations = new Map<string, Promise<void>>();
  private readonly archived = new Set<string>();
  private readonly browserPolicy: SessionManager;
  private readonly agentBindings = new Map<string, AgentBinding>();
  private readonly agentTickets = new Map<string, Set<string>>();
  private activeBridge: ActiveBridge | null = null;
  private nextEpoch = 0;
  private bridgeTimer: SupervisorTimer | null = null;
  private orphanTimer: SupervisorTimer | null = null;
  private stopping: Promise<void> | null = null;

  constructor(options: RuntimeSupervisorOptions<Runtime>) {
    this.owner = options.owner;
    this.now = options.now ?? Date.now;
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_MS;
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    this.maxWorkspaces = options.maxWorkspaces ?? MAX_SUPERVISOR_WORKSPACES;
    if (!Number.isInteger(this.maxWorkspaces) || this.maxWorkspaces < 1)
      throw new Error("maxWorkspaces must be a positive integer");
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.browserPolicy = new SessionManager({
      validateWorkspace: async (workspaceId) => !this.archived.has(workspaceId),
      client: {
        connect: async () => ({ epoch: this.nextEpoch }),
        ensureWorkspace: (workspaceId) => this.ensureWorkspaceLocal(workspaceId),
        requestWorkspace: (workspaceId, operation, input) =>
          this.requestWorkspaceLocal(workspaceId, operation, input),
        archiveWorkspace: (workspaceId) => this.archiveWorkspaceLocal(workspaceId).then(() => {}),
        disconnect: () => {},
      },
      now: this.now,
      maxSessions: this.maxWorkspaces,
    });
  }

  claimBridge(bridgeId: string, takeover = false): BridgeLease {
    const active = this.activeBridge;
    if (active && active.expiresAt > this.now() && active.bridgeId !== bridgeId && !takeover)
      throw new RuntimeProtocolError(
        "BRIDGE_FENCED",
        "A Shared Browser plugin bridge is already active; explicit administrative takeover is required",
      );
    this.nextEpoch += 1;
    const pending = [...this.workspaceOperations.values()];
    this.browserPolicy.setBridgeEpoch(this.nextEpoch);
    const bridge: ActiveBridge = {
      bridgeId,
      epoch: this.nextEpoch,
      expiresAt: this.now() + this.bridgeTimeoutMs,
      ready: Promise.allSettled(pending).then(() => undefined),
    };
    this.activeBridge = bridge;
    this.cancelOrphanStop();
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  heartbeat(bridgeId: string, epoch: number): BridgeLease {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    bridge.expiresAt = this.now() + this.bridgeTimeoutMs;
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  bridgeDisconnected(bridgeId: string, epoch: number): void {
    if (this.activeBridge?.bridgeId !== bridgeId || this.activeBridge.epoch !== epoch) return;
    this.activeBridge = null;
    this.clearBridgeTimer();
    this.armOrphanStop();
  }

  async ensureWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<RuntimeDescriptor> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const descriptor = await this.ensureWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return descriptor;
  }

  async requestWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const result = await this.requestWorkspaceLocal(workspaceId, operation, input);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  async archiveWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<{ archived: true }> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    this.archived.add(workspaceId);
    await bridge.ready;
    const result = await this.archiveWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  private ensureWorkspaceLocal(workspaceId: string): Promise<RuntimeDescriptor> {
    return this.runWorkspaceOperation(workspaceId, async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      let entry = this.workspaces.get(workspaceId);
      if (!entry) {
        let creation = this.creations.get(workspaceId);
        if (!creation) {
          if (this.workspaces.size + this.creations.size >= this.maxWorkspaces) {
            throw new RuntimeProtocolError(
              "RUNTIME_FAILURE",
              `Runtime supervisor workspace limit (${this.maxWorkspaces}) reached`,
            );
          }
          creation = this.createWorkspace(workspaceId);
          this.creations.set(workspaceId, creation);
        }
        entry = await creation;
      }
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      return { workspaceId, runtimeId: entry.runtime.runtimeId, createdAt: entry.createdAt };
    });
  }

  private requestWorkspaceLocal(
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    return this.runWorkspaceOperation(workspaceId, async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      const entry = this.workspaces.get(workspaceId);
      if (!entry)
        throw new RuntimeProtocolError(
          "WORKSPACE_NOT_FOUND",
          `Workspace runtime not found: ${workspaceId}`,
        );
      try {
        const result = await this.owner.request(entry.runtime, operation, input);
        if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
        return result;
      } catch (error) {
        if (error instanceof RuntimeProtocolError) throw error;
        if (error instanceof CdpUnknownOutcomeError)
          throw new RuntimeProtocolError(
            "UNKNOWN_OUTCOME",
            "Browser mutation outcome is unknown; observe the browser before sending another mutation",
          );
        throw new RuntimeProtocolError(
          "RUNTIME_FAILURE",
          `Workspace runtime ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  private archiveWorkspaceLocal(workspaceId: string): Promise<{ archived: true }> {
    this.archived.add(workspaceId);
    return this.runWorkspaceOperation(workspaceId, async () => {
      const creation = this.creations.get(workspaceId);
      if (creation) await creation.catch(() => undefined);
      const entry = this.workspaces.get(workspaceId);
      if (entry) {
        this.workspaces.delete(workspaceId);
        await this.owner.stop(entry.runtime);
      }
      return { archived: true };
    });
  }

  private async requestBrowser(
    bridgeId: string,
    epoch: number,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const data = asObject(input);
    let result: unknown;
    switch (operation) {
      case "attach":
        result = await this.browserPolicy.attach(
          requireText(data, "workspaceId"),
          requireText(data, "viewerLabel"),
        );
        break;
      case "detach":
        result = await this.browserPolicy.detach(requireText(data, "viewerToken"));
        break;
      case "status":
        result = await this.browserPolicy.status(requireText(data, "viewerToken"));
        break;
      case "capture":
        result = await this.browserPolicy.capture(
          requireText(data, "viewerToken"),
          data.quality === "low" || data.quality === "high" ? data.quality : "medium",
          typeof data.knownFrameId === "string" ? data.knownFrameId : null,
        );
        break;
      case "acquire-control": {
        result = await this.browserPolicy.acquireControl(
          requireText(data, "viewerToken"),
          data.takeover === true,
        );
        const state = stateFromPolicyResult(result);
        if (data.takeover === true) this.revokeAgentControl(state.workspaceId);
        break;
      }
      case "release-control":
        result = await this.browserPolicy.releaseControl(
          requireText(data, "viewerToken"),
          requireText(data, "controlToken"),
        );
        break;
      case "navigate":
        result = await this.browserPolicy.navigate(data as never);
        this.invalidateAgentObservations(stateFromPolicyResult(result).workspaceId);
        break;
      case "viewport":
        result = await this.browserPolicy.resize(data as never);
        this.invalidateAgentObservations(stateFromPolicyResult(result).workspaceId);
        break;
      case "device":
        result = await this.browserPolicy.applyDevicePreset(data as never);
        this.invalidateAgentObservations(stateFromPolicyResult(result).workspaceId);
        break;
      case "input":
        result = await this.browserPolicy.sendInput(data as never);
        this.invalidateAgentObservations(stateFromPolicyResult(result).workspaceId);
        break;
      case "list":
        result = { workspaceIds: await this.browserPolicy.listOpenWorkspaceIds() };
        break;
      case "archive": {
        const workspaceId = requireText(data, "workspaceId");
        await this.revokeWorkspace(workspaceId);
        await this.browserPolicy.archiveWorkspace(workspaceId);
        result = { archived: true };
        break;
      }
      default:
        throw new RuntimeProtocolError(
          "INVALID_REQUEST",
          `Unknown browser operation: ${operation}`,
        );
    }
    this.assertActiveBridge(bridgeId, epoch);
    return result as JsonValue;
  }

  private issueAgentTicket(bridgeId: string, epoch: number, ticket: string): JsonValue {
    this.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    assertOpaqueToken(ticket, "ticket");
    if (this.agentBindings.has(ticket))
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent ticket is already registered");
    if (
      [...this.agentBindings.values()].filter((binding) => binding.agentId === null).length >=
      MAX_UNBOUND_AGENT_TICKETS
    )
      throw new RuntimeProtocolError(
        "RUNTIME_BUSY",
        "Shared Browser ticket capacity is temporarily full",
      );
    this.agentBindings.set(ticket, {
      ticket,
      issuedAt: this.now(),
      agentId: null,
      workspaceId: null,
      viewerToken: null,
      controlToken: null,
      lastState: null,
      lastFrame: null,
    });
    return { issued: true };
  }

  private bindAgentTicket(
    bridgeId: string,
    epoch: number,
    ticket: string,
    agentId: string,
    workspaceId: string,
  ): JsonValue {
    this.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    const binding = this.agentBindings.get(ticket);
    if (!binding) throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Unknown agent ticket");
    if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
    if (binding.agentId && (binding.agentId !== agentId || binding.workspaceId !== workspaceId))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is already bound");
    binding.agentId = agentId;
    binding.workspaceId = workspaceId;
    let tickets = this.agentTickets.get(agentId);
    if (!tickets) {
      tickets = new Set();
      this.agentTickets.set(agentId, tickets);
    }
    tickets.add(ticket);
    return { bound: true };
  }

  private async revokeAgent(bridgeId: string, epoch: number, agentId: string): Promise<JsonValue> {
    this.assertActiveBridge(bridgeId, epoch);
    const tickets = this.agentTickets.get(agentId);
    if (!tickets) return { revoked: 0 };
    let revoked = 0;
    for (const ticket of tickets) {
      const binding = this.agentBindings.get(ticket);
      if (!binding) continue;
      this.agentBindings.delete(ticket);
      revoked += 1;
      if (binding.viewerToken)
        await this.browserPolicy.detach(binding.viewerToken).catch(() => undefined);
    }
    this.agentTickets.delete(agentId);
    return { revoked };
  }

  private async requestAgent(
    ticket: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    this.assertPluginAvailable();
    const binding = this.requireAgentBinding(ticket);
    const data = asObject(input);
    if (operation === "status" || operation === "capture")
      return (await this.requestAgentObservation(binding, operation, data)) as unknown as JsonValue;
    try {
      if (operation === "acquire-control") {
        await this.requestAgentObservation(binding, "status", {});
        const viewerToken = binding.viewerToken!;
        const result = await this.browserPolicy.acquireControl(viewerToken, false);
        binding.controlToken = result.controlToken;
        binding.lastState = result.state;
        return { state: result.state } as unknown as JsonValue;
      }
      const viewerToken = binding.viewerToken;
      const controlToken = binding.controlToken;
      if (!viewerToken || !controlToken)
        throw new RuntimeProtocolError(
          "AUTHENTICATION_FAILED",
          "Agent does not hold browser control",
        );
      if (operation === "release-control") {
        try {
          const result = await this.browserPolicy.releaseControl(viewerToken, controlToken);
          binding.lastState = result.state;
          return result as unknown as JsonValue;
        } finally {
          binding.controlToken = null;
        }
      }
      const expected = expectedState(binding);
      let result: { state: BrowserState };
      if (operation === "navigate") {
        result = await this.browserPolicy.navigate({
          viewerToken,
          controlToken,
          expected,
          action: data.action as never,
        });
      } else if (operation === "viewport") {
        result = await this.browserPolicy.resize({
          viewerToken,
          controlToken,
          expected,
          viewport: data.viewport as Viewport,
        });
      } else if (operation === "input") {
        if (!binding.lastFrame)
          throw new RuntimeProtocolError("INVALID_REQUEST", "Capture a frame before sending input");
        result = await this.browserPolicy.sendInput({
          viewerToken,
          controlToken,
          expected,
          target: binding.lastFrame,
          event: data.event as BrowserInputEvent,
        });
      } else {
        throw new RuntimeProtocolError("INVALID_REQUEST", `Unknown agent operation: ${operation}`);
      }
      binding.lastState = result.state;
      binding.lastFrame = null;
      return result as unknown as JsonValue;
    } catch (error) {
      if (error instanceof RuntimeProtocolError && error.code === "UNKNOWN_OUTCOME")
        this.invalidateAgentObservations(binding.workspaceId!);
      throw error;
    }
  }

  private async requestAgentObservation(
    binding: AgentBinding,
    operation: "status" | "capture",
    input: Record<string, JsonValue>,
  ): Promise<{ state: BrowserState; frame?: BrowserFrame | null }> {
    const run = async (viewerToken: string) =>
      operation === "status"
        ? await this.browserPolicy.status(viewerToken)
        : await this.browserPolicy.capture(
            viewerToken,
            input.quality === "low" || input.quality === "high" ? input.quality : "medium",
            null,
          );
    let result: { state: BrowserState; frame?: BrowserFrame | null };
    try {
      result = await run(await this.ensureAgentViewer(binding));
    } catch (error) {
      if (!isInvalidViewer(error)) throw error;
      binding.viewerToken = null;
      binding.controlToken = null;
      result = await run(await this.ensureAgentViewer(binding));
    }
    binding.lastState = result.state;
    if (operation === "capture") binding.lastFrame = result.frame ?? null;
    return result;
  }

  private async ensureAgentViewer(binding: AgentBinding): Promise<string> {
    if (binding.viewerToken) return binding.viewerToken;
    this.assertPluginAvailable();
    const attached = await this.browserPolicy.attach(
      binding.workspaceId!,
      `Agent ${binding.agentId!.slice(0, 48)}`,
    );
    binding.viewerToken = attached.viewerToken;
    binding.lastState = attached.state;
    return attached.viewerToken;
  }

  private requireAgentBinding(ticket: string): AgentBinding {
    const binding = this.agentBindings.get(ticket);
    if (!binding?.agentId || !binding.workspaceId)
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is invalid or unbound");
    if (this.archived.has(binding.workspaceId)) this.workspaceArchived(binding.workspaceId);
    return binding;
  }

  private assertPluginAvailable(): void {
    if (!this.activeBridge || this.activeBridge.expiresAt <= this.now())
      throw new RuntimeProtocolError("BRIDGE_FENCED", "Shared Browser plugin is unavailable");
  }

  private revokeAgentControl(workspaceId: string): void {
    for (const binding of this.agentBindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      binding.controlToken = null;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  private invalidateAgentObservations(workspaceId: string): void {
    for (const binding of this.agentBindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  private async revokeWorkspace(workspaceId: string): Promise<void> {
    const viewers: string[] = [];
    for (const [ticket, binding] of this.agentBindings) {
      if (binding.workspaceId !== workspaceId) continue;
      this.agentBindings.delete(ticket);
      if (binding.viewerToken) viewers.push(binding.viewerToken);
      if (binding.agentId) {
        const tickets = this.agentTickets.get(binding.agentId);
        tickets?.delete(ticket);
        if (tickets?.size === 0) this.agentTickets.delete(binding.agentId);
      }
    }
    await Promise.allSettled(viewers.map((viewerToken) => this.browserPolicy.detach(viewerToken)));
  }

  async stopAll(): Promise<void> {
    if (this.stopping) return this.stopping;
    const operation = (async () => {
      this.activeBridge = null;
      this.clearBridgeTimer();
      this.cancelOrphanStop();
      this.browserPolicy.reset();
      for (const binding of this.agentBindings.values()) {
        binding.viewerToken = null;
        binding.controlToken = null;
        binding.lastState = null;
        binding.lastFrame = null;
      }
      await Promise.allSettled(this.workspaceOperations.values());
      await Promise.allSettled(this.creations.values());
      const entries = [...this.workspaces.values()];
      this.workspaces.clear();
      const results = await Promise.allSettled(
        entries.map((entry) => this.owner.stop(entry.runtime)),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "One or more workspace runtimes failed to stop",
        );
    })();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = null;
    }
  }

  async dispatch(request: RuntimeRequest): Promise<RuntimeResult> {
    switch (request.method) {
      case "bridge.claim":
        return this.claimBridge(request.bridgeId, request.takeover);
      case "bridge.heartbeat":
        return this.heartbeat(request.bridgeId, request.epoch);
      case "workspace.ensure":
        return this.ensureWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "workspace.request":
        return this.requestWorkspace(
          request.bridgeId,
          request.epoch,
          request.workspaceId,
          request.operation,
          request.input,
        );
      case "workspace.archive":
        return this.archiveWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "browser.request":
        return this.requestBrowser(
          request.bridgeId,
          request.epoch,
          request.operation,
          request.input,
        );
      case "ticket.issue":
        return this.issueAgentTicket(request.bridgeId, request.epoch, request.ticket);
      case "ticket.bind":
        return this.bindAgentTicket(
          request.bridgeId,
          request.epoch,
          request.ticket,
          request.agentId,
          request.workspaceId,
        );
      case "agent.revoke":
        return this.revokeAgent(request.bridgeId, request.epoch, request.agentId);
      case "agent.request":
        return this.requestAgent(request.ticket, request.operation, request.input);
    }
  }

  private runWorkspaceOperation<Result>(
    workspaceId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.workspaceOperations.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspaceId, tail);
    void tail.finally(() => {
      if (this.workspaceOperations.get(workspaceId) === tail)
        this.workspaceOperations.delete(workspaceId);
    });
    return result;
  }

  private async createWorkspace(workspaceId: string): Promise<WorkspaceEntry<Runtime>> {
    try {
      const runtime = await this.owner.create(workspaceId);
      const entry = { runtime, createdAt: this.now() };
      if (this.archived.has(workspaceId)) {
        await this.owner.stop(runtime);
        this.workspaceArchived(workspaceId);
      }
      this.workspaces.set(workspaceId, entry);
      return entry;
    } finally {
      this.creations.delete(workspaceId);
    }
  }

  private assertActiveBridge(bridgeId: string, epoch: number): ActiveBridge {
    const bridge = this.activeBridge;
    if (
      !bridge ||
      bridge.bridgeId !== bridgeId ||
      bridge.epoch !== epoch ||
      bridge.expiresAt <= this.now()
    ) {
      throw new RuntimeProtocolError("BRIDGE_FENCED", "Plugin bridge lease is no longer active");
    }
    return bridge;
  }

  private bridgeLease(bridge: ActiveBridge): BridgeLease {
    return {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      expiresAt: bridge.expiresAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    };
  }

  private workspaceArchived(workspaceId: string): never {
    throw new RuntimeProtocolError("WORKSPACE_ARCHIVED", `Workspace is archived: ${workspaceId}`);
  }

  private expireUnboundTickets(): void {
    const deadline = this.now() - AGENT_TICKET_TTL_MS;
    for (const [ticket, binding] of this.agentBindings)
      if (binding.agentId === null && binding.issuedAt <= deadline)
        this.agentBindings.delete(ticket);
  }

  private armBridgeTimeout(bridge: ActiveBridge): void {
    this.clearBridgeTimer();
    const delay = Math.max(0, bridge.expiresAt - this.now());
    this.bridgeTimer = this.schedule(() => {
      if (this.activeBridge !== bridge) return;
      if (bridge.expiresAt > this.now()) {
        this.armBridgeTimeout(bridge);
        return;
      }
      this.activeBridge = null;
      this.bridgeTimer = null;
      this.armOrphanStop();
    }, delay);
  }

  private clearBridgeTimer(): void {
    if (!this.bridgeTimer) return;
    this.cancel(this.bridgeTimer);
    this.bridgeTimer = null;
  }

  private armOrphanStop(): void {
    this.cancelOrphanStop();
    this.orphanTimer = this.schedule(() => {
      this.orphanTimer = null;
      if (!this.activeBridge) void this.stopAll().catch(() => undefined);
    }, this.orphanGraceMs);
  }

  private cancelOrphanStop(): void {
    if (!this.orphanTimer) return;
    this.cancel(this.orphanTimer);
    this.orphanTimer = null;
  }
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", "Browser input must be an object");
  return value;
}

function requireText(value: Record<string, JsonValue>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.length === 0)
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be a non-empty string`);
  return text;
}

function assertOpaqueToken(value: string, label: string): void {
  if (value.length < 32 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", `${label} is invalid`);
}

function expectedState(binding: AgentBinding): {
  sessionId: string;
  navigationGeneration: number;
  viewportGeneration: number;
  runtimeId: string;
  bridgeEpoch: number;
} {
  const state = binding.lastState;
  if (!state)
    throw new RuntimeProtocolError("INVALID_REQUEST", "Observe the browser before mutating it");
  if (!state.runtimeId || state.bridgeEpoch === undefined)
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser observation lacks runtime identity");
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
    runtimeId: state.runtimeId,
    bridgeEpoch: state.bridgeEpoch,
  };
}

function stateFromPolicyResult(result: unknown): BrowserState {
  if (!result || typeof result !== "object" || !("state" in result))
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser policy returned no state");
  return result.state as BrowserState;
}

function isInvalidViewer(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Viewer token is invalid or expired");
}

export interface SupervisorPaths {
  root: string;
  socket: string;
  token: string;
  endpoint: string;
  lock: string;
}

export function resolveSupervisorPaths(
  paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): SupervisorPaths {
  const root = join(
    paseoHome,
    "plugin-data",
    "shared-browser",
    `supervisor-v${RUNTIME_PROTOCOL_VERSION}`,
  );
  return {
    root,
    socket: join(root, "runtime.sock"),
    token: join(root, "runtime.token"),
    endpoint: join(root, "runtime.json"),
    lock: join(root, "startup.lock"),
  };
}

export async function acquireStartupLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  await chmod(dirname(path), DIRECTORY_MODE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      await writeFile(join(path, "pid"), String(process.pid), { mode: FILE_MODE });
      return async () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(join(path, "pid"), "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(pid) && processIsRunning(pid)) {
        throw new Error(`Runtime supervisor already holds startup lock (${pid})`);
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire runtime supervisor startup lock");
}

export async function startSupervisorServer<Runtime extends RuntimeInstance>(
  owner: RuntimeOwner<Runtime>,
  paths = resolveSupervisorPaths(),
): Promise<{ close: () => Promise<void>; supervisor: RuntimeSupervisor<Runtime> }> {
  const releaseLock = await acquireStartupLock(paths.lock);
  const supervisor = new RuntimeSupervisor({ owner });
  const sockets = new Set<Socket>();
  let globalInFlight = 0;
  const token = randomBytes(32).toString("base64url");
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let claimed: { bridgeId: string; epoch: number } | null = null;
    let socketInFlight = 0;
    let processing = Promise.resolve();
    socket.setEncoding("utf8");

    const rejectBusy = (line: string): boolean => {
      let id: string;
      try {
        const request = JSON.parse(line) as { id?: unknown };
        if (typeof request.id !== "string") throw new Error("Missing request id");
        id = request.id;
      } catch {
        socket.destroy();
        return false;
      }
      socket.pause();
      socket.write(
        `${JSON.stringify({
          id,
          ok: false,
          error: {
            code: "RUNTIME_BUSY",
            message: "Shared Browser supervisor is busy; retry the request",
          },
        })}\n`,
        (error) => {
          if (error) socket.destroy();
        },
      );
      return false;
    };

    const enqueue = (line: string): boolean => {
      if (socketInFlight >= MAX_SOCKET_IN_FLIGHT || globalInFlight >= MAX_GLOBAL_IN_FLIGHT)
        return rejectBusy(line);
      socketInFlight += 1;
      globalInFlight += 1;
      processing = processing
        .then(async () => {
          const { response, lease } = await handleLine(line, token, supervisor);
          if (lease) claimed = lease;
          if (!socket.destroyed) {
            await new Promise<void>((resolve, reject) => {
              socket.write(`${JSON.stringify(response)}\n`, (error) =>
                error ? reject(error) : resolve(),
              );
            });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          socketInFlight -= 1;
          globalInFlight -= 1;
          socket.resume();
        });
      return true;
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0 && !enqueue(line)) return;
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      if (claimed) supervisor.bridgeDisconnected(claimed.bridgeId, claimed.epoch);
    });
  });

  try {
    await mkdir(paths.root, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(paths.root, DIRECTORY_MODE);
    const tokenHandle = await open(paths.token, "w", FILE_MODE);
    try {
      await tokenHandle.writeFile(token);
    } finally {
      await tokenHandle.close();
    }
    await chmod(paths.token, FILE_MODE);
    await rm(paths.socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(paths.socket, SOCKET_MODE);
    await writeFile(
      paths.endpoint,
      JSON.stringify({ version: RUNTIME_PROTOCOL_VERSION, socket: paths.socket }),
      { mode: FILE_MODE },
    );
    await chmod(paths.endpoint, FILE_MODE);
  } catch (error) {
    server.close();
    await Promise.allSettled([
      rm(paths.socket, { force: true }),
      rm(paths.endpoint, { force: true }),
      rm(paths.token, { force: true }),
      releaseLock(),
    ]);
    throw error;
  }

  let closed = false;
  return {
    supervisor,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        supervisor.stopAll(),
      ]);
      try {
        const shutdownFailures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (shutdownFailures.length > 0)
          throw new AggregateError(
            shutdownFailures.map((result) => result.reason),
            "Runtime supervisor shutdown failed",
          );
      } finally {
        await Promise.allSettled([
          rm(paths.socket, { force: true }),
          rm(paths.endpoint, { force: true }),
          rm(paths.token, { force: true }),
          releaseLock(),
        ]);
      }
    },
  };
}
async function handleLine<Runtime extends RuntimeInstance>(
  line: string,
  token: string,
  supervisor: RuntimeSupervisor<Runtime>,
): Promise<{ response: RuntimeResponse; lease: { bridgeId: string; epoch: number } | null }> {
  let id = "unknown";
  try {
    const raw: unknown = JSON.parse(line);
    const request = parseRuntimeRequest(raw);
    id = request.id;
    if (request.method !== "agent.request" && !tokensEqual(request.token, token))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Invalid supervisor token");
    const result = await supervisor.dispatch(request);
    let lease: { bridgeId: string; epoch: number } | null = null;
    if (request.method === "bridge.claim") {
      if (!result || typeof result !== "object" || !("epoch" in result))
        throw new RuntimeProtocolError("RUNTIME_FAILURE", "Bridge claim returned no epoch");
      lease = { bridgeId: request.bridgeId, epoch: Number(result.epoch) };
    }
    return { response: { id, ok: true, result }, lease };
  } catch (error) {
    const protocolError =
      error instanceof RuntimeProtocolError
        ? error
        : new RuntimeProtocolError(
            "RUNTIME_FAILURE",
            error instanceof Error ? error.message : "Runtime operation failed",
          );
    return {
      response: {
        id,
        ok: false,
        error: { code: protocolError.code, message: protocolError.message },
      },
      lease: null,
    };
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

export async function runStandaloneSupervisor(owner: RuntimeOwner): Promise<void> {
  const running = await startSupervisorServer(owner);
  const shutdown = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
