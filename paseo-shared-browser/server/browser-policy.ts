import { randomBytes } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type applyDevicePresetRpc,
  type BrowserFrame,
  type BrowserGestureEvent,
  type BrowserInputEvent,
  type BrowserState,
  type beginBrowserGestureRpc,
  browserCursorSchema,
  browserGestureEventSchema,
  DEFAULT_VIEWPORT,
  DEVICE_PRESETS,
  type DevicePresetId,
  type endBrowserGestureRpc,
  FRAME_MAX_BYTES,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  mapDisplayedPoint,
  type navigateBrowserRpc,
  type resizeBrowserRpc,
  type sendBrowserInputRpc,
  type updateBrowserGestureRpc,
  type Viewport,
} from "../shared/browser";
import {
  captureDimensions,
  DEFAULT_CAPTURE_QUALITY,
  DEFAULT_JPEG_QUALITY,
  JPEG_QUALITY,
} from "../shared/capture-settings";
import { BrowserGesture } from "./browser-gesture";
import { sameRuntimeInputAttachment } from "./input-generation";
import type { JsonValue } from "./runtime-protocol";
export type WorkspaceValidator = (workspaceId: string) => Promise<void | boolean>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type BeginGestureInput = RpcInput<typeof beginBrowserGestureRpc>;
type UpdateGestureInput = RpcInput<typeof updateBrowserGestureRpc>;
type UpdateGestureReply = Omit<RpcOutput<typeof updateBrowserGestureRpc>, "state"> & {
  state: BrowserState;
};
type EndGestureInput = RpcInput<typeof endBrowserGestureRpc>;
type CaptureQuality = "low" | "medium" | "high";
type InputTarget = SendInput["target"];

const VIEWER_TTL_MS = 45_000;
const CONTROL_LEASE_MS = 30_000;
const FRAME_CACHE_MS = 100;
const FRAME_TOKEN_TTL_MS = 5_000;
const MAX_RECENT_FRAMES = 32;
const MAX_VIEWERS_PER_SESSION = 16;
const MAX_SESSIONS = 8;
const SCREENCAST_WAIT_MS = 500;
const RUNTIME_FRAME_MAX_BYTES = 750_000;

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
  captureScale: number;
  navigationGeneration: number;
  viewportGeneration: number;
  devicePresetId: DevicePresetId | null;
  userAgent: string;
  defaultUserAgent: string;
  viewers: Map<string, Viewer>;
  controller: Controller | null;
  mutationTail: Promise<void>;
  frameCache: Map<
    CaptureQuality,
    {
      frame: BrowserFrame;
      cachedAt: number;
    }
  >;
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
  gesture: BrowserGesture | null;
  inputGeneration: string | null;
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
    for (const session of this.sessions.values()) {
      if (session.bridgeEpoch !== epoch) void this.cancelGesture(session);
      session.bridgeEpoch = epoch;
    }
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
      await this.request(session, "screencast.start", { quality: DEFAULT_JPEG_QUALITY }).catch(
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
      if (session.controller?.viewerToken === viewerToken) {
        await this.cancelGesture(session);
        session.controller = null;
      }
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
    await this.cancelGesture(session);
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
    quality: CaptureQuality = DEFAULT_CAPTURE_QUALITY,
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
      if (current?.viewerToken !== viewerToken) await this.cancelGesture(session);
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
      await this.cancelGesture(session);
      session.controller = null;
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.snapshotState(session, viewerToken) };
    });
  }

  async navigate(input: NavigateInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.cancelGesture(session);
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
      await this.cancelGesture(session);
      assertViewport(input.viewport);
      // A custom size changes dimensions only: the active profile keeps its
      // mobile/touch/density/UA/platform/capture density and stays selected.
      const preset = DEVICE_PRESETS.find(({ id }) => id === session.devicePresetId);
      if (
        session.viewport.width !== input.viewport.width ||
        session.viewport.height !== input.viewport.height
      ) {
        await this.request(session, "emulate", {
          ...input.viewport,
          deviceScaleFactor: preset?.deviceScaleFactor ?? 1,
          captureScale: session.captureScale,
          mobile: preset?.isMobile ?? false,
          touch: preset?.hasTouch ?? false,
          userAgent: session.userAgent,
          platform: preset?.platform ?? "",
        });
        session.viewport = { ...input.viewport };
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
      await this.cancelGesture(session);
      const preset = DEVICE_PRESETS.find(({ id }) => id === input.presetId);
      if (!preset) throw new Error("Unknown device preset");
      // Resolve the display under the session lock. A mode toggle must neither
      // replay remembered dimensions nor change the capture's pixel resolution.
      const viewport = input.preserveDisplay ? session.viewport : preset.viewport;
      const captureScale = input.preserveDisplay ? session.captureScale : preset.captureScale;
      await this.request(session, "emulate", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        captureScale,
        mobile: preset.isMobile,
        touch: preset.hasTouch,
        userAgent: preset.userAgent,
        platform: preset.platform,
      });
      session.viewport = { ...viewport };
      session.devicePresetId = preset.id;
      session.captureScale = captureScale;
      session.userAgent = preset.userAgent;
      session.viewportGeneration += 1;
      // Emulation invalidates input geometry even when display dimensions stay
      // fixed. UA-sniffing sites can use Reload; never discard a draft automatically.
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async sendInput(input: SendInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.requireRecentFrame(session, input.target);
      try {
        await this.cancelGesture(session);
        await this.dispatchInput(session, input.event, input.target);
      } finally {
        // Admitted: whatever happened, including a partial or ordinary failure, the
        // capture is spent. A caller must observe again before another attempt.
        this.invalidateFrames(session);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  /** Anchor a live channel to exact frame/control/runtime identity, without pressing anything. */
  async beginGesture(input: BeginGestureInput) {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.refreshPageMetadata(session);
      this.requireMutationAccess(session, input);
      if (!this.isRecentFrame(session, input.target)) {
        // A pre-input capture can decode after scroll revoked its token. Report
        // known non-publication, not an uncertain runtime failure. The client
        // may obtain another decoded frame before admitting its still-unsent input.
        const state = await this.snapshotState(session, input.viewerToken);
        this.requireMutationAccess(session, input);
        if (state.status !== "ready")
          throw new Error(state.error ?? "Browser runtime is unavailable");
        return { state, admission: "stale-frame" as const };
      }
      await this.cancelGesture(session);
      const gesture = new BrowserGesture(
        this.issueUniqueToken(),
        input.viewerToken,
        input.controlToken,
        input.pointerKind,
        { ...input.expected },
        { ...session.viewport },
        this.now(),
        session.inputGeneration,
      );
      session.gesture = gesture;
      try {
        await this.request(session, "input.begin", { gestureId: gesture.id });
        await this.assertGestureCurrent(session, gesture);
        this.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const state = await this.snapshotState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence };
      } catch (error) {
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /** Deliver one strictly ordered packet; an uncertain failure cancels without retrying its action. */
  async updateGesture(input: UpdateGestureInput): Promise<UpdateGestureReply> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      const gesture = this.requireGesture(session, input);
      let publishedEvent: BrowserGestureEvent | null = null;
      let eventAcknowledged = false;
      try {
        this.assertGesturePacketContext(gesture, input.expected);
        const event = browserGestureEventSchema.parse(input.event);
        gesture.assertSequence(input.sequence, this.now());
        await this.assertGestureCurrent(session, gesture);
        gesture.validate(event);
        if (
          event.kind === "down" ||
          (event.kind === "touch" && event.type === "start" && gesture.touches.size === 0)
        ) {
          if (!input.target) throw new Error("A current frame is required for a new press");
          this.requireRecentFrame(session, input.target);
        }
        const hover = gesture.isHover(event);
        if (event.kind === "key") {
          await this.request(session, "input.key", {
            gestureId: gesture.id,
            event: {
              kind: event.kind,
              type: event.type,
              key: event.key,
              code: event.code,
              modifiers: event.modifiers,
              repeat: event.repeat,
              ...(event.text !== undefined ? { text: event.text } : {}),
            },
          });
        } else if (event.kind === "text") {
          await this.request(session, "input.text", { gestureId: gesture.id, text: event.text });
        } else if (event.kind === "leave") {
          await this.request(session, "mouse.leave", { gestureId: gesture.id });
          gesture.lastPoint = null;
        } else if (event.kind === "touch") {
          const points = event.points.map((point) => ({
            ...gesture.mapPoint(point),
            id: point.id,
          }));
          await this.request(session, "touch", { gestureId: gesture.id, type: event.type, points });
        } else {
          const point = gesture.mapPoint(event.point);
          const operation =
            event.kind === "move"
              ? "mouse.move"
              : event.kind === "down"
                ? "mouse.down"
                : event.kind === "up"
                  ? "mouse.up"
                  : "mouse.wheel";
          await this.request(session, operation, {
            ...point,
            gestureId: gesture.id,
            ...(event.kind === "down" || event.kind === "up"
              ? { button: event.button, clickCount: event.clickCount }
              : {}),
            ...(event.kind === "scroll" ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
          });
        }
        publishedEvent = event;
        await this.assertGestureCurrent(session, gesture);
        gesture.acknowledge(event, this.now());
        eventAcknowledged = true;
        // Hover may alter pixels but still leaves the bounded decoded-frame token
        // usable for a subsequent press. Scroll/held input revokes that authority.
        session.frameCache.clear();
        if (!hover) session.recentFrames.clear();
        this.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const cursor = await this.gestureCursor(session, gesture);
        const state = await this.snapshotState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence, cursor };
      } catch (error) {
        if (publishedEvent) {
          const completion = await this.completeNavigatingInput(
            session,
            gesture,
            publishedEvent,
            eventAcknowledged,
          ).catch(() => null);
          if (completion) return completion;
        }
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /** Return a fresh viewing state after acknowledged input navigated, without admitting another input. */
  private async completeNavigatingInput(
    session: BrowserSession,
    gesture: BrowserGesture,
    event: BrowserGestureEvent,
    eventAcknowledged: boolean,
  ) {
    const state = await this.snapshotState(session, gesture.viewerToken);
    if (state.navigationGeneration === gesture.expected.navigationGeneration) return null;
    // Runtime inputGeneration is the private native attachment:document tuple.
    // A target replacement can also bump policy navigationGeneration, but must
    // never be accepted as same-attachment navigation after an acknowledged input.
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;

    // Only the old document constraint may change after successful publication.
    // Takeover, viewport changes and runtime/bridge fences are still refused.
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: state.navigationGeneration },
    });
    if (!eventAcknowledged) gesture.acknowledge(event, this.now());
    await this.cancelGesture(session, gesture);
    const finalState = await this.snapshotState(session, gesture.viewerToken);
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: finalState.navigationGeneration },
    });
    this.invalidateFrames(session);
    this.renewController(session, gesture.viewerToken);
    return {
      state: finalState,
      gestureId: gesture.id,
      nextSequence: gesture.nextSequence,
      cursor: null,
      completion: "navigation" as const,
    };
  }

  /** Cancellation releases only this channel, even after a lost update reply or navigation drift. */
  async endGesture(input: EndGestureInput) {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      const gesture = session.gesture;
      if (!gesture && input.cancel) {
        this.requireController(session, input.viewerToken, input.controlToken);
        return { state: await this.snapshotState(session, input.viewerToken), cursor: null };
      }
      const owned = this.requireGesture(session, input);
      try {
        if (!input.cancel) {
          this.assertGesturePacketContext(owned, input.expected);
          owned.assertSequence(input.sequence, this.now());
          await this.assertGestureCurrent(session, owned);
        }
      } finally {
        await this.cancelGesture(session, owned);
      }
      return { state: await this.snapshotState(session, input.viewerToken), cursor: null };
    });
  }

  private requireGesture(
    session: BrowserSession,
    input: UpdateGestureInput | EndGestureInput,
  ): BrowserGesture {
    const gesture = session.gesture;
    if (
      !gesture ||
      gesture.id !== input.gestureId ||
      gesture.viewerToken !== input.viewerToken ||
      gesture.controlToken !== input.controlToken
    )
      throw new Error("Browser gesture is unavailable");
    return gesture;
  }

  private assertGesturePacketContext(
    gesture: BrowserGesture,
    expected: BeginGestureInput["expected"],
  ): void {
    // JSON member order is irrelevant; identity fields must match individually.
    for (const key of [
      "sessionId",
      "runtimeId",
      "bridgeEpoch",
      "navigationGeneration",
      "viewportGeneration",
    ] as const) {
      if (gesture.expected[key] !== expected[key])
        throw new Error("Browser gesture context changed");
    }
  }

  private async assertGestureCurrent(
    session: BrowserSession,
    gesture: BrowserGesture,
  ): Promise<void> {
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (
      session.gesture !== gesture ||
      this.now() >= gesture.idleUntil ||
      this.now() >= gesture.expiresAt
    )
      throw new Error("Browser gesture expired");
    // Runtime check pins the CDP document/attachment without repeating a full
    // metadata read for every drag point. snapshotState supplies final metadata.
    await this.request(session, "input.check", { gestureId: gesture.id });
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (session.gesture !== gesture) throw new Error("Browser gesture was cancelled");
  }

  private async gestureCursor(session: BrowserSession, gesture: BrowserGesture) {
    if (!gesture.lastPoint || gesture.pointerKind !== "mouse") return null;
    try {
      const raw = await this.request(session, "cursor", {
        ...gesture.lastPoint,
        gestureId: gesture.id,
      });
      const parsed = browserCursorSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private scheduleGestureTimeout(session: BrowserSession, gesture: BrowserGesture): void {
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = setTimeout(
      () => {
        void this.serialize(session, async () => {
          if (
            session.gesture === gesture &&
            this.now() >= Math.min(gesture.idleUntil, gesture.expiresAt)
          ) {
            await this.cancelGesture(session, gesture);
          }
        }).catch(() => undefined);
      },
      Math.max(1, Math.min(gesture.idleUntil, gesture.expiresAt) - this.now()),
    );
    gesture.timer.unref?.();
  }

  private async cancelGesture(session: BrowserSession, expected?: BrowserGesture): Promise<void> {
    const gesture = session.gesture;
    if (!gesture || (expected && gesture !== expected)) return;
    session.gesture = null;
    if (gesture.timer) clearTimeout(gesture.timer);
    // Cleanup targets the runtime's original attachment, never a newly navigated
    // or replaced page. Failure is best-effort and cannot replay the input.
    try {
      await this.request(session, "input.end", { gestureId: gesture.id });
    } catch {
      /* Best-effort old-attachment cleanup must not escape teardown. */
    }
  }

  reset(): void {
    this.lifecycleGeneration += 1;
    for (const session of this.sessions.values()) void this.cancelGesture(session);
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
        captureScale: 1,
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
        gesture: null,
        inputGeneration: typeof state.inputGeneration === "string" ? state.inputGeneration : null,
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
    ) {
      session.controller = null;
      void this.serialize(session, () => this.cancelGesture(session)).catch(() => undefined);
    }
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
    if (!this.isRecentFrame(session, target)) throw new Error("Browser frame is stale");
  }

  /** Check issued frame authority without admitting or cancelling a live channel. */
  private isRecentFrame(
    session: BrowserSession,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): boolean {
    this.pruneRecentFrames(session);
    const frame = session.recentFrames.get(target.frameId);
    return Boolean(
      frame &&
        target.navigationGeneration === session.navigationGeneration &&
        target.viewportGeneration === session.viewportGeneration &&
        frame.navigationGeneration === session.navigationGeneration &&
        frame.viewportGeneration === session.viewportGeneration,
    );
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
      cached.frame.sessionId === session.sessionId &&
      cached.frame.runtimeId === session.runtimeId &&
      cached.frame.captureEpoch === session.bridgeEpoch &&
      cached.frame.navigationGeneration === session.navigationGeneration &&
      cached.frame.viewportGeneration === session.viewportGeneration &&
      this.now() - cached.cachedAt <= this.frameCacheMs
    )
      return cached.frame;
    const generation = {
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      captureEpoch: session.bridgeEpoch,
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
      generation.sessionId !== session.sessionId ||
      generation.runtimeId !== session.runtimeId ||
      generation.captureEpoch !== session.bridgeEpoch ||
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
    const expectedPixels = captureDimensions(session.viewport, session.captureScale);
    if (Number(raw.width) !== expectedPixels.width || Number(raw.height) !== expectedPixels.height)
      throw new Error("Browser returned a frame for a stale viewport");

    const frame: BrowserFrame = {
      frameId: this.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: raw.transport === "cdp-screencast" ? "cdp-screencast" : "screenshot",
      dataBase64,
      byteLength,
      width: Number(raw.width),
      height: Number(raw.height),
      ...generation,
      capturedAt: String(raw.capturedAt),
    };
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

  /**
   * Discrete input runs inside a short runtime-owned channel. The channel pins the
   * CDP attachment and document, and the runtime re-checks it before every native
   * primitive, so autonomous navigation after the metadata read cannot reach an
   * unobserved page. Nothing is retried.
   */
  private async dispatchInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    target: InputTarget,
  ): Promise<void> {
    const gestureId = this.issueUniqueToken();
    await this.request(session, "input.begin", { gestureId });
    try {
      await this.dispatchPinnedInput(session, event, target, gestureId);
    } finally {
      // Releases anything still held, at the last published point on the original attachment.
      await this.request(session, "input.end", { gestureId }).catch(() => undefined);
    }
  }

  private async dispatchPinnedInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    target: InputTarget,
    gestureId: string,
  ): Promise<void> {
    const send = (operation: string, input: Record<string, JsonValue>) =>
      this.request(session, operation, { ...input, gestureId });
    const assertTargetCurrent = async () => {
      await this.refreshPageMetadata(session);
      this.requireRecentFrame(session, target);
    };
    // Validate the captured document before any primitive, including text and keys.
    await assertTargetCurrent();
    if (event.kind === "type") {
      await send("text.insert", { text: event.text });
      return;
    }
    if (event.kind === "key") {
      await send("key.down", { key: event.key });
      try {
        await assertTargetCurrent();
      } finally {
        await send("key.up", { key: event.key });
      }
      return;
    }
    if (event.kind === "move") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await send("mouse.move", { x: point.x, y: point.y });
      return;
    }
    if (event.kind === "scroll") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await send("mouse.move", { x: point.x, y: point.y });
      await assertTargetCurrent();
      await send("mouse.wheel", {
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
    await send("mouse.move", { x: start.x, y: start.y });
    await assertTargetCurrent();
    const count = event.kind === "click" ? event.clickCount : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await send("mouse.down", {
        x: start.x,
        y: start.y,
        button: event.button,
        clickCount,
      });
      try {
        await assertTargetCurrent();
        if (event.kind === "drag") {
          const end = mapDisplayedPoint(event.end, session.viewport);
          await send("mouse.move", { x: end.x, y: end.y });
          await assertTargetCurrent();
        }
      } finally {
        const end = event.kind === "drag" ? mapDisplayedPoint(event.end, session.viewport) : start;
        await send("mouse.up", {
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
    const inputGeneration = typeof raw.inputGeneration === "string" ? raw.inputGeneration : null;
    const documentChanged =
      session.inputGeneration !== null && inputGeneration !== session.inputGeneration;
    if ((session.lastUrl && session.lastUrl !== url) || documentChanged) {
      await this.cancelGesture(session);
      session.navigationGeneration += 1;
      this.invalidateFrames(session);
    }
    session.inputGeneration = inputGeneration;
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
      captureScale: session.captureScale,
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
