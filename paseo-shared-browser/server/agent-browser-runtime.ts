import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CdpConnection,
  CdpSession,
  CdpUnavailableError,
  CdpUnknownOutcomeError,
  attachToTarget,
  listPageTargets,
  type CdpEvent,
  type CdpTarget,
} from "./cdp";

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
  metadata: { deviceWidth: number; deviceHeight: number };
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
    } catch {
      continue;
    }
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
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private connection: CdpConnection | null = null;
  private page: CdpSession | null = null;
  private targetId: string | null = null;
  private viewport: BrowserViewport | null = null;
  private screencastFrame: RuntimeFrame | null = null;
  private screencastWaiters = new Set<(frame: RuntimeFrame | null) => void>();
  private screencastActive = false;
  private screencastQuality = 65;
  private heldButtons = new Set<MouseButton>();
  private heldKeys = new Set<string>();
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
    const opened = await this.invoke([
      "--session",
      this.session,
      "--profile",
      this.profilePath,
      "--executable-path",
      this.executablePath,
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
    const target = (await this.targets()).find((candidate) => candidate.targetId === targetId);
    if (!target) throw new CdpUnavailableError(`Unknown page target: ${targetId}`);
    this.invalidateScreencastFrame();
    if (this.page) {
      if (this.screencastActive) {
        await this.page.send("Page.stopScreencast", {}, { mutation: true });
      }
      await this.page.detach();
    }
    this.invalidateScreencastFrame();
    await this.requireConnection().send("Target.activateTarget", { targetId }, { mutation: true });
    this.page = await attachToTarget(this.requireConnection(), targetId);
    this.targetId = targetId;
    await this.bindPageEvents(this.page);
    if (this.screencastActive) await this.startScreencastSession(this.page);
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
  async state(): Promise<RuntimePageState> {
    const page = await this.requirePage();
    const history = await this.navigationHistory(page);
    const evaluated = await page.send<{
      result: { value?: { url?: string; title?: string } };
    }>("Runtime.evaluate", {
      expression: "({url: location.href, title: document.title})",
      returnByValue: true,
    });
    return {
      url: evaluated.result.value?.url ?? history.entries[history.currentIndex]?.url ?? "",
      title: evaluated.result.value?.title ?? history.entries[history.currentIndex]?.title ?? "",
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
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
      this.viewport = { ...device };
    });
  }

  async startScreencast(quality = 65): Promise<void> {
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

  async frame(maxBytes: number, quality = 65, waitMs = 500): Promise<RuntimeFrame> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("maxBytes must be positive");
    const streamed = this.screencastFrame ?? (await this.waitForFrame(waitMs));
    if (streamed && streamed.byteLength <= maxBytes) return streamed;
    const page = await this.requirePage();
    for (const candidate of [quality, 50, 35, 20, 10, 1]) {
      const boundedQuality = Math.max(1, Math.min(100, Math.round(candidate)));
      const result = await page.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: boundedQuality,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const byteLength = Buffer.byteLength(result.data, "base64");
      if (byteLength <= maxBytes) {
        const viewport = this.requireViewport();
        return {
          dataBase64: result.data,
          byteLength,
          width: viewport.width,
          height: viewport.height,
          transport: "screenshot",
          capturedAt: new Date().toISOString(),
        };
      }
    }
    throw new Error(`JPEG screenshot exceeds ${maxBytes} bytes at minimum quality`);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    this.assertPoint(x, y);
    await (
      await this.requirePage()
    ).send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: this.buttonMask(),
      },
      { mutation: true },
    );
  }

  async mouseDown(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
  ): Promise<void> {
    this.assertPoint(x, y);
    await (
      await this.requirePage()
    ).send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: this.buttonMask(button),
        clickCount,
      },
      { mutation: true },
    );
    this.heldButtons.add(button);
  }

  async mouseUp(x: number, y: number, button: MouseButton = "left", clickCount = 1): Promise<void> {
    this.assertPoint(x, y);
    await (
      await this.requirePage()
    ).send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: this.buttonMask(undefined, button),
        clickCount,
      },
      { mutation: true },
    );
    this.heldButtons.delete(button);
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    this.assertPoint(x, y);
    await (
      await this.requirePage()
    ).send(
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
      { mutation: true },
    );
  }

  async insertText(text: string): Promise<void> {
    await (await this.requirePage()).send("Input.insertText", { text }, { mutation: true });
  }

  async keyDown(key: string, code = key): Promise<void> {
    await (
      await this.requirePage()
    ).send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key,
        code,
        text: key.length === 1 ? key : undefined,
      },
      { mutation: true },
    );
    this.heldKeys.add(key);
  }

  async keyUp(key: string, code = key): Promise<void> {
    await (
      await this.requirePage()
    ).send("Input.dispatchKeyEvent", { type: "keyUp", key, code }, { mutation: true });
    this.heldKeys.delete(key);
  }

  async touch(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: Array<{ x: number; y: number; id?: number }>,
  ): Promise<void> {
    for (const point of points) this.assertPoint(point.x, point.y);
    await (
      await this.requirePage()
    ).send(
      "Input.dispatchTouchEvent",
      {
        type,
        touchPoints: points.map((point, index) => ({
          x: point.x,
          y: point.y,
          id: point.id ?? index,
        })),
      },
      { mutation: true },
    );
  }

  async releaseHeldInput(): Promise<void> {
    const page = this.page;
    if (!page) {
      this.heldButtons.clear();
      this.heldKeys.clear();
      return;
    }
    const buttons = [...this.heldButtons];
    const keys = [...this.heldKeys];
    this.heldButtons.clear();
    this.heldKeys.clear();
    await Promise.allSettled([
      ...buttons.map((button) =>
        page.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: 0,
            y: 0,
            button,
            buttons: 0,
            clickCount: 1,
          },
          { mutation: true },
        ),
      ),
      ...keys.map((key) =>
        page.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key,
            code: key,
          },
          { mutation: true },
        ),
      ),
    ]);
  }

  async shutdown(force = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.releaseHeldInput();
    this.invalidateScreencastFrame();
    if (!force) {
      try {
        await this.invoke(["--session", this.session, "--json", "close"]);
      } catch (error) {
        this.stopping = false;
        throw error;
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
      this.invalidateScreencastFrame();
    });
    const targets = await listPageTargets(this.connection);
    const target =
      targets.find((candidate) => candidate.targetId === preferredTargetId) ?? targets[0];
    if (!target) throw new CdpUnavailableError("Chromium has no page target");
    await this.selectTarget(target.targetId);
  }

  private async requirePage(): Promise<CdpSession> {
    if (this.page && this.connection?.isOpen) return this.page;
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
    page.on("Page.screencastFrame", this.onScreencastFrame);
    page.on("event", (event: CdpEvent) => {
      if (event.method === "Inspector.targetCrashed") this.invalidateScreencastFrame();
    });
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
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
    const connection = this.requireConnection();
    const targets = await listPageTargets(connection);
    const target = targets.find((candidate) => candidate.targetId === this.targetId) ?? targets[0];
    if (!target) throw new CdpUnavailableError("Chromium has no page target");
    await connection.send(
      "Target.activateTarget",
      { targetId: target.targetId },
      { mutation: true },
    );
    const replacement = await attachToTarget(connection, target.targetId);
    await this.bindPageEvents(replacement);
    if (this.page === previous) {
      this.page = replacement;
      this.targetId = target.targetId;
    } else {
      await replacement.detach().catch(() => undefined);
    }
    await previous.detach().catch(() => undefined);
    return this.page ?? replacement;
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
      if (restart && this.page === page) await this.startScreencastSession(page);
    }
  }

  private invalidateScreencastFrame(): void {
    this.screencastFrame = null;
    this.resolveFrameWaiters(null);
  }

  private readonly onScreencastFrame = (event: ScreencastFrame): void => {
    void this.page
      ?.send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
    const width = Math.round(event.metadata.deviceWidth);
    const height = Math.round(event.metadata.deviceHeight);
    const viewport = this.viewport;
    if (!viewport || width !== viewport.width || height !== viewport.height) return;
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
  };

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
