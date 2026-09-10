import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, BrowserType, CDPSession, Frame, Page } from "playwright";
import {
  DEVICE_PRESETS,
  DEFAULT_VIEWPORT,
  FRAME_MAX_BYTES,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  captureBrowserRpc,
  detachBrowserRpc,
  listOpenBrowserWorkspacesRpc,
  mapDisplayedPoint,
  navigateBrowserRpc,
  releaseControlRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  type DevicePresetId,
  type Viewport,
} from "../shared/browser";

type PersistentContextLauncher = BrowserType["launchPersistentContext"];

export type WorkspaceValidator = (workspaceId: string) => Promise<void | boolean>;

type AttachInput = RpcInput<typeof attachBrowserRpc>;
type AttachOutput = RpcOutput<typeof attachBrowserRpc>;
type DetachInput = RpcInput<typeof detachBrowserRpc>;
type DetachOutput = RpcOutput<typeof detachBrowserRpc>;
type CaptureInput = RpcInput<typeof captureBrowserRpc>;
type CaptureOutput = RpcOutput<typeof captureBrowserRpc>;
type AcquireControlInput = RpcInput<typeof acquireControlRpc>;
type AcquireControlOutput = RpcOutput<typeof acquireControlRpc>;
type ReleaseControlInput = RpcInput<typeof releaseControlRpc>;
type ReleaseControlOutput = RpcOutput<typeof releaseControlRpc>;
type ListOpenOutput = RpcOutput<typeof listOpenBrowserWorkspacesRpc>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type NavigateOutput = RpcOutput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ResizeOutput = RpcOutput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type ApplyDevicePresetOutput = RpcOutput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type SendOutput = RpcOutput<typeof sendBrowserInputRpc>;
type CaptureQuality = CaptureInput["quality"];
type InputTarget = SendInput["target"];

const DIRECTORY_MODE = 0o700;
const VIEWER_TTL_MS = 45_000;
const CONTROL_LEASE_MS = 30_000;
const FRAME_CACHE_MS = 100;
const FRAME_TOKEN_TTL_MS = 5_000;
const MAX_RECENT_FRAMES = 32;
const MAX_VIEWERS_PER_SESSION = 16;
const MAX_SESSIONS = 8;
const DEFAULT_BROWSER_URL = "https://paseo.sh/";
const NAVIGATION_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const SCREENCAST_QUALITY = 65;
const SCREENCAST_WAIT_MS = 500;
const JPEG_QUALITIES = {
  low: [40, 25, 10, 1],
  medium: [65, 50, 35, 20, 10, 1],
  high: [85, 70, 55, 40, 25, 10, 1],
} as const;

export interface SessionManagerOptions {
  stateRoot: string;
  validateWorkspace: WorkspaceValidator;
  launchPersistentContext?: PersistentContextLauncher;
  now?: () => number;
  issueToken?: () => string;
  viewerTtlMs?: number;
  controlLeaseMs?: number;
  frameCacheMs?: number;
  maxSessions?: number;
}

export interface ProductionSessionManagerOptions {
  stateRoot?: string;
  validateWorkspace?: WorkspaceValidator;
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

interface ScreencastFrameEvent {
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
  };
  sessionId: number;
}

interface BrowserSession {
  workspaceId: string;
  sessionId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
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
  latestScreencastFrame: BrowserFrame | null;
  screencastStarted: boolean;
  screencastWaiters: Set<(frame: BrowserFrame | null) => void>;
  lastUrl: string;
  lastTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  closing: boolean;
}

function defaultStateRoot(): string {
  return join(homedir(), ".paseo", "plugin-data", "shared-browser");
}

function loadChromium(stateRoot: string): BrowserType {
  const runtimeRequire = createRequire(join(stateRoot, "runtime", "package.json"));
  try {
    const playwrightRuntime = runtimeRequire("playwright") as { chromium: BrowserType };
    return playwrightRuntime.chromium;
  } catch {
    throw new Error(
      "The Shared Browser runtime is not prepared. Reinstall the plugin or run npm run prepare:runtime.",
    );
  }
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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP, HTTPS, and about:blank URLs are supported");
  }
  return parsed.href;
}

export class SessionManager {
  private readonly stateRoot: string;
  private readonly validateWorkspace: WorkspaceValidator;
  private readonly launchPersistentContext: PersistentContextLauncher;
  private readonly now: () => number;
  private readonly issueToken: () => string;
  private readonly viewerTtlMs: number;
  private readonly controlLeaseMs: number;
  private readonly frameCacheMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>();
  private readonly viewerSessions = new Map<string, BrowserSession>();
  private readonly workspaceTeardownRequests = new Set<string>();
  private closed = false;

  constructor(options: SessionManagerOptions) {
    this.stateRoot = options.stateRoot;
    this.validateWorkspace = options.validateWorkspace;
    this.launchPersistentContext =
      options.launchPersistentContext ??
      ((userDataDir, launchOptions) =>
        loadChromium(this.stateRoot).launchPersistentContext(userDataDir, launchOptions));
    this.now = options.now ?? Date.now;
    this.issueToken = options.issueToken ?? defaultToken;
    this.viewerTtlMs = options.viewerTtlMs ?? VIEWER_TTL_MS;
    this.controlLeaseMs = options.controlLeaseMs ?? CONTROL_LEASE_MS;
    this.frameCacheMs = options.frameCacheMs ?? FRAME_CACHE_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
  }

  async attach(
    workspaceId: string,
    viewerLabel: string,
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    this.assertOpen();
    const label = viewerLabel.trim();
    if (label.length === 0 || label.length > 64) throw new Error("Viewer label is invalid");
    const validation = await this.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    this.assertOpen();
    const session = await this.getOrCreateSession(workspaceId);
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION) {
        throw new Error(`Shared browser viewer limit (${MAX_VIEWERS_PER_SESSION}) reached`);
      }
      const viewerToken = this.issueUniqueToken();
      session.viewers.set(viewerToken, { label, expiresAt: this.now() + this.viewerTtlMs });
      this.viewerSessions.set(viewerToken, session);
      await this.ensureScreencastStarted(session);
      try {
        return { viewerToken, state: await this.snapshotState(session, viewerToken) };
      } catch (error) {
        session.viewers.delete(viewerToken);
        this.viewerSessions.delete(viewerToken);
        if (session.viewers.size === 0) await this.stopScreencast(session);
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
      if (session.viewers.size === 0) await this.stopScreencast(session);
      return { detached };
    });
  }
  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.assertOpen();
    this.workspaceTeardownRequests.add(workspaceId);
    try {
      const existing = this.sessions.get(workspaceId);
      if (existing) {
        await this.serialize(existing, async () => {
          if (this.sessions.get(workspaceId) === existing) {
            await this.teardownArchivedSession(existing);
          }
        });
        return;
      }

      const creation = this.sessionCreations.get(workspaceId);
      if (!creation) return;

      await creation.catch(() => undefined);
      const created = this.sessions.get(workspaceId);
      if (!created) return;
      await this.serialize(created, async () => {
        if (this.sessions.get(workspaceId) === created) {
          await this.teardownArchivedSession(created);
        }
      });
    } finally {
      this.workspaceTeardownRequests.delete(workspaceId);
    }
  }

  async listOpenWorkspaceIds(): Promise<string[]> {
    this.assertOpen();
    const sessions = [...this.sessions.values()];
    const openWorkspaceIds = await Promise.all(
      sessions.map((session) =>
        this.serialize(session, async () => {
          this.pruneExpired(session);
          return session.viewers.size > 0 ? session.workspaceId : null;
        }),
      ),
    );
    return openWorkspaceIds.filter((workspaceId): workspaceId is string => workspaceId !== null);
  }

  async capture(
    viewerToken: string,
    quality: CaptureQuality = "medium",
    knownFrameId: string | null = null,
  ): Promise<{ state: BrowserState; frame: BrowserFrame | null }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.heartbeat(session, viewerToken);
      const frame = await this.frameForQuality(session, quality);
      this.rememberFrame(session, frame);
      this.requireRecentFrame(session, {
        frameId: frame.frameId,
        navigationGeneration: frame.navigationGeneration,
        viewportGeneration: frame.viewportGeneration,
      });
      const state = await this.snapshotState(session, viewerToken);
      return { state, frame: knownFrameId === frame.frameId ? null : frame };
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
      if (current && current.viewerToken !== viewerToken && !takeover) {
        throw new Error("Browser control is held by another viewer");
      }
      const controller =
        current?.viewerToken === viewerToken
          ? current
          : {
              viewerToken,
              controlToken: this.issueUniqueToken(),
              expiresAt: this.now() + this.controlLeaseMs,
            };
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
      this.assertUsable(session);
      const options = { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" as const };
      switch (input.action.kind) {
        case "goto":
          await session.page.goto(normalizeBrowserUrl(input.action.url), options);
          break;
        case "back":
          await this.refreshPageMetadata(session);
          if (!session.canGoBack) throw new Error("Browser cannot go back");
          await session.page.goBack(options);
          break;
        case "forward":
          await this.refreshPageMetadata(session);
          if (!session.canGoForward) throw new Error("Browser cannot go forward");
          await session.page.goForward(options);
          break;
        case "reload":
          await session.page.reload(options);
          break;
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async resize(input: ResizeInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.assertUsable(session);
      assertViewport(input.viewport);
      if (
        session.viewport.width !== input.viewport.width ||
        session.viewport.height !== input.viewport.height ||
        session.devicePresetId !== null
      ) {
        await this.stopScreencast(session);
        try {
          await session.cdp.send("Emulation.clearDeviceMetricsOverride");
          await session.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: session.defaultUserAgent,
          });
          await session.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
          await session.page.setViewportSize(input.viewport);
          session.viewport = { ...input.viewport };
          session.userAgent = session.defaultUserAgent;
          session.devicePresetId = null;
          session.viewportGeneration += 1;
          this.invalidateFrames(session);
        } finally {
          if (session.viewers.size > 0) await this.ensureScreencastStarted(session);
        }
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async applyDevicePreset(input: ApplyDevicePresetInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.assertUsable(session);
      const preset = DEVICE_PRESETS.find(({ id }) => id === input.presetId);
      if (!preset) throw new Error("Unknown device preset");
      await this.stopScreencast(session);
      try {
        await session.cdp.send("Emulation.setUserAgentOverride", {
          userAgent: preset.userAgent,
          platform: preset.platform,
        });
        await session.cdp.send("Emulation.setDeviceMetricsOverride", {
          width: preset.viewport.width,
          height: preset.viewport.height,
          deviceScaleFactor: preset.deviceScaleFactor,
          mobile: preset.isMobile,
          screenWidth: preset.viewport.width,
          screenHeight: preset.viewport.height,
          screenOrientation: {
            type:
              preset.viewport.height >= preset.viewport.width
                ? "portraitPrimary"
                : "landscapePrimary",
            angle: 0,
          },
        });
        await session.cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: preset.hasTouch,
          maxTouchPoints: preset.hasTouch ? 5 : 1,
        });
        session.viewport = { ...preset.viewport };
        session.devicePresetId = preset.id;
        session.userAgent = preset.userAgent;
        session.viewportGeneration += 1;
        this.invalidateFrames(session);
        await session.page.reload({
          timeout: NAVIGATION_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
      } finally {
        if (session.viewers.size > 0) await this.ensureScreencastStarted(session);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async sendInput(input: SendInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.assertUsable(session);
      this.requireRecentFrame(session, input.target);
      await this.dispatchInput(session, input.event, input.target);
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.sessionCreations.values());
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.closing = true;
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        await this.stopScreencast(session);
        await session.context.close({ reason: "Shared browser plugin stopped" });
      }),
    );
    this.sessions.clear();
    this.sessionCreations.clear();
    this.viewerSessions.clear();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close every shared browser context");
    }
  }

  private async teardownArchivedSession(session: BrowserSession): Promise<void> {
    session.closing = true;
    try {
      await this.stopScreencast(session);
    } finally {
      try {
        await session.context.close({ reason: "Shared browser workspace archived" });
      } finally {
        for (const viewerToken of session.viewers.keys()) {
          this.viewerSessions.delete(viewerToken);
        }
        session.viewers.clear();
        session.controller = null;
        if (this.sessions.get(session.workspaceId) === session) {
          this.sessions.delete(session.workspaceId);
        }
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Shared browser manager is closed");
  }

  private async getOrCreateSession(workspaceId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing) {
      if (existing.closing || this.workspaceTeardownRequests.has(workspaceId)) {
        throw new Error("Workspace was archived");
      }
      return existing;
    }
    const pending = this.sessionCreations.get(workspaceId);
    if (pending) return pending;
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions) {
      throw new Error(`Shared browser session limit (${this.maxSessions}) reached`);
    }
    const creation = this.createSession(workspaceId);
    this.sessionCreations.set(workspaceId, creation);
    try {
      const session = await creation;
      if (this.closed || this.workspaceTeardownRequests.has(workspaceId)) {
        session.closing = true;
        await session.context.close({
          reason: this.closed
            ? "Shared browser manager closed during launch"
            : "Shared browser workspace archived",
        });
        throw new Error(
          this.closed ? "Shared browser manager is closed" : "Workspace was archived",
        );
      }
      this.sessions.set(workspaceId, session);
      return session;
    } finally {
      if (this.sessionCreations.get(workspaceId) === creation)
        this.sessionCreations.delete(workspaceId);
    }
  }

  private async createSession(workspaceId: string): Promise<BrowserSession> {
    const workspaceHash = createHash("sha256").update(workspaceId).digest("hex");
    await mkdir(this.stateRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(this.stateRoot, DIRECTORY_MODE);
    const profilePath = join(this.stateRoot, workspaceHash);
    await mkdir(profilePath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(profilePath, DIRECTORY_MODE);

    const context = await this.launchPersistentContext(profilePath, {
      acceptDownloads: false,
      chromiumSandbox: true,
      headless: true,
      viewport: { ...DEFAULT_VIEWPORT },
    });
    try {
      const pages = context.pages();
      const page = pages[0] ?? (await context.newPage());
      await Promise.all(pages.slice(1).map((extraPage) => extraPage.close()));
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      if (page.url() === "about:blank") {
        await page
          .goto(DEFAULT_BROWSER_URL, {
            timeout: NAVIGATION_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
          })
          .catch(() => undefined);
        if (page.url() === "about:blank") {
          throw new Error(`Could not open default browser page: ${DEFAULT_BROWSER_URL}`);
        }
      }
      const cdp = await context.newCDPSession(page);
      const browserVersion = (await cdp.send("Browser.getVersion")) as { userAgent: string };
      const session: BrowserSession = {
        workspaceId,
        sessionId: this.issueUniqueToken(),
        context,
        page,
        cdp,
        viewport: { ...DEFAULT_VIEWPORT },
        navigationGeneration: 0,
        viewportGeneration: 0,
        devicePresetId: null,
        userAgent: boundedText(browserVersion.userAgent, 512),
        defaultUserAgent: boundedText(browserVersion.userAgent, 512),
        viewers: new Map(),
        controller: null,
        mutationTail: Promise.resolve(),
        frameCache: new Map(),
        recentFrames: new Map(),
        latestScreencastFrame: null,
        screencastStarted: false,
        screencastWaiters: new Set(),
        lastUrl: boundedText(page.url(), 8_192),
        lastTitle: boundedText(await page.title(), 1_024),
        canGoBack: false,
        canGoForward: false,
        error: null,
        closing: false,
      };
      page.on("framenavigated", (frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        session.navigationGeneration += 1;
        session.lastUrl = boundedText(frame.url(), 8_192);
        this.invalidateFrames(session);
      });
      cdp.on("Page.screencastFrame", (event: ScreencastFrameEvent) => {
        this.handleScreencastFrame(session, event);
      });
      page.on("crash", () => {
        session.error = "Browser page crashed";
        this.invalidateFrames(session);
      });
      page.on("close", () => {
        if (!session.closing) session.error = "Browser page closed unexpectedly";
        this.invalidateFrames(session);
      });
      context.on("page", (openedPage: Page) => {
        if (openedPage !== page) void openedPage.close().catch(() => undefined);
      });
      context.on("close", () => {
        if (!session.closing) session.error = "Browser context closed unexpectedly";
        this.invalidateFrames(session);
      });

      await this.refreshPageMetadata(session);
      return session;
    } catch (error) {
      await context
        .close({ reason: "Shared browser session initialization failed" })
        .catch(() => {});
      throw error;
    }
  }

  private requireViewer(viewerToken: string): BrowserSession {
    const session = this.viewerSessions.get(viewerToken);
    if (!session || !session.viewers.has(viewerToken)) {
      throw new Error("Viewer token is invalid or expired");
    }
    return session;
  }

  private heartbeat(session: BrowserSession, viewerToken: string): void {
    this.pruneExpired(session);
    this.heartbeatViewer(session, viewerToken);
    if (session.controller?.viewerToken === viewerToken) {
      session.controller.expiresAt = this.now() + this.controlLeaseMs;
    }
  }

  private heartbeatViewer(session: BrowserSession, viewerToken: string): void {
    const viewer = session.viewers.get(viewerToken);
    if (!viewer) throw new Error("Viewer token is invalid or expired");
    viewer.expiresAt = this.now() + this.viewerTtlMs;
  }

  private pruneExpired(session: BrowserSession): void {
    const now = this.now();
    for (const [viewerToken, viewer] of session.viewers) {
      if (viewer.expiresAt > now) continue;
      session.viewers.delete(viewerToken);
      this.viewerSessions.delete(viewerToken);
    }
    if (
      session.controller &&
      (session.controller.expiresAt <= now || !session.viewers.has(session.controller.viewerToken))
    ) {
      session.controller = null;
    }
    if (session.viewers.size === 0) void this.stopScreencast(session);
  }

  private requireController(
    session: BrowserSession,
    viewerToken: string,
    controlToken: string,
  ): Controller {
    this.pruneExpired(session);
    const controller = session.controller;
    if (
      !controller ||
      controller.viewerToken !== viewerToken ||
      controller.controlToken !== controlToken
    ) {
      throw new Error("Browser control lease is invalid or expired");
    }
    return controller;
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
      };
    },
  ): void {
    this.requireViewer(input.viewerToken);
    this.requireController(session, input.viewerToken, input.controlToken);
    if (input.expected.sessionId !== session.sessionId) throw new Error("Browser session is stale");
    if (input.expected.navigationGeneration !== session.navigationGeneration) {
      throw new Error("Browser navigation state is stale");
    }
    if (input.expected.viewportGeneration !== session.viewportGeneration) {
      throw new Error("Browser viewport state is stale");
    }
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
    ) {
      throw new Error("Browser frame is stale");
    }
  }

  private renewController(session: BrowserSession, viewerToken: string): void {
    this.heartbeatViewer(session, viewerToken);
    const controller = session.controller;
    if (!controller || controller.viewerToken !== viewerToken) {
      throw new Error("Browser control lease is invalid or expired");
    }
    controller.expiresAt = this.now() + this.controlLeaseMs;
  }

  private assertUsable(session: BrowserSession): void {
    if (session.error) throw new Error(session.error);
    if (session.context.isClosed() || session.page.isClosed())
      throw new Error("Browser session is closed");
  }
  private issueUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.issueToken();
      if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error("Token issuer returned an invalid opaque token");
      }
      if (!this.tokenInUse(token)) return token;
    }
    throw new Error("Could not issue a unique opaque token");
  }
  private tokenInUse(token: string): boolean {
    if (this.viewerSessions.has(token)) return true;
    for (const session of this.sessions.values()) {
      this.pruneRecentFrames(session);
      if (session.sessionId === token || session.controller?.controlToken === token) return true;
      if (session.recentFrames.has(token)) return true;
    }
    return false;
  }

  private pruneRecentFrames(session: BrowserSession): void {
    const now = this.now();
    for (const [frameId, frame] of session.recentFrames) {
      if (frame.expiresAt <= now) session.recentFrames.delete(frameId);
    }
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
    session.latestScreencastFrame = null;
    session.frameCache.clear();
    session.recentFrames.clear();
  }

  private handleScreencastFrame(session: BrowserSession, event: ScreencastFrameEvent): void {
    void session.cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
    if (!session.screencastStarted || session.viewers.size === 0) return;
    const byteLength = Buffer.byteLength(event.data, "base64");
    const width = Math.round(event.metadata.deviceWidth);
    const height = Math.round(event.metadata.deviceHeight);
    if (
      byteLength < 1 ||
      byteLength > FRAME_MAX_BYTES ||
      width !== session.viewport.width ||
      height !== session.viewport.height
    ) {
      return;
    }
    const frame: BrowserFrame = {
      sessionId: session.sessionId,
      frameId: this.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: "cdp-screencast",
      dataBase64: event.data,
      byteLength,
      width,
      height,
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
      capturedAt: new Date(this.now()).toISOString(),
    };
    session.latestScreencastFrame = frame;
    this.resolveScreencastWaiters(session, frame);
  }

  private async ensureScreencastStarted(session: BrowserSession): Promise<void> {
    if (session.screencastStarted) return;
    session.screencastStarted = true;
    try {
      await session.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: SCREENCAST_QUALITY,
        maxWidth: MAX_VIEWPORT.width,
        maxHeight: MAX_VIEWPORT.height,
        everyNthFrame: 1,
      });
    } catch {
      session.screencastStarted = false;
    }
  }

  private async stopScreencast(session: BrowserSession): Promise<void> {
    const wasStarted = session.screencastStarted;
    session.screencastStarted = false;
    this.invalidateFrames(session);
    this.resolveScreencastWaiters(session, null);
    if (!wasStarted) return;
    await session.cdp.send("Page.stopScreencast").catch(() => undefined);
  }

  private resolveScreencastWaiters(session: BrowserSession, frame: BrowserFrame | null): void {
    const waiters = [...session.screencastWaiters];
    session.screencastWaiters.clear();
    for (const resolve of waiters) resolve(frame);
  }

  private waitForScreencastFrame(session: BrowserSession): Promise<BrowserFrame | null> {
    if (session.latestScreencastFrame) return Promise.resolve(session.latestScreencastFrame);
    const { promise, resolve } = Promise.withResolvers<BrowserFrame | null>();
    let timer: NodeJS.Timeout;
    const finish = (frame: BrowserFrame | null) => {
      clearTimeout(timer);
      session.screencastWaiters.delete(finish);
      resolve(frame);
    };
    session.screencastWaiters.add(finish);
    timer = setTimeout(() => finish(null), SCREENCAST_WAIT_MS);
    return promise;
  }

  private async frameForQuality(
    session: BrowserSession,
    quality: CaptureQuality,
  ): Promise<BrowserFrame> {
    this.assertUsable(session);
    await this.ensureScreencastStarted(session);
    const streamed = session.latestScreencastFrame ?? (await this.waitForScreencastFrame(session));
    if (
      streamed &&
      streamed.navigationGeneration === session.navigationGeneration &&
      streamed.viewportGeneration === session.viewportGeneration
    ) {
      return streamed;
    }
    const cached = session.frameCache.get(quality);
    if (
      cached &&
      cached.frame.navigationGeneration === session.navigationGeneration &&
      cached.frame.viewportGeneration === session.viewportGeneration &&
      this.now() - cached.cachedAt <= this.frameCacheMs
    ) {
      return cached.frame;
    }
    return this.captureFrame(session, quality);
  }

  private async captureFrame(
    session: BrowserSession,
    quality: CaptureQuality,
  ): Promise<BrowserFrame> {
    const navigationGeneration = session.navigationGeneration;
    const viewportGeneration = session.viewportGeneration;
    let image: Buffer | null = null;
    for (const jpegQuality of JPEG_QUALITIES[quality]) {
      const candidate = await session.page.screenshot({
        type: "jpeg",
        quality: jpegQuality,
        scale: "css",
        fullPage: false,
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      if (
        session.navigationGeneration !== navigationGeneration ||
        session.viewportGeneration !== viewportGeneration
      ) {
        throw new Error("Browser changed during capture; request another frame");
      }
      if (candidate.byteLength <= FRAME_MAX_BYTES) {
        image = candidate;
        break;
      }
    }
    if (!image) throw new Error(`Browser frame exceeds the ${FRAME_MAX_BYTES}-byte limit`);
    if (image.byteLength === 0) throw new Error("Browser returned an empty frame");

    const frame: BrowserFrame = {
      sessionId: session.sessionId,
      frameId: this.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: "screenshot",
      dataBase64: image.toString("base64"),
      byteLength: image.byteLength,
      width: session.viewport.width,
      height: session.viewport.height,
      navigationGeneration,
      viewportGeneration,
      capturedAt: new Date(this.now()).toISOString(),
    };
    this.rememberFrame(session, frame);
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
      if (oldest === undefined) break;
      session.recentFrames.delete(oldest);
    }
  }

  private async dispatchInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    target: InputTarget,
  ): Promise<void> {
    const assertTargetCurrent = () => this.requireRecentFrame(session, target);
    switch (event.kind) {
      case "click": {
        const point = mapDisplayedPoint(event.point, session.viewport);
        await session.page.mouse.move(point.x, point.y);
        assertTargetCurrent();
        for (let clickCount = 1; clickCount <= event.clickCount; clickCount += 1) {
          await session.page.mouse.down({ button: event.button, clickCount });
          try {
            assertTargetCurrent();
          } finally {
            await session.page.mouse.up({ button: event.button, clickCount });
          }
          if (clickCount < event.clickCount) assertTargetCurrent();
        }
        return;
      }
      case "move": {
        const point = mapDisplayedPoint(event.point, session.viewport);
        await session.page.mouse.move(point.x, point.y);
        return;
      }
      case "drag": {
        const start = mapDisplayedPoint(event.start, session.viewport);
        const end = mapDisplayedPoint(event.end, session.viewport);
        await session.page.mouse.move(start.x, start.y);
        assertTargetCurrent();
        await session.page.mouse.down({ button: event.button });
        try {
          assertTargetCurrent();
          await session.page.mouse.move(end.x, end.y, { steps: 10 });
          assertTargetCurrent();
        } finally {
          await session.page.mouse.up({ button: event.button });
        }
        return;
      }
      case "scroll": {
        const point = mapDisplayedPoint(event.point, session.viewport);
        await session.page.mouse.move(point.x, point.y);
        assertTargetCurrent();
        await session.page.mouse.wheel(event.deltaX, event.deltaY);
        return;
      }
      case "type":
        await session.page.keyboard.insertText(event.text);
        return;
      case "key":
        await session.page.keyboard.down(event.key);
        try {
          assertTargetCurrent();
        } finally {
          await session.page.keyboard.up(event.key);
        }
    }
  }

  private async refreshPageMetadata(session: BrowserSession): Promise<void> {
    session.lastUrl = boundedText(session.page.url(), 8_192);
    session.lastTitle = boundedText(await session.page.title(), 1_024);
    const history = (await session.cdp.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: unknown[];
    };
    session.canGoBack = history.currentIndex > 0;
    session.canGoForward = history.currentIndex < history.entries.length - 1;
  }

  private async snapshotState(session: BrowserSession, viewerToken: string): Promise<BrowserState> {
    this.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    if (!session.error) await this.refreshPageMetadata(session);

    const controller = session.controller;
    const controllerViewer = controller
      ? (session.viewers.get(controller.viewerToken) ?? null)
      : null;
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      status: session.error ? "error" : "ready",
      url: session.lastUrl,
      title: session.lastTitle,
      canGoBack: session.canGoBack,
      canGoForward: session.canGoForward,
      devicePresetId: session.devicePresetId,
      userAgent: session.userAgent,
      viewport: { ...session.viewport },
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
      controller: !controller ? "none" : controller.viewerToken === viewerToken ? "self" : "other",
      controllerLabel: controllerViewer?.label ?? null,
      controllerExpiresAt: controller ? new Date(controller.expiresAt).toISOString() : null,
      viewerCount: session.viewers.size,
      error: session.error,
    };
  }
}

export function createProductionSessionManager(
  options: ProductionSessionManagerOptions = {},
): SessionManager {
  return new SessionManager({
    stateRoot: options.stateRoot ?? defaultStateRoot(),
    validateWorkspace: options.validateWorkspace ?? (async () => undefined),
    maxSessions: options.maxSessions ?? MAX_SESSIONS,
  });
}

let productionManager: SessionManager | null = null;
let productionStopped = false;

function getProductionManager(): SessionManager {
  if (productionStopped) throw new Error("Shared Browser plugin is stopping");
  productionManager ??= createProductionSessionManager();
  return productionManager;
}

export async function handleAttachBrowser(
  input: AttachInput,
  context: PluginHandlerContext,
): Promise<AttachOutput> {
  const manager = getProductionManager();
  const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace) throw new Error("Workspace not found");
  return manager.attach(input.workspaceId, input.viewerLabel);
}

export function handleDetachBrowser({ viewerToken }: DetachInput): Promise<DetachOutput> {
  return getProductionManager().detach(viewerToken);
}

export async function handleWorkspaceArchived(workspaceId: string): Promise<void> {
  await productionManager?.archiveWorkspace(workspaceId);
}

export async function handleListOpenBrowserWorkspaces(): Promise<ListOpenOutput> {
  return { workspaceIds: await getProductionManager().listOpenWorkspaceIds() };
}

export function handleCaptureBrowser({
  viewerToken,
  quality,
  knownFrameId,
}: CaptureInput): Promise<CaptureOutput> {
  return getProductionManager().capture(viewerToken, quality, knownFrameId);
}

export function handleAcquireControl({
  viewerToken,
  takeover,
}: AcquireControlInput): Promise<AcquireControlOutput> {
  return getProductionManager().acquireControl(viewerToken, takeover);
}

export function handleReleaseControl({
  viewerToken,
  controlToken,
}: ReleaseControlInput): Promise<ReleaseControlOutput> {
  return getProductionManager().releaseControl(viewerToken, controlToken);
}

export function handleNavigateBrowser(input: NavigateInput): Promise<NavigateOutput> {
  return getProductionManager().navigate(input);
}

export function handleResizeBrowser(input: ResizeInput): Promise<ResizeOutput> {
  return getProductionManager().resize(input);
}

export function handleApplyDevicePreset(
  input: ApplyDevicePresetInput,
): Promise<ApplyDevicePresetOutput> {
  return getProductionManager().applyDevicePreset(input);
}

export function handleSendBrowserInput(input: SendInput): Promise<SendOutput> {
  return getProductionManager().sendInput(input);
}

export async function cleanupBrowserServer(): Promise<void> {
  productionStopped = true;
  const manager = productionManager;
  productionManager = null;
  await manager?.close();
}
