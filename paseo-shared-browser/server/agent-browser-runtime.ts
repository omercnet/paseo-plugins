import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { captureDimensions } from "../shared/capture-settings";
import { MAX_VIEWPORT } from "../shared/viewport-limits";
import {
  attachToTarget,
  CdpConnection,
  type CdpEvent,
  type CdpSession,
  type CdpTarget,
  CdpUnavailableError,
  CdpUnknownOutcomeError,
  listPageTargets,
} from "./cdp";
import { readJpegFrameDimensions } from "./jpeg-frame";

export { readJpegFrameDimensions as jpegDimensions } from "./jpeg-frame";

import {
  type BrowserCursor,
  type BrowserGestureKeyEvent,
  browserCursorSchema,
  browserGestureKeySchema,
} from "../shared/browser";
import { browserCursorExpression } from "./browser-cursor";
import { GESTURE_IDLE_MS, GESTURE_LIFETIME_MS } from "./browser-gesture";
import { formatRuntimeInputGeneration } from "./input-generation";
import { heldKeyModifiers, nativeKeyEvent } from "./keyboard-input";

const execFileAsync = promisify(execFile);
export const AGENT_BROWSER_VERSION = "0.37.1";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_TIMEOUT_MS = 15_000;
const SCREENCAST_SETUP_RETRY_MS = 25;

export class AgentBrowserUnavailableError extends Error {
  override readonly name = "AgentBrowserUnavailableError";
}

export class AgentBrowserIncompatibleError extends Error {
  override readonly name = "AgentBrowserIncompatibleError";
}

export { CdpUnknownOutcomeError as UnknownMutationOutcomeError };

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Image density is independent of CSS input geometry. */
  captureScale?: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
  platform?: string;
}

export interface RuntimeIdentity {
  agentBrowserVersion: string;
  browserProduct: string;
  browserRevision: string;
  userAgent: string;
  protocolVersion: string;
  processId: number | null;
  targetId: string;
}

export interface RuntimeHealth {
  ready: boolean;
  session: string;
  profilePath: string;
  targetCount: number;
  identity: RuntimeIdentity | null;
  error: string | null;
}

export interface RuntimeTarget extends CdpTarget {
  openerId?: string;
}

export interface RuntimePageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Process-local attachment/document revision, including same-URL reloads. */
  inputGeneration: string;
}

export interface RuntimeFrame {
  dataBase64: string;
  byteLength: number;
  width: number;
  height: number;
  transport: "cdp-screencast" | "screenshot";
  capturedAt: string;
}

export interface DeviceEmulation extends BrowserViewport {
  screenWidth?: number;
  screenHeight?: number;
}

export type MouseButton = "left" | "middle" | "right";

export interface AgentBrowserRuntimeOptions {
  binaryPath: string;
  executablePath: string;
  profilePath: string;
  ipcDirectory: string;
  session: string;
  initialUrl?: string;
  headed?: boolean;
  timeoutMs?: number;
}

interface VersionResult {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}
interface PageLifecycleEvent {
  name: string;
  loaderId: string;
}

interface ScreencastFrame {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
  sessionId: number;
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new AgentBrowserIncompatibleError(`${label} must be absolute`);
  return resolve(path);
}

function runtimeEnvironment(ipcDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.AGENT_BROWSER_SOCKET_DIR = ipcDirectory;
  environment.AGENT_BROWSER_IDLE_TIMEOUT_MS = "0";
  environment.AGENT_BROWSER_STREAM_PORT = "0";
  environment.AGENT_BROWSER_NO_AUTO_DIALOG = "1";
  return environment;
}

function parseJsonOutput(stdout: string): unknown {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new AgentBrowserIncompatibleError("agent-browser returned invalid JSON");
}

function findString(value: unknown, keys: readonly string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return null;
}

export class AgentBrowserRuntime {
  readonly binaryPath: string;
  readonly executablePath: string;
  readonly profilePath: string;
  readonly ipcDirectory: string;
  readonly session: string;
  private readonly initialUrl: string;
  private readonly headed: boolean;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private connection: CdpConnection | null = null;
  private page: CdpSession | null = null;
  private targetId: string | null = null;
  private viewport: DeviceEmulation | null = null;
  private emulationAppliedPage: CdpSession | null = null;
  private attachmentGeneration = 0;
  private captureGeneration = 0;
  private screencastFrame: RuntimeFrame | null = null;
  private screencastWaiters = new Set<(frame: RuntimeFrame | null) => void>();
  private screencastActive = false;
  private screencastQuality: number = 65;
  private heldButtons = new Set<MouseButton>();
  /** Last native pointer position sent, so cancelled drags release where they were. */
  private lastMousePoint = { x: 0, y: 0 };
  private heldKeys = new Map<string, { key: string; code: string }>();
  private heldTouches = false;
  /** Attachment on which the current held state was published; cleanup never targets another. */
  private heldOwner: CdpSession | null = null;
  private activeTouches = new Map<number, { x: number; y: number; id: number }>();
  private documentGeneration = 0;
  private liveInput: {
    id: string;
    page: CdpSession;
    generation: number;
    documentGeneration: number;
    idleUntil: number;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private stopping = false;

  constructor(options: AgentBrowserRuntimeOptions) {
    this.binaryPath = requireAbsolute(options.binaryPath, "agent-browser binary path");
    this.executablePath = requireAbsolute(options.executablePath, "Chromium executable path");
    this.profilePath = requireAbsolute(options.profilePath, "profile path");
    this.ipcDirectory = requireAbsolute(options.ipcDirectory, "IPC directory");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.session)) {
      throw new AgentBrowserIncompatibleError("agent-browser session name is invalid");
    }
    this.session = options.session;
    this.headed = options.headed ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.environment = runtimeEnvironment(this.ipcDirectory);
    this.initialUrl = options.initialUrl ?? "about:blank";
  }

  async launch(): Promise<void> {
    if (this.connection?.isOpen) return;
    this.invalidateScreencastFrame();
    this.stopping = false;
    await mkdir(this.profilePath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await mkdir(this.ipcDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await Promise.all([
      chmod(this.profilePath, PRIVATE_DIRECTORY_MODE),
      chmod(this.ipcDirectory, PRIVATE_DIRECTORY_MODE),
    ]);
    await this.assertVersion();
    const chromiumArguments = process.env.PASEO_SHARED_BROWSER_CHROMIUM_ARGS;
    const opened = await this.invoke([
      "--session",
      this.session,
      "--profile",
      this.profilePath,
      "--executable-path",
      this.executablePath,
      "--hide-scrollbars",
      "false",
      ...(this.headed ? ["--headed"] : []),
      ...(chromiumArguments ? ["--args", chromiumArguments] : []),
      "--json",
      "open",
      this.initialUrl,
    ]);
    const targetId = findString(opened, ["targetId", "target_id"]);
    await this.protectIpcMetadata();
    await this.connectCdp(targetId);
  }

  async reconnect(): Promise<void> {
    const targetId = this.targetId;
    this.attachmentGeneration += 1;
    this.invalidateScreencastFrame();
    this.connection?.close();
    this.connection = null;
    this.page = null;
    await this.assertVersion();
    await this.connectCdp(targetId);
  }

  async health(): Promise<RuntimeHealth> {
    try {
      if (!this.connection?.isOpen) await this.reconnect();
      const targets = await this.targets();
      return {
        ready: true,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: targets.length,
        identity: await this.identity(),
        error: null,
      };
    } catch (error) {
      return {
        ready: false,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: 0,
        identity: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async identity(): Promise<RuntimeIdentity> {
    const connection = this.requireConnection();
    const version = await connection.send<VersionResult>("Browser.getVersion");
    const processId = await this.daemonPid();
    const page = await this.requirePage();
    return {
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      browserProduct: version.product,
      browserRevision: version.revision,
      userAgent: version.userAgent,
      protocolVersion: version.protocolVersion,
      processId,
      targetId: page.targetId,
    };
  }

  async targets(): Promise<RuntimeTarget[]> {
    return listPageTargets(this.requireConnection());
  }

  async selectTarget(targetId: string): Promise<void> {
    const attachmentGeneration = ++this.attachmentGeneration;
    const connection = this.requireConnection();
    const target = (await this.targets()).find((candidate) => candidate.targetId === targetId);
    this.assertAttachmentCurrent(connection, attachmentGeneration);
    if (!target) throw new CdpUnavailableError(`Unknown page target: ${targetId}`);
    this.invalidateScreencastFrame();
    const previous = this.page;
    if (previous) {
      if (this.screencastActive) {
        await previous.send("Page.stopScreencast", {}, { mutation: true });
        this.assertAttachmentCurrent(connection, attachmentGeneration);
      }
      await previous.detach();
      this.assertAttachmentCurrent(connection, attachmentGeneration);
    }
    this.invalidateScreencastFrame();
    await connection.send("Target.activateTarget", { targetId }, { mutation: true });
    this.assertAttachmentCurrent(connection, attachmentGeneration);
    // CDP emulation is session-owned: detaching the former session restores native
    // window metrics. Publish a replacement only after its retained settings succeed.
    this.page = null;
    this.emulationAppliedPage = null;
    const replacement = await attachToTarget(connection, targetId);
    try {
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      await this.bindPageEvents(replacement);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      await this.restoreConfiguredEmulation(replacement);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      this.page = replacement;
      this.targetId = targetId;
    } catch (error) {
      await replacement.detach().catch(() => undefined);
      // Detaching a partial emulation can clear target metrics even if a newer
      // attachment won. Its next access must restore intent before admitting pixels.
      this.emulationAppliedPage = null;
      this.invalidateScreencastFrame();
      throw error;
    }
    if (this.screencastActive) await this.startScreencastSession(replacement);
  }

  private async navigationHistory(page: CdpSession): Promise<NavigationHistory> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        return await page.send<NavigationHistory>("Page.getNavigationHistory");
      } catch (error) {
        if (!String(error).includes("Not attached to an active page") || Date.now() >= deadline) {
          throw error;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
  }
  /** Read fresh metadata concurrently; never combine observations across native document changes. */
  async state(): Promise<RuntimePageState> {
    const page = await this.requirePage();
    const attachmentGeneration = this.attachmentGeneration;
    const documentGeneration = this.documentGeneration;
    // Native history and fixed DOM metadata are independent reads. Overlap their
    // CDP round trips without caching metadata or weakening input attachment checks.
    const [history, evaluated] = await Promise.all([
      this.navigationHistory(page),
      page.send<{
        result: { value?: { url?: string; title?: string } };
      }>("Runtime.evaluate", {
        expression: "({url: location.href, title: document.title})",
        returnByValue: true,
      }),
    ]);
    if (
      page !== this.page ||
      attachmentGeneration !== this.attachmentGeneration ||
      documentGeneration !== this.documentGeneration
    ) {
      throw new CdpUnavailableError("Browser metadata changed while being read");
    }
    return {
      url: evaluated.result.value?.url ?? history.entries[history.currentIndex]?.url ?? "",
      title: evaluated.result.value?.title ?? history.entries[history.currentIndex]?.title ?? "",
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
      inputGeneration: formatRuntimeInputGeneration(
        this.attachmentGeneration,
        this.documentGeneration,
      ),
    };
  }

  async navigate(url: string): Promise<void> {
    await this.withInvalidatedScreencast(async (page) => {
      await page.send("Page.setLifecycleEventsEnabled", { enabled: true });
      const observedLoaders = new Set<string>();
      const loaded = Promise.withResolvers<void>();
      let expectedLoaderId: string | undefined;
      const onLifecycle = (event: PageLifecycleEvent) => {
        if (event.name !== "DOMContentLoaded") return;
        if (expectedLoaderId === undefined) {
          observedLoaders.add(event.loaderId);
          return;
        }
        if (event.loaderId === expectedLoaderId) loaded.resolve();
      };
      page.on("Page.lifecycleEvent", onLifecycle);
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await page.send<{ errorText?: string; loaderId?: string }>(
          "Page.navigate",
          { url },
          { mutation: true, timeoutMs: 30_000 },
        );
        if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
        if (!result.loaderId) return;
        expectedLoaderId = result.loaderId;
        if (observedLoaders.has(expectedLoaderId)) return;
        timer = setTimeout(
          () =>
            loaded.reject(
              new CdpUnknownOutcomeError(
                "Page.navigate did not reach DOMContentLoaded; mutation outcome is unknown",
              ),
            ),
          30_000,
        );
        timer.unref();
        await loaded.promise;
      } finally {
        clearTimeout(timer);
        page.off("Page.lifecycleEvent", onLifecycle);
      }
    });
  }

  async back(): Promise<void> {
    await this.withInvalidatedScreencast(async (page) => {
      const history = await this.navigationHistory(page);
      const entry = history.entries[history.currentIndex - 1];
      if (!entry) throw new Error("Browser cannot go back");
      await page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { mutation: true });
    });
  }

  async forward(): Promise<void> {
    await this.withInvalidatedScreencast(async (page) => {
      const history = await this.navigationHistory(page);
      const entry = history.entries[history.currentIndex + 1];
      if (!entry) throw new Error("Browser cannot go forward");
      await page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { mutation: true });
    });
  }

  async reload(ignoreCache = false): Promise<void> {
    await this.withInvalidatedScreencast((page) =>
      page.send("Page.reload", { ignoreCache }, { mutation: true }),
    );
  }

  async emulate(device: DeviceEmulation): Promise<void> {
    this.assertViewport(device);
    await this.withInvalidatedScreencast(async (page) => {
      const attachmentGeneration = this.attachmentGeneration;
      this.emulationAppliedPage = null;
      await this.applyEmulation(page, device);
      this.assertAttachmentCurrent(page.connection, attachmentGeneration);
      if (this.page !== page)
        throw new CdpUnavailableError("Browser page changed during emulation");
      this.viewport = { ...device };
      this.emulationAppliedPage = page;
    });
  }

  /** Apply the entire device contract to one CDP session without changing saved intent. */
  private async applyEmulation(page: CdpSession, device: DeviceEmulation): Promise<void> {
    await page.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile: device.mobile,
        screenWidth: device.screenWidth ?? device.width,
        screenHeight: device.screenHeight ?? device.height,
        screenOrientation: {
          type: device.width > device.height ? "landscapePrimary" : "portraitPrimary",
          angle: device.width > device.height ? 90 : 0,
        },
      },
      { mutation: true },
    );
    await page.send(
      "Emulation.setTouchEmulationEnabled",
      { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 },
      { mutation: true },
    );
    if (device.userAgent) {
      await page.send(
        "Emulation.setUserAgentOverride",
        { userAgent: device.userAgent, platform: device.platform ?? "" },
        { mutation: true },
      );
    }
  }

  /** No frame/input may use a session whose emulated viewport has not been restored. */
  private async restoreConfiguredEmulation(page: CdpSession): Promise<void> {
    const device = this.viewport;
    if (!device || this.emulationAppliedPage === page) return;
    const attachmentGeneration = this.attachmentGeneration;
    this.invalidateScreencastFrame();
    this.emulationAppliedPage = null;
    await this.applyEmulation(page, device);
    this.assertAttachmentCurrent(page.connection, attachmentGeneration);
    if (device !== this.viewport) {
      throw new CdpUnavailableError("Browser device settings changed during restoration");
    }
    this.emulationAppliedPage = page;
    this.invalidateScreencastFrame();
  }

  /** Reject late configuration completions after a disconnect or newer target selection. */
  private assertAttachmentCurrent(connection: CdpConnection, generation: number): void {
    if (
      connection !== this.connection ||
      !connection.isOpen ||
      generation !== this.attachmentGeneration
    ) {
      throw new CdpUnavailableError("Browser attachment changed during emulation restoration");
    }
  }

  async startScreencast(quality: number = 65): Promise<void> {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new RangeError("Screencast quality must be an integer from 1 to 100");
    }
    this.screencastActive = true;
    this.screencastQuality = quality;
    const page = await this.requirePage();
    await this.startScreencastSession(page);
  }

  async stopScreencast(): Promise<void> {
    this.screencastActive = false;
    this.invalidateScreencastFrame();
    if (!this.page) return;
    try {
      await this.page.send("Page.stopScreencast", {}, { mutation: true });
    } finally {
      this.invalidateScreencastFrame();
    }
  }

  /** Capture only the current page and mutation generation; never return superseded pixels. */
  async frame(maxBytes: number, quality = 65, waitMs = 500): Promise<RuntimeFrame> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be positive");
    }
    if (!Number.isFinite(quality)) throw new RangeError("JPEG quality must be finite");
    const page = await this.requirePage();
    // Quality is a viewer choice; do not reuse the shared stream for a different request.
    if (quality !== this.screencastQuality) {
      return this.captureScreenshot(maxBytes, quality);
    }
    const generation = this.captureGeneration;
    const streamed = this.screencastFrame ?? (await this.waitForFrame(waitMs));
    this.assertCaptureCurrent(page, generation);
    if (streamed && streamed.byteLength <= maxBytes) return streamed;
    return this.captureScreenshot(maxBytes, quality);
  }

  /** Normalize screenshot pixels to the CSS viewport so native input targets the displayed geometry. */
  private async captureScreenshot(
    maxBytes: number,
    requestedQuality: number,
  ): Promise<RuntimeFrame> {
    const page = await this.requirePage();
    const screenshotGeneration = this.captureGeneration;
    const viewport = this.requireViewport();
    const expectedPixels = captureDimensions(viewport, viewport.captureScale);
    const readClip = async () => {
      const metrics = await page.send<{ cssVisualViewport: { pageX: number; pageY: number } }>(
        "Page.getLayoutMetrics",
      );
      this.assertCaptureCurrent(page, screenshotGeneration);
      return {
        x: metrics.cssVisualViewport.pageX,
        y: metrics.cssVisualViewport.pageY,
        width: viewport.width,
        height: viewport.height,
        scale: (viewport.captureScale ?? 1) / viewport.deviceScaleFactor,
      };
    };
    // Explicitly capture the visible CSS viewport, independent of the native window size.
    // Preserve scroll position and normalize device pixel ratio to the frame/input contract.
    let clip = await readClip();
    let resynced = false;
    // Reduce quality gradually only when a detailed frame exceeds the byte budget.
    const initialQuality = requestedQuality;
    const candidates = [...new Set([initialQuality, 50, 35, 20, 10, 1])].filter(
      (candidate) => candidate <= initialQuality,
    );
    const capture = async (quality: number) => {
      this.assertCaptureCurrent(page, screenshotGeneration);
      const result = await page.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        fromSurface: true,
        // Beyond-viewport capture replaces emulation and resets enabled touch.
        captureBeyondViewport: false,
        clip,
      });
      this.assertCaptureCurrent(page, screenshotGeneration);
      const dimensions = readJpegFrameDimensions(result.data);
      if (!dimensions) throw new Error("Chromium returned a malformed JPEG screenshot");
      return {
        data: result.data,
        dimensions,
        byteLength: Buffer.byteLength(result.data, "base64"),
      };
    };
    const matchesViewport = (dimensions: { width: number; height: number }) =>
      dimensions.width === expectedPixels.width && dimensions.height === expectedPixels.height;

    for (const candidate of candidates) {
      const boundedQuality = Math.max(1, Math.min(100, Math.round(candidate)));
      let pixels = await capture(boundedQuality);
      if (!matchesViewport(pixels.dimensions) && !resynced) {
        // Restore emulation once when Chromium returns inconsistent viewport pixels.
        // Recapture pixels only; uncertain input is never replayed.
        resynced = true;
        const attachmentGeneration = this.attachmentGeneration;
        await this.applyEmulation(page, viewport);
        this.assertAttachmentCurrent(page.connection, attachmentGeneration);
        this.assertCaptureCurrent(page, screenshotGeneration);
        if (viewport !== this.viewport)
          throw new CdpUnavailableError("Browser viewport changed during resync");
        this.emulationAppliedPage = page;
        clip = await readClip();
        pixels = await capture(boundedQuality);
      }
      if (!matchesViewport(pixels.dimensions)) {
        throw new Error(
          `Chromium returned a ${pixels.dimensions.width}x${pixels.dimensions.height} JPEG instead of ${expectedPixels.width}x${expectedPixels.height}`,
        );
      }
      if (pixels.byteLength > maxBytes) continue;

      const frame: RuntimeFrame = {
        dataBase64: pixels.data,
        byteLength: pixels.byteLength,
        width: pixels.dimensions.width,
        height: pixels.dimensions.height,
        transport: "screenshot",
        capturedAt: new Date().toISOString(),
      };
      return frame;
    }
    throw new Error(`JPEG screenshot exceeds ${maxBytes} bytes at minimum quality`);
  }

  /** Refuse async pixels from a superseded session or mutation, without silently replaying capture. */
  private assertCaptureCurrent(page: CdpSession, generation: number): void {
    if (page !== this.page || generation !== this.captureGeneration) {
      throw new CdpUnavailableError("Browser capture was invalidated while taking a screenshot");
    }
  }

  /** Invalidate pre-input pixels even if Chromium cannot confirm the mutation. */
  private async dispatchInput(
    method: string,
    params: Record<string, unknown>,
    gestureId?: string,
    track?: () => void,
  ): Promise<void> {
    try {
      const page = await this.requirePage();
      if (gestureId) await this.assertLiveInput(gestureId);
      // Authority is validated. Record cleanup intent only now, immediately before
      // native publication, so rejected unsent packets never alter it while an
      // uncertain acknowledgement still leaves it in place.
      if (track) {
        if (this.heldOwner && this.heldOwner !== page) this.discardHeldState();
        track();
        if (this.holdsInput()) this.heldOwner ??= page;
      }
      const originalInput = gestureId ? this.liveInput : null;
      const modifiers = heldKeyModifiers(this.heldKeys.values());
      const nativeParams =
        method === "Input.dispatchMouseEvent" && modifiers ? { ...params, modifiers } : params;
      await page.send(method, nativeParams, { mutation: true });
      if (gestureId) {
        // An input can synchronously activate a link or submit a form. Its CDP
        // acknowledgment succeeds even when navigation ends the old channel.
        // Attachment replacement and uncertain sends retain their failure path.
        if (
          originalInput &&
          page === this.page &&
          originalInput.generation === this.attachmentGeneration &&
          originalInput.documentGeneration !== this.documentGeneration
        ) {
          await this.endLiveInput(gestureId);
          return;
        }
        await this.assertLiveInput(gestureId);
        this.renewLiveInput(gestureId);
      }
    } finally {
      this.invalidateScreencastFrame();
    }
  }

  async mouseMove(x: number, y: number, gestureId?: string): Promise<void> {
    this.assertPoint(x, y);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
        // Native scrollbar dragging needs the held button as well as its mask.
        button: this.heldMoveButton(),
        buttons: this.buttonMask(),
      },
      gestureId,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
  }

  /** Fixed native mouse departure; never maps an outside point to a page control. */
  async mouseLeave(gestureId: string): Promise<void> {
    if (this.heldButtons.size > 0) throw new Error("Release held mouse buttons before leaving");
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: -1,
        y: -1,
        button: "none",
        buttons: 0,
      },
      gestureId,
    );
  }

  async mouseDown(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
  ): Promise<void> {
    this.assertPoint(x, y);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: this.buttonMask(button),
        clickCount,
      },
      gestureId,
      () => {
        // Publication may succeed before an acknowledgement is lost, so a
        // possibly held button is tracked from the send boundary.
        this.heldButtons.add(button);
        this.lastMousePoint = { x, y };
      },
    );
  }

  async mouseUp(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
  ): Promise<void> {
    this.assertPoint(x, y);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: this.buttonMask(undefined, button),
        clickCount,
      },
      gestureId,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
    this.heldButtons.delete(button);
  }

  async wheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    gestureId?: string,
  ): Promise<void> {
    this.assertPoint(x, y);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        button: "none",
        buttons: this.buttonMask(),
      },
      gestureId,
    );
  }

  /** Insert a committed paste/IME value on the original guarded attachment. */
  async insertText(text: string, gestureId?: string): Promise<void> {
    await this.dispatchInput("Input.insertText", { text }, gestureId);
  }

  /** Track cleanup intent before publication, including an uncertain key-down reply. */
  async dispatchKey(event: BrowserGestureKeyEvent, gestureId: string): Promise<void> {
    const parsed = browserGestureKeySchema.parse(event);
    await this.assertLiveInput(gestureId);
    const held = this.heldKeys.has(parsed.code);
    if (parsed.type === "down" && held !== parsed.repeat) {
      throw new Error(
        parsed.repeat ? "Key repeat has no matching press" : "Key is already pressed",
      );
    }
    if (parsed.type === "up" && !held) throw new Error("Key release has no matching press");
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      nativeKeyEvent(parsed),
      gestureId,
      parsed.type === "down"
        ? () => this.heldKeys.set(parsed.code, { key: parsed.key, code: parsed.code })
        : undefined,
    );
    if (parsed.type === "up") this.heldKeys.delete(parsed.code);
  }

  async keyDown(key: string, code = key, gestureId?: string): Promise<void> {
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key,
        code,
        text: key.length === 1 ? key : undefined,
      },
      gestureId,
      () => this.heldKeys.set(code, { key, code }),
    );
  }

  async keyUp(key: string, code = key, gestureId?: string): Promise<void> {
    await this.dispatchInput("Input.dispatchKeyEvent", { type: "keyUp", key, code }, gestureId);
    this.heldKeys.delete(code);
  }

  /**
   * The caller supplies the complete active contact set. CDP touchMove does not
   * release omitted contacts, so publish explicit contact ends before moving the
   * survivors. Any uncertain publication retains cleanup intent until cancel.
   */
  async touch(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: Array<{ x: number; y: number; id?: number }>,
    gestureId?: string,
  ): Promise<void> {
    for (const point of points) this.assertPoint(point.x, point.y);
    if (gestureId) await this.assertLiveInput(gestureId);
    const contacts = points.map((point, index) => ({ ...point, id: point.id ?? index }));
    const activeIds = new Set(contacts.map((point) => point.id));
    const removed =
      type === "touchMove"
        ? [...this.activeTouches.values()].filter((point) => !activeIds.has(point.id))
        : [];
    const hold = () => {
      this.heldTouches = true;
    };
    if (removed.length > 0) {
      await this.dispatchInput(
        "Input.dispatchTouchEvent",
        { type: "touchEnd", touchPoints: removed },
        gestureId,
        hold,
      );
    }
    await this.dispatchInput(
      "Input.dispatchTouchEvent",
      { type, touchPoints: contacts },
      gestureId,
      hold,
    );
    // Navigation cleanup already discarded this channel's contacts. Do not
    // recreate held-touch state after its acknowledged start caused navigation.
    if (gestureId && this.liveInput?.id !== gestureId) return;
    this.activeTouches.clear();
    if (type === "touchStart" || type === "touchMove") {
      for (const point of contacts) this.activeTouches.set(point.id, point);
    }
    this.heldTouches = this.activeTouches.size > 0;
  }

  /** Pin this channel to one CDP attachment. Reconnects never replay held input on a replacement. */
  async beginLiveInput(id: string): Promise<void> {
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
    const page = await this.requirePage();
    const now = Date.now();
    this.liveInput = {
      id,
      page,
      generation: this.attachmentGeneration,
      documentGeneration: this.documentGeneration,
      idleUntil: now + GESTURE_IDLE_MS,
      expiresAt: now + GESTURE_LIFETIME_MS,
      timer: null,
    };
    this.scheduleLiveInputExpiry();
  }

  /** Compare after every asynchronous transport boundary, including automatic reconnect/reattach. */
  async assertLiveInput(id: string): Promise<void> {
    const page = await this.requirePage();
    if (
      this.liveInput?.id === id &&
      (Date.now() >= this.liveInput.idleUntil || Date.now() >= this.liveInput.expiresAt)
    ) {
      await this.endLiveInput(id);
    }
    if (
      !this.liveInput ||
      this.liveInput.id !== id ||
      this.liveInput.page !== page ||
      this.liveInput.generation !== this.attachmentGeneration ||
      this.liveInput.documentGeneration !== this.documentGeneration
    ) {
      throw new CdpUnavailableError("Live browser input attachment changed");
    }
  }

  /** Cleanup is idempotent and targets the original attachment, never whatever is currently active. */
  async endLiveInput(id: string): Promise<void> {
    const current = this.liveInput;
    if (!current || current.id !== id) return;
    this.liveInput = null;
    if (current.timer) clearTimeout(current.timer);
    await this.releaseHeldInput(current.page);
  }

  /** Only acknowledged input extends idle time; metadata/checks cannot keep a stranded press alive. */
  private renewLiveInput(id: string): void {
    if (this.liveInput?.id !== id) return;
    this.liveInput.idleUntil = Date.now() + GESTURE_IDLE_MS;
    this.scheduleLiveInputExpiry();
  }

  /** Runtime-owned expiry survives plugin disconnect or a fenced supervisor IPC client. */
  private scheduleLiveInputExpiry(): void {
    const current = this.liveInput;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    const delay = Math.max(0, Math.min(current.idleUntil, current.expiresAt) - Date.now());
    current.timer = setTimeout(() => {
      if (this.liveInput !== current) return;
      void this.endLiveInput(current.id).catch(() => undefined);
    }, delay);
    current.timer.unref?.();
  }

  /** Fixed hit-test, safe cursor names only. Cursor failures cannot fail an acknowledged input. */
  async cursorAt(x: number, y: number, gestureId: string): Promise<BrowserCursor | null> {
    try {
      this.assertPoint(x, y);
      await this.assertLiveInput(gestureId);
      const page = this.liveInput!.page;
      const result = await page.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: browserCursorExpression(x, y),
        returnByValue: true,
      });
      await this.assertLiveInput(gestureId);
      const parsed = browserCursorSchema.safeParse(result.result.value);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private holdsInput(): boolean {
    return this.heldButtons.size > 0 || this.heldKeys.size > 0 || this.heldTouches;
  }

  /** Forget held state whose attachment is gone; it is never replayed on a replacement. */
  private discardHeldState(): void {
    this.heldButtons.clear();
    this.heldKeys.clear();
    this.heldTouches = false;
    this.activeTouches.clear();
    this.heldOwner = null;
  }

  /**
   * Release only what `page` itself holds. State published on another attachment
   * is left to that attachment's own cleanup, never retargeted here.
   */
  async releaseHeldInput(page = this.page): Promise<void> {
    if (!page) {
      this.discardHeldState();
      return;
    }
    if (this.heldOwner && this.heldOwner !== page) return;
    this.heldOwner = null;
    const buttons = [...this.heldButtons];
    const { x, y } = this.lastMousePoint;
    const keys = [...this.heldKeys.values()];
    this.heldButtons.clear();
    this.heldKeys.clear();
    const touchHeld = this.heldTouches;
    this.heldTouches = false;
    this.activeTouches.clear();
    await Promise.allSettled([
      ...(touchHeld
        ? [
            page.send(
              "Input.dispatchTouchEvent",
              { type: "touchCancel", touchPoints: [] },
              { mutation: true },
            ),
          ]
        : []),
      ...buttons.map((button) =>
        page.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: 0,
            clickCount: 1,
          },
          { mutation: true },
        ),
      ),
      ...keys.map(({ key, code }) =>
        page.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key,
            code,
          },
          { mutation: true },
        ),
      ),
    ]);
  }

  async shutdown(force = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
    await this.releaseHeldInput();
    this.invalidateScreencastFrame();
    if (!force) {
      try {
        await this.invoke(["--session", this.session, "--json", "close"]);
      } catch {
        this.stopping = false;
        await this.shutdown(true);
        return;
      }
    } else {
      const pid = await this.daemonPid();
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await this.removeIpcMetadata();
    }
    this.connection?.close();
    this.connection = null;
    this.page = null;
    this.targetId = null;
    this.invalidateScreencastFrame();
  }

  private async assertVersion(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, ["--version"], {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
      });
      const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
      if (version !== AGENT_BROWSER_VERSION) {
        throw new AgentBrowserIncompatibleError(
          `Expected agent-browser ${AGENT_BROWSER_VERSION}, received ${version ?? "unknown"}`,
        );
      }
    } catch (error) {
      if (error instanceof AgentBrowserIncompatibleError) throw error;
      throw new AgentBrowserUnavailableError(
        `agent-browser is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async invoke(arguments_: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, arguments_, {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & {
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };
      if (typed.killed) {
        throw new CdpUnknownOutcomeError("agent-browser command timed out; outcome is unknown");
      }
      console.error(
        "Shared Browser agent-browser command failed:",
        typed.stderr?.trim() || typed.stdout?.trim() || typed.message || "unknown error",
      );
      throw new AgentBrowserUnavailableError("agent-browser command failed");
    }
  }

  private async connectCdp(preferredTargetId: string | null = null): Promise<void> {
    const response = await this.invoke(["--session", this.session, "--json", "get", "cdp-url"]);
    const url = findString(response, ["cdpUrl", "cdp_url", "url"]);
    if (!url) throw new AgentBrowserIncompatibleError("agent-browser did not return a CDP URL");
    const endpoint = new URL(url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
      throw new AgentBrowserIncompatibleError("agent-browser exposed a non-loopback CDP endpoint");
    }
    const connection = await CdpConnection.connect(url, {
      commandTimeoutMs: this.timeoutMs,
      connectTimeoutMs: this.timeoutMs,
    });
    this.connection = connection;
    connection.once("disconnect", () => {
      if (this.connection !== connection) return;
      this.page = null;
      this.targetId = null;
      this.emulationAppliedPage = null;
      this.attachmentGeneration += 1;
      this.invalidateScreencastFrame();
    });
    const targets = await listPageTargets(this.connection);
    const target =
      targets.find((candidate) => candidate.targetId === preferredTargetId) ?? targets[0];
    if (!target) throw new CdpUnavailableError("Chromium has no page target");
    await this.selectTarget(target.targetId);
  }

  private async requirePage(): Promise<CdpSession> {
    if (this.page && this.connection?.isOpen) {
      const page = this.page;
      await this.restoreConfiguredEmulation(page);
      if (this.page !== page || !this.connection?.isOpen) {
        throw new CdpUnavailableError("Browser page changed during emulation restoration");
      }
      return page;
    }
    await this.reconnect();
    if (!this.page) throw new CdpUnavailableError("No page target is attached");
    return this.page;
  }

  private requireConnection(): CdpConnection {
    if (!this.connection?.isOpen) throw new CdpUnavailableError("Browser runtime is disconnected");
    return this.connection;
  }

  private requireViewport(): BrowserViewport {
    if (!this.viewport) throw new AgentBrowserIncompatibleError("Viewport has not been configured");
    return this.viewport;
  }

  private async bindPageEvents(page: CdpSession): Promise<void> {
    // URL equality is insufficient for reload. Main-document and same-document
    // navigation revoke the channel without treating child-frame loads as a reset.
    let rootFrameId: string | undefined;
    page.on("Page.frameNavigated", (event: { frame: { id: string; parentId?: string } }) => {
      if (page !== this.page || event.frame.parentId) return;
      rootFrameId = event.frame.id;
      this.documentGeneration += 1;
      void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
    });
    page.on("Page.navigatedWithinDocument", (event: { frameId: string }) => {
      if (page !== this.page || event.frameId !== rootFrameId) return;
      this.documentGeneration += 1;
      void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
    });
    page.on("Page.screencastFrame", (event: ScreencastFrame) =>
      this.onScreencastFrame(page, event),
    );
    page.on("event", (event: CdpEvent) => {
      if (event.method === "Inspector.targetCrashed" && this.page === page) {
        this.documentGeneration += 1;
        void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
        this.emulationAppliedPage = null;
        this.invalidateScreencastFrame();
      }
    });
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
    const tree = await page.send<{ frameTree?: { frame: { id: string } } }>("Page.getFrameTree");
    rootFrameId = tree.frameTree?.frame.id ?? rootFrameId;
    await this.navigationHistory(page);
  }

  private async startScreencastSession(page: CdpSession): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let candidate = page;
    for (;;) {
      try {
        await Promise.all([candidate.send("Page.enable"), candidate.send("Runtime.enable")]);
        await this.navigationHistory(candidate);
        if (this.page !== candidate) {
          candidate = await this.requirePage();
          continue;
        }
        await this.restoreConfiguredEmulation(candidate);
        if (this.page !== candidate) {
          throw new CdpUnavailableError("Browser page changed before screencast start");
        }
        await candidate.send(
          "Page.startScreencast",
          { format: "jpeg", quality: this.screencastQuality, everyNthFrame: 1 },
          { mutation: true },
        );
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        try {
          candidate = await this.reattachPageForScreencast(candidate);
        } catch (reattachError) {
          if (Date.now() >= deadline) throw reattachError;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, SCREENCAST_SETUP_RETRY_MS);
        await promise;
      }
    }
  }

  private async reattachPageForScreencast(previous: CdpSession): Promise<CdpSession> {
    if (this.page !== previous) {
      if (!this.page) throw new CdpUnavailableError("Browser page changed during reattachment");
      return this.page;
    }
    const attachmentGeneration = ++this.attachmentGeneration;
    const connection = this.requireConnection();
    const targets = await listPageTargets(connection);
    this.assertAttachmentCurrent(connection, attachmentGeneration);
    const target = targets.find((candidate) => candidate.targetId === this.targetId) ?? targets[0];
    if (!target) throw new CdpUnavailableError("Chromium has no page target");
    await connection.send(
      "Target.activateTarget",
      { targetId: target.targetId },
      { mutation: true },
    );
    this.assertAttachmentCurrent(connection, attachmentGeneration);
    const replacement = await attachToTarget(connection, target.targetId);
    if (this.page !== previous || attachmentGeneration !== this.attachmentGeneration) {
      await replacement.detach().catch(() => undefined);
      // The losing controller's detach may clear target overrides. Repair the
      // current controller on its next access rather than trust earlier pixels.
      this.emulationAppliedPage = null;
      this.invalidateScreencastFrame();
      if (!this.page) throw new CdpUnavailableError("Browser page changed during reattachment");
      return this.page;
    }
    this.assertAttachmentCurrent(connection, attachmentGeneration);

    this.invalidateScreencastFrame();
    // Detaching drops the session that holds any pressed button; release there first.
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
    await this.releaseHeldInput(previous);
    this.page = null;
    this.emulationAppliedPage = null;
    // Detach first: the former session can otherwise clear the newly applied override.
    try {
      await previous.detach();
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      await this.bindPageEvents(replacement);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      await this.restoreConfiguredEmulation(replacement);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      this.page = replacement;
      this.targetId = target.targetId;
      return replacement;
    } catch (error) {
      await replacement.detach().catch(() => undefined);
      // Detaching a partial emulation can clear target metrics even if a newer
      // attachment won. Its next access must restore intent before admitting pixels.
      this.emulationAppliedPage = null;
      this.invalidateScreencastFrame();
      throw error;
    }
  }

  private async withInvalidatedScreencast(
    mutation: (page: CdpSession) => Promise<unknown>,
  ): Promise<void> {
    const page = await this.requirePage();
    const restart = this.screencastActive;
    this.invalidateScreencastFrame();
    if (restart) await page.send("Page.stopScreencast", {}, { mutation: true });
    try {
      await mutation(page);
    } finally {
      this.invalidateScreencastFrame();
      if (restart && this.page === page) {
        await this.restoreConfiguredEmulation(page);
        await this.startScreencastSession(page);
      }
    }
  }

  /** Clear both sources and revoke every in-flight capture after input or transport changes. */
  private invalidateScreencastFrame(): void {
    this.captureGeneration += 1;
    this.screencastFrame = null;
    this.resolveFrameWaiters(null);
  }

  private onScreencastFrame(page: CdpSession, event: ScreencastFrame): void {
    // A late frame belongs to its emitting session, even after page reattachment.
    void page
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
    if (page !== this.page || !this.screencastActive || this.emulationAppliedPage !== page) return;
    const dimensions = readJpegFrameDimensions(event.data);
    const viewport = this.viewport;
    // Chromium can report the new device dimensions while emitting a clipped transition image.
    // Reject those pixels and use the bounded screenshot fallback rather than mislabeling them.
    if (!viewport || !dimensions) return;
    const expectedPixels = captureDimensions(viewport, viewport.captureScale);
    if (dimensions.width !== expectedPixels.width || dimensions.height !== expectedPixels.height)
      return;
    const { width, height } = dimensions;
    const frame: RuntimeFrame = {
      dataBase64: event.data,
      byteLength: Buffer.byteLength(event.data, "base64"),
      width,
      height,
      transport: "cdp-screencast",
      capturedAt: new Date().toISOString(),
    };
    this.screencastFrame = frame;
    this.resolveFrameWaiters(frame);
  }

  private waitForFrame(waitMs: number): Promise<RuntimeFrame | null> {
    const { promise, resolve } = Promise.withResolvers<RuntimeFrame | null>();
    const timer = setTimeout(() => {
      this.screencastWaiters.delete(done);
      resolve(null);
    }, waitMs);
    const done = (frame: RuntimeFrame | null): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    this.screencastWaiters.add(done);
    return promise;
  }

  private resolveFrameWaiters(frame: RuntimeFrame | null): void {
    const waiters = [...this.screencastWaiters];
    this.screencastWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter(frame);
  }

  private assertViewport(viewport: BrowserViewport): void {
    const captureScale = viewport.captureScale ?? 1;
    const pixels = captureDimensions(viewport, captureScale);
    if (
      !Number.isFinite(captureScale) ||
      captureScale < 1 ||
      captureScale > 2 ||
      pixels.width > MAX_VIEWPORT.width ||
      pixels.height > MAX_VIEWPORT.height
    ) {
      throw new RangeError("Capture density exceeds the supported image bounds");
    }
    if (
      !Number.isInteger(viewport.width) ||
      viewport.width < 1 ||
      viewport.width > 16_384 ||
      !Number.isInteger(viewport.height) ||
      viewport.height < 1 ||
      viewport.height > 16_384 ||
      !Number.isFinite(viewport.deviceScaleFactor) ||
      viewport.deviceScaleFactor <= 0 ||
      viewport.deviceScaleFactor > 10
    )
      throw new RangeError("Invalid viewport emulation values");
  }

  private assertPoint(x: number, y: number): void {
    const viewport = this.requireViewport();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > viewport.width ||
      y > viewport.height
    ) {
      throw new RangeError("Input coordinates are outside the CSS viewport");
    }
  }

  /** CDP/Puppeteer priority for supported held buttons, independent of press order.
   * https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Input.ts
   */
  private heldMoveButton(): MouseButton | "none" {
    for (const button of ["left", "right", "middle"] as const) {
      if (this.heldButtons.has(button)) {
        return button;
      }
    }
    return "none";
  }

  private buttonMask(add?: MouseButton, remove?: MouseButton): number {
    const active = new Set(this.heldButtons);
    if (add) active.add(add);
    if (remove) active.delete(remove);
    return (
      (active.has("left") ? 1 : 0) | (active.has("right") ? 2 : 0) | (active.has("middle") ? 4 : 0)
    );
  }

  private async daemonPid(): Promise<number | null> {
    try {
      const value = await readFile(resolve(this.ipcDirectory, `${this.session}.pid`), "utf8");
      const pid = Number.parseInt(value.trim(), 10);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async protectIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => chmod(path, PRIVATE_FILE_MODE).catch(() => undefined)),
    );
  }

  private async removeIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream", "engine", "provider", "extensions"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => rm(path, { force: true }).catch(() => undefined)),
    );
  }
}
