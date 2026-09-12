import type { RpcInput } from "@getpaseo/plugin";
import { randomBytes } from "node:crypto";
import {
  DEVICE_PRESETS,
  DEFAULT_VIEWPORT,
  FRAME_MAX_BYTES,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  mapDisplayedPoint,
  applyDevicePresetRpc,
  navigateBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  type DevicePresetId,
  type Viewport,
} from "../shared/browser";
import type { JsonValue } from "./runtime-protocol";
export type WorkspaceValidator = (workspaceId: string) => Promise<void | boolean>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type CaptureQuality = "low" | "medium" | "high";
type InputTarget = SendInput["target"];

const VIEWER_TTL_MS = 45_000;
const CONTROL_LEASE_MS = 30_000;
const FRAME_CACHE_MS = 100;
const FRAME_TOKEN_TTL_MS = 5_000;
const MAX_RECENT_FRAMES = 32;
const MAX_VIEWERS_PER_SESSION = 16;
const MAX_SESSIONS = 8;
const SCREENCAST_QUALITY = 65;
const RUNTIME_FRAME_MAX_BYTES = 750_000;
const SCREENCAST_WAIT_MS = 500;
const JPEG_QUALITY = { low: 40, medium: 65, high: 85 } as const;

export interface BrowserRuntimeClient {
  connect(): Promise<{ epoch: number }>;
  ensureWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    runtimeId: string;
    createdAt: number;
  }>;
  requestWorkspace(workspaceId: string, operation: string, input: JsonValue): Promise<JsonValue>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  disconnect(): void;
}

export interface SessionManagerOptions {
  validateWorkspace: WorkspaceValidator;
  client: BrowserRuntimeClient;
  now?: () => number;
  issueToken?: () => string;
  viewerTtlMs?: number;
  controlLeaseMs?: number;
  frameCacheMs?: number;
  maxSessions?: number;
}

interface Viewer {
  label: string;
  expiresAt: number;
}
interface Controller {
  viewerToken: string;
  controlToken: string;
  expiresAt: number;
}
interface BrowserSession {
  workspaceId: string;
  sessionId: string;
  runtimeId: string;
  runtimeCreatedAt: number;
  bridgeEpoch: number;
  viewport: Viewport;
  navigationGeneration: number;
  viewportGeneration: number;
  devicePresetId: DevicePresetId | null;
  userAgent: string;
  defaultUserAgent: string;
  viewers: Map<string, Viewer>;
  controller: Controller | null;
  mutationTail: Promise<void>;
  frameCache: Map<CaptureQuality, { frame: BrowserFrame; cachedAt: number }>;
  recentFrames: Map<
    string,
    { navigationGeneration: number; viewportGeneration: number; expiresAt: number }
  >;
  lastUrl: string;
  lastTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  archived: boolean;
}

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function assertViewport(viewport: Viewport): void {
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < MIN_VIEWPORT.width ||
    viewport.width > MAX_VIEWPORT.width ||
    viewport.height < MIN_VIEWPORT.height ||
    viewport.height > MAX_VIEWPORT.height
  ) {
    throw new Error("Viewport is outside the supported bounds");
  }
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runtime returned an invalid response");
  return value;
}

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (value === "about:blank") return value;
  const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
  const looksLikeHostWithPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value);
  const candidate = hasScheme && !looksLikeHostWithPort ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Only HTTP, HTTPS, and about:blank URLs are supported");
  return parsed.href;
}

export class SessionManager {
  private readonly validateWorkspace: WorkspaceValidator;
  private readonly client: BrowserRuntimeClient;
  private readonly now: () => number;
  private readonly issueToken: () => string;
  private readonly viewerTtlMs: number;
  private readonly controlLeaseMs: number;
  private readonly frameCacheMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly viewerSessions = new Map<string, BrowserSession>();
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>();
  private readonly archived = new Set<string>();
  private bridgeEpoch = 0;
  private lifecycleGeneration = 0;
  private closed = false;

  constructor(options: SessionManagerOptions) {
    this.validateWorkspace = options.validateWorkspace;
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.issueToken = options.issueToken ?? defaultToken;
    this.viewerTtlMs = options.viewerTtlMs ?? VIEWER_TTL_MS;
    this.controlLeaseMs = options.controlLeaseMs ?? CONTROL_LEASE_MS;
    this.frameCacheMs = options.frameCacheMs ?? FRAME_CACHE_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("maxSessions must be a positive integer");
  }

  async connect(): Promise<void> {
    const lease = await this.client.connect();
    this.bridgeEpoch = lease.epoch;
  }

  setBridgeEpoch(epoch: number): void {
    this.bridgeEpoch = epoch;
    for (const session of this.sessions.values()) session.bridgeEpoch = epoch;
  }

  async attach(
    workspaceId: string,
    viewerLabel: string,
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    this.assertOpen();
    const label = viewerLabel.trim();
    if (!label || label.length > 64) throw new Error("Viewer label is invalid");
    const validation = await this.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    this.assertOpen();
    const session = await this.getOrCreateSession(workspaceId);
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION)
        throw new Error(`Shared browser viewer limit (${MAX_VIEWERS_PER_SESSION}) reached`);
      const viewerToken = this.issueUniqueToken();
      session.viewers.set(viewerToken, { label, expiresAt: this.now() + this.viewerTtlMs });
      this.viewerSessions.set(viewerToken, session);
      await this.request(session, "screencast.start", { quality: SCREENCAST_QUALITY }).catch(
        () => undefined,
      );
      try {
        return { viewerToken, state: await this.snapshotState(session, viewerToken) };
      } catch (error) {
        session.viewers.delete(viewerToken);
        this.viewerSessions.delete(viewerToken);
        throw error;
      }
    });
  }

  async detach(viewerToken: string): Promise<{ detached: boolean }> {
    const session = this.viewerSessions.get(viewerToken);
    if (!session) return { detached: false };
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      const detached = session.viewers.delete(viewerToken);
      this.viewerSessions.delete(viewerToken);
      if (session.controller?.viewerToken === viewerToken) session.controller = null;
      if (session.viewers.size === 0)
        await this.request(session, "screencast.stop", null).catch(() => undefined);
      return { detached };
    });
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.assertOpen();
    this.archived.add(workspaceId);
    await this.client.archiveWorkspace(workspaceId);
    const pending = this.sessionCreations.get(workspaceId);
    if (pending) await pending.catch(() => undefined);
    const session = this.sessions.get(workspaceId);
    if (!session) return;
    session.archived = true;
    for (const token of session.viewers.keys()) this.viewerSessions.delete(token);
    session.viewers.clear();
    session.controller = null;
    this.sessions.delete(workspaceId);
  }

  async listOpenWorkspaceIds(): Promise<string[]> {
    this.assertOpen();
    const result: string[] = [];
    for (const session of this.sessions.values()) {
      await this.serialize(session, async () => {
        this.pruneExpired(session);
        if (session.viewers.size > 0) result.push(session.workspaceId);
      });
    }
    return result;
  }
  async status(viewerToken: string): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.snapshotState(session, viewerToken) };
    });
  }

  async capture(
    viewerToken: string,
    quality: CaptureQuality = "medium",
    knownFrameId: string | null = null,
  ): Promise<{ state: BrowserState; frame: BrowserFrame | null }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      this.heartbeatViewer(session, viewerToken);
      const frame = await this.frameForQuality(session, quality);
      this.rememberFrame(session, frame);
      return {
        state: await this.snapshotState(session, viewerToken),
        frame: knownFrameId === frame.frameId ? null : frame,
      };
    });
  }

  async acquireControl(
    viewerToken: string,
    takeover = false,
  ): Promise<{ controlToken: string; state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.heartbeat(session, viewerToken);
      const current = session.controller;
      if (current && current.viewerToken !== viewerToken && !takeover)
        throw new Error("Browser control is held by another viewer");
      const controller =
        current?.viewerToken === viewerToken
          ? current
          : { viewerToken, controlToken: this.issueUniqueToken(), expiresAt: 0 };
      controller.expiresAt = this.now() + this.controlLeaseMs;
      session.controller = controller;
      return {
        controlToken: controller.controlToken,
        state: await this.snapshotState(session, viewerToken),
      };
    });
  }

  async releaseControl(
    viewerToken: string,
    controlToken: string,
  ): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.requireController(session, viewerToken, controlToken);
      session.controller = null;
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.snapshotState(session, viewerToken) };
    });
  }

  async navigate(input: NavigateInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      const navigationGeneration = session.navigationGeneration;
      if (input.action.kind === "goto")
        await this.request(session, "navigate", { url: normalizeBrowserUrl(input.action.url) });
      else if (input.action.kind === "back") {
        await this.refreshPageMetadata(session);
        if (!session.canGoBack) throw new Error("Browser cannot go back");
        await this.request(session, "back", null);
      } else if (input.action.kind === "forward") {
        await this.refreshPageMetadata(session);
        if (!session.canGoForward) throw new Error("Browser cannot go forward");
        await this.request(session, "forward", null);
      } else await this.request(session, "reload", null);
      await this.refreshPageMetadata(session);
      if (session.navigationGeneration === navigationGeneration) session.navigationGeneration += 1;
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async resize(input: ResizeInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      assertViewport(input.viewport);
      if (
        session.viewport.width !== input.viewport.width ||
        session.viewport.height !== input.viewport.height ||
        session.devicePresetId !== null
      ) {
        await this.request(session, "emulate", {
          ...input.viewport,
          deviceScaleFactor: 1,
          mobile: false,
          touch: false,
          userAgent: session.defaultUserAgent,
          platform: "",
        });
        session.viewport = { ...input.viewport };
        session.devicePresetId = null;
        session.userAgent = session.defaultUserAgent;
        session.viewportGeneration += 1;
        this.invalidateFrames(session);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async applyDevicePreset(input: ApplyDevicePresetInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      const preset = DEVICE_PRESETS.find(({ id }) => id === input.presetId);
      if (!preset) throw new Error("Unknown device preset");
      await this.request(session, "emulate", {
        width: preset.viewport.width,
        height: preset.viewport.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.isMobile,
        touch: preset.hasTouch,
        userAgent: preset.userAgent,
        platform: preset.platform,
      });
      session.viewport = { ...preset.viewport };
      session.devicePresetId = preset.id;
      session.userAgent = preset.userAgent;
      session.viewportGeneration += 1;
      session.navigationGeneration += 1;
      this.invalidateFrames(session);
      await this.request(session, "reload", null);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async sendInput(input: SendInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.requireRecentFrame(session, input.target);
      await this.dispatchInput(session, input.event, input.target);
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  reset(): void {
    this.lifecycleGeneration += 1;
    this.sessions.clear();
    this.sessionCreations.clear();
    this.viewerSessions.clear();
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.disconnect();
    this.reset();
  }

  private async getOrCreateSession(workspaceId: string): Promise<BrowserSession> {
    if (this.archived.has(workspaceId)) throw new Error("Workspace was archived");
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const pending = this.sessionCreations.get(workspaceId);
    if (pending) return pending;
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions)
      throw new Error(`Shared browser session limit (${this.maxSessions}) reached`);
    const lifecycleGeneration = this.lifecycleGeneration;
    const creation = this.createSession(workspaceId);
    this.sessionCreations.set(workspaceId, creation);
    try {
      const session = await creation;
      if (
        this.closed ||
        this.archived.has(workspaceId) ||
        lifecycleGeneration !== this.lifecycleGeneration
      )
        throw new Error(
          this.closed
            ? "Shared browser manager is closed"
            : this.archived.has(workspaceId)
              ? "Workspace was archived"
              : "Shared browser manager was reset",
        );
      this.sessions.set(workspaceId, session);
      return session;
    } catch (error) {
      if (this.archived.has(workspaceId)) throw new Error("Workspace was archived");
      throw error;
    } finally {
      if (this.sessionCreations.get(workspaceId) === creation)
        this.sessionCreations.delete(workspaceId);
    }
  }

  private async createSession(workspaceId: string): Promise<BrowserSession> {
    let ensured = false;
    try {
      const descriptor = await this.client.ensureWorkspace(workspaceId);
      ensured = true;
      const identity = asRecord(await this.client.requestWorkspace(workspaceId, "identity", null));
      const userAgent = boundedText(String(identity.userAgent ?? "Chromium"), 512);
      await this.client.requestWorkspace(workspaceId, "emulate", {
        ...DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
        userAgent,
        platform: "",
      });
      const state = asRecord(await this.client.requestWorkspace(workspaceId, "state", null));
      return {
        workspaceId,
        sessionId: this.issueUniqueToken(),
        runtimeId: descriptor.runtimeId,
        runtimeCreatedAt: descriptor.createdAt,
        bridgeEpoch: this.bridgeEpoch,
        viewport: { ...DEFAULT_VIEWPORT },
        navigationGeneration: 0,
        viewportGeneration: 0,
        devicePresetId: null,
        userAgent,
        defaultUserAgent: userAgent,
        viewers: new Map(),
        controller: null,
        mutationTail: Promise.resolve(),
        frameCache: new Map(),
        recentFrames: new Map(),
        lastUrl: boundedText(String(state.url ?? ""), 8192),
        lastTitle: boundedText(String(state.title ?? ""), 1024),
        canGoBack: Boolean(state.canGoBack),
        canGoForward: Boolean(state.canGoForward),
        error: null,
        archived: false,
      };
    } catch (error) {
      if (ensured) await this.client.archiveWorkspace(workspaceId).catch(() => undefined);
      throw error;
    }
  }

  private request(
    session: BrowserSession,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    if (session.archived) throw new Error("Workspace was archived");
    return this.client.requestWorkspace(session.workspaceId, operation, input);
  }

  private requireViewer(token: string): BrowserSession {
    const session = this.viewerSessions.get(token);
    if (!session || !session.viewers.has(token))
      throw new Error("Viewer token is invalid or expired");
    return session;
  }
  private heartbeat(session: BrowserSession, token: string): void {
    this.pruneExpired(session);
    this.heartbeatViewer(session, token);
    if (session.controller?.viewerToken === token)
      session.controller.expiresAt = this.now() + this.controlLeaseMs;
  }
  private heartbeatViewer(session: BrowserSession, token: string): void {
    const viewer = session.viewers.get(token);
    if (!viewer) throw new Error("Viewer token is invalid or expired");
    viewer.expiresAt = this.now() + this.viewerTtlMs;
  }
  private pruneExpired(session: BrowserSession): void {
    const now = this.now();
    for (const [token, viewer] of session.viewers)
      if (viewer.expiresAt <= now) {
        session.viewers.delete(token);
        this.viewerSessions.delete(token);
      }
    if (
      session.controller &&
      (session.controller.expiresAt <= now || !session.viewers.has(session.controller.viewerToken))
    )
      session.controller = null;
  }
  private requireController(
    session: BrowserSession,
    viewerToken: string,
    controlToken: string,
  ): Controller {
    this.pruneExpired(session);
    const value = session.controller;
    if (!value || value.viewerToken !== viewerToken || value.controlToken !== controlToken)
      throw new Error("Browser control lease is invalid or expired");
    return value;
  }
  private requireMutationAccess(
    session: BrowserSession,
    input: {
      viewerToken: string;
      controlToken: string;
      expected: {
        sessionId: string;
        navigationGeneration: number;
        viewportGeneration: number;
        runtimeId?: string | undefined;
        bridgeEpoch?: number | undefined;
      };
    },
  ): void {
    this.requireController(session, input.viewerToken, input.controlToken);
    if (input.expected.sessionId !== session.sessionId) throw new Error("Browser session is stale");
    if (input.expected.navigationGeneration !== session.navigationGeneration)
      throw new Error("Browser navigation state is stale");
    if (input.expected.viewportGeneration !== session.viewportGeneration)
      throw new Error("Browser viewport state is stale");
    if (input.expected.runtimeId && input.expected.runtimeId !== session.runtimeId)
      throw new Error("Browser runtime is stale");
    if (
      input.expected.bridgeEpoch !== undefined &&
      input.expected.bridgeEpoch !== session.bridgeEpoch
    )
      throw new Error("Browser bridge state is stale");
  }
  private requireRecentFrame(
    session: BrowserSession,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): void {
    this.pruneRecentFrames(session);
    const frame = session.recentFrames.get(target.frameId);
    if (
      !frame ||
      target.navigationGeneration !== session.navigationGeneration ||
      target.viewportGeneration !== session.viewportGeneration ||
      frame.navigationGeneration !== session.navigationGeneration ||
      frame.viewportGeneration !== session.viewportGeneration
    )
      throw new Error("Browser frame is stale");
  }
  private renewController(session: BrowserSession, token: string): void {
    this.heartbeatViewer(session, token);
    const controller = session.controller;
    if (!controller || controller.viewerToken !== token)
      throw new Error("Browser control lease is invalid or expired");
    controller.expiresAt = this.now() + this.controlLeaseMs;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Shared browser manager is closed");
  }
  private issueUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.issueToken();
      if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Token issuer returned an invalid opaque token");
      if (
        !this.viewerSessions.has(token) &&
        ![...this.sessions.values()].some(
          (session) =>
            session.sessionId === token ||
            session.controller?.controlToken === token ||
            session.recentFrames.has(token),
        )
      )
        return token;
    }
    throw new Error("Could not issue a unique opaque token");
  }
  private pruneRecentFrames(session: BrowserSession): void {
    const now = this.now();
    for (const [id, frame] of session.recentFrames)
      if (frame.expiresAt <= now) session.recentFrames.delete(id);
  }
  private serialize<T>(session: BrowserSession, operation: () => Promise<T>): Promise<T> {
    const result = session.mutationTail.then(operation, operation);
    session.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private invalidateFrames(session: BrowserSession): void {
    session.frameCache.clear();
    session.recentFrames.clear();
  }

  private async frameForQuality(
    session: BrowserSession,
    quality: CaptureQuality,
  ): Promise<BrowserFrame> {
    const cached = session.frameCache.get(quality);
    if (
      cached &&
      cached.frame.navigationGeneration === session.navigationGeneration &&
      cached.frame.viewportGeneration === session.viewportGeneration &&
      this.now() - cached.cachedAt <= this.frameCacheMs
    )
      return cached.frame;
    const generation = {
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
    };
    const raw = asRecord(
      await this.request(session, "frame", {
        maxBytes: RUNTIME_FRAME_MAX_BYTES,
        quality: JPEG_QUALITY[quality],
        waitMs: SCREENCAST_WAIT_MS,
      }),
    );
    if (
      generation.navigationGeneration !== session.navigationGeneration ||
      generation.viewportGeneration !== session.viewportGeneration
    )
      throw new Error("Browser changed during capture; request another frame");
    const byteLength = Number(raw.byteLength);
    const dataBase64 = String(raw.dataBase64 ?? "");
    if (
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > FRAME_MAX_BYTES ||
      Buffer.byteLength(dataBase64, "base64") !== byteLength
    )
      throw new Error("Browser returned an invalid frame");
    const frame: BrowserFrame = {
      sessionId: session.sessionId,
      frameId: this.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: raw.transport === "cdp-screencast" ? "cdp-screencast" : "screenshot",
      dataBase64,
      byteLength,
      width: Number(raw.width),
      height: Number(raw.height),
      ...generation,
      runtimeId: session.runtimeId,
      captureEpoch: session.bridgeEpoch,
      capturedAt: String(raw.capturedAt),
    };
    if (frame.width !== session.viewport.width || frame.height !== session.viewport.height)
      throw new Error("Browser returned a frame for a stale viewport");
    session.frameCache.set(quality, { frame, cachedAt: this.now() });
    return frame;
  }

  private rememberFrame(session: BrowserSession, frame: BrowserFrame): void {
    this.pruneRecentFrames(session);
    session.recentFrames.set(frame.frameId, {
      navigationGeneration: frame.navigationGeneration,
      viewportGeneration: frame.viewportGeneration,
      expiresAt: this.now() + FRAME_TOKEN_TTL_MS,
    });
    while (session.recentFrames.size > MAX_RECENT_FRAMES) {
      const oldest = session.recentFrames.keys().next().value;
      if (!oldest) break;
      session.recentFrames.delete(oldest);
    }
  }

  private async dispatchInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    target: InputTarget,
  ): Promise<void> {
    const assertTargetCurrent = async () => {
      await this.refreshPageMetadata(session);
      this.requireRecentFrame(session, target);
    };
    if (event.kind === "type") {
      await this.request(session, "text.insert", { text: event.text });
      return;
    }
    if (event.kind === "key") {
      await this.request(session, "key.down", { key: event.key });
      try {
        await assertTargetCurrent();
      } finally {
        await this.request(session, "key.up", { key: event.key });
      }
      return;
    }
    if (event.kind === "move") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.request(session, "mouse.move", { x: point.x, y: point.y });
      return;
    }
    if (event.kind === "scroll") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.request(session, "mouse.move", { x: point.x, y: point.y });
      await assertTargetCurrent();
      await this.request(session, "mouse.wheel", {
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
      return;
    }
    const start = mapDisplayedPoint(
      event.kind === "drag" ? event.start : event.point,
      session.viewport,
    );
    await this.request(session, "mouse.move", { x: start.x, y: start.y });
    await assertTargetCurrent();
    const count = event.kind === "click" ? event.clickCount : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.request(session, "mouse.down", {
        x: start.x,
        y: start.y,
        button: event.button,
        clickCount,
      });
      try {
        await assertTargetCurrent();
        if (event.kind === "drag") {
          const end = mapDisplayedPoint(event.end, session.viewport);
          await this.request(session, "mouse.move", { x: end.x, y: end.y });
          await assertTargetCurrent();
        }
      } finally {
        const end = event.kind === "drag" ? mapDisplayedPoint(event.end, session.viewport) : start;
        await this.request(session, "mouse.up", {
          x: end.x,
          y: end.y,
          button: event.button,
          clickCount,
        });
      }
    }
  }

  private async refreshPageMetadata(session: BrowserSession): Promise<void> {
    const raw = asRecord(await this.request(session, "state", null));
    const url = boundedText(String(raw.url ?? ""), 8192);
    if (session.lastUrl && session.lastUrl !== url) {
      session.navigationGeneration += 1;
      this.invalidateFrames(session);
    }
    session.lastUrl = url;
    session.lastTitle = boundedText(String(raw.title ?? ""), 1024);
    session.canGoBack = Boolean(raw.canGoBack);
    session.canGoForward = Boolean(raw.canGoForward);
  }

  private async snapshotState(session: BrowserSession, viewerToken: string): Promise<BrowserState> {
    this.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    try {
      await this.refreshPageMetadata(session);
      session.error = null;
    } catch (error) {
      session.error = boundedText(error instanceof Error ? error.message : String(error), 2048);
    }
    const controller = session.controller;
    const controllerViewer = controller ? session.viewers.get(controller.viewerToken) : null;
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      runtimeCreatedAt: session.runtimeCreatedAt,
      bridgeEpoch: session.bridgeEpoch,
      status: session.error ? "error" : "ready",
      url: session.lastUrl,
      title: session.lastTitle,
      canGoBack: session.canGoBack,
      canGoForward: session.canGoForward,
      viewport: { ...session.viewport },
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
      devicePresetId: session.devicePresetId,
      userAgent: session.userAgent,
      controller: !controller ? "none" : controller.viewerToken === viewerToken ? "self" : "other",
      controllerLabel: controllerViewer?.label ?? null,
      controllerExpiresAt: controller ? new Date(controller.expiresAt).toISOString() : null,
      viewerCount: session.viewers.size,
      error: session.error,
    };
  }
}
