import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../server/browser";
class FakePage extends EventEmitter {
  navigateOnMouseDown = false;
  mouseUpCalls = 0;
  screenshotCalls = 0;
  readonly mouse = {
    click: async () => undefined,
    move: async () => undefined,
    down: async () => {
      if (this.navigateOnMouseDown) {
        this.currentUrl = "https://navigated.example/";
        this.emit("framenavigated", this.frame);
      }
    },
    up: async () => {
      this.mouseUpCalls += 1;
    },
    wheel: async () => undefined,
  };
  readonly keyboard = {
    insertText: async () => undefined,
    press: async () => undefined,
  };
  private readonly frame = { url: () => this.currentUrl };
  private currentUrl = "about:blank";
  private closed = false;

  url() {
    return this.currentUrl;
  }

  async title() {
    return "Shared test page";
  }

  mainFrame() {
    return this.frame;
  }

  setDefaultTimeout() {}

  setDefaultNavigationTimeout() {}

  async goto(url: string) {
    this.currentUrl = url;
    this.emit("framenavigated", this.frame);
    return null;
  }

  async goBack() {
    return null;
  }

  async goForward() {
    return null;
  }

  async reload() {
    this.emit("framenavigated", this.frame);
    return null;
  }

  async setViewportSize() {}

  async screenshot() {
    this.screenshotCalls += 1;
    return Buffer.from("bounded-jpeg-frame");
  }

  isClosed() {
    return this.closed;
  }

  markClosed() {
    this.closed = true;
    this.emit("close");
  }
}

class FakeCDPSession extends EventEmitter {
  started = false;
  acknowledgements = 0;
  failStart = false;
  private frameSessionId = 0;
  readonly methods: string[] = [];
  lastUserAgent: string | null = null;

  emitFrame(content = "streamed-jpeg-frame") {
    if (!this.started) return;
    this.frameSessionId += 1;
    this.emit("Page.screencastFrame", {
      data: Buffer.from(content).toString("base64"),
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
      sessionId: this.frameSessionId,
    });
  }
  async send(method: string, params?: Record<string, unknown>) {
    this.methods.push(method);
    if (method === "Browser.getVersion") return { userAgent: "Fake Chromium" };
    if (method === "Emulation.setUserAgentOverride") {
      this.lastUserAgent = typeof params?.userAgent === "string" ? params.userAgent : null;
      return {};
    }
    if (method.startsWith("Emulation.")) return {};
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
    if (method === "Page.startScreencast") {
      if (this.failStart) throw new Error("Screencast unavailable");
      this.started = true;
      queueMicrotask(() => this.emitFrame());
      return {};
    }
    if (method === "Page.stopScreencast") {
      this.started = false;
      return {};
    }
    if (method === "Page.screencastFrameAck") {
      this.acknowledgements += 1;
      return {};
    }
    return {};
  }
}
class FakeContext extends EventEmitter {
  readonly page = new FakePage();
  readonly cdp = new FakeCDPSession();
  closed = false;

  pages() {
    return [this.page as unknown as Page];
  }

  async newPage() {
    return this.page as unknown as Page;
  }

  async newCDPSession() {
    return this.cdp;
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closed = true;
    this.page.markClosed();
    this.emit("close");
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createManager(
  options: {
    now?: () => number;
    frameCacheMs?: number;
    maxSessions?: number;
    screencast?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "shared-browser-unit-"));
  roots.push(root);
  let token = 0;
  const contexts: FakeContext[] = [];
  const manager = new SessionManager({
    stateRoot: root,
    validateWorkspace: async (workspaceId) => workspaceId.startsWith("workspace-"),
    launchPersistentContext: async () => {
      const context = new FakeContext();
      context.cdp.failStart = options.screencast === false;
      contexts.push(context);
      return context as unknown as BrowserContext;
    },
    issueToken: () => `token_${String(++token).padStart(40, "0")}`,
    ...(options.now ? { now: options.now } : {}),
    ...(options.frameCacheMs === undefined ? {} : { frameCacheMs: options.frameCacheMs }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    controlLeaseMs: 1_000,
    viewerTtlMs: 10_000,
  });
  return { manager, contexts };
}
describe("SessionManager control leases", () => {
  it("shares one session, excludes a second controller, and supports explicit takeover", async () => {
    const { manager, contexts } = await createManager();
    const first = await manager.attach("workspace-one", "First client");
    const second = await manager.attach("workspace-one", "Second client");

    expect(first.state.sessionId).toBe(second.state.sessionId);
    expect(second.state.viewerCount).toBe(2);
    expect(contexts).toHaveLength(1);
    expect(first.state.url).toBe("https://paseo.sh/");

    const firstControl = await manager.acquireControl(first.viewerToken, false);
    await expect(manager.acquireControl(second.viewerToken, false)).rejects.toThrow(
      "held by another viewer",
    );
    const secondControl = await manager.acquireControl(second.viewerToken, true);
    expect(secondControl.state.controller).toBe("self");

    await expect(
      manager.navigate({
        viewerToken: first.viewerToken,
        controlToken: firstControl.controlToken,
        expected: {
          sessionId: first.state.sessionId,
          navigationGeneration: firstControl.state.navigationGeneration,
          viewportGeneration: firstControl.state.viewportGeneration,
        },
        action: { kind: "reload" },
      }),
    ).rejects.toThrow("lease is invalid or expired");

    await manager.close();
    expect(contexts[0]?.closed).toBe(true);
    await expect(manager.capture(first.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("closes an in-flight archive target without deleting its profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-browser-unit-"));
    roots.push(root);
    const workspaceId = "workspace-archive-race";
    const profilePath = join(root, createHash("sha256").update(workspaceId).digest("hex"));
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const contexts: FakeContext[] = [];
    const manager = new SessionManager({
      stateRoot: root,
      validateWorkspace: async (id) => id === workspaceId,
      launchPersistentContext: async () => {
        const context = new FakeContext();
        contexts.push(context);
        await launchGate;
        return context as unknown as BrowserContext;
      },
    });

    const attaching = manager.attach(workspaceId, "First client");
    await vi.waitFor(() => expect(contexts).toHaveLength(1));

    const archiving = manager.archiveWorkspace(workspaceId);
    releaseLaunch();

    await expect(attaching).rejects.toThrow("archived");
    await expect(archiving).resolves.toBeUndefined();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.closed).toBe(true);
    expect((await stat(profilePath)).isDirectory()).toBe(true);

    const reopened = await manager.attach(workspaceId, "Second client");
    expect(reopened.state.workspaceId).toBe(workspaceId);
    expect(contexts).toHaveLength(2);

    await manager.archiveWorkspace(workspaceId);
    await manager.archiveWorkspace(workspaceId);
    expect(contexts[1]!.closed).toBe(true);
    expect((await stat(profilePath)).isDirectory()).toBe(true);

    await manager.close();
  });

  it("expires an abandoned controller without replaying its authority", async () => {
    let now = 1_000;
    const { manager } = await createManager({ now: () => now });
    const viewer = await manager.attach("workspace-one", "Client");
    await manager.acquireControl(viewer.viewerToken, false);
    now += 1_001;

    const capture = await manager.capture(viewer.viewerToken, "medium", null);
    expect(capture.state.controller).toBe("none");
    await manager.close();
  });

  it("accepts a recent frame from another viewer but rejects it after viewport invalidation", async () => {
    let now = 1_000;
    const { manager, contexts } = await createManager({ now: () => now, frameCacheMs: 0 });
    const first = await manager.attach("workspace-one", "First client");
    const second = await manager.attach("workspace-one", "Second client");
    const control = await manager.acquireControl(first.viewerToken, false);
    const firstFrame = (await manager.capture(first.viewerToken, "medium", null)).frame;
    expect(firstFrame).not.toBeNull();

    now += 1;
    contexts[0]!.cdp.emitFrame("second-streamed-frame");
    const secondFrame = (await manager.capture(second.viewerToken, "medium", null)).frame;
    expect(secondFrame?.frameId).not.toBe(firstFrame?.frameId);

    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: control.controlToken,
        expected: {
          sessionId: control.state.sessionId,
          navigationGeneration: control.state.navigationGeneration,
          viewportGeneration: control.state.viewportGeneration,
        },
        target: {
          frameId: firstFrame!.frameId,
          navigationGeneration: firstFrame!.navigationGeneration,
          viewportGeneration: firstFrame!.viewportGeneration,
        },
        event: {
          kind: "click",
          point: { x: 50, y: 25, width: 100, height: 50 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).resolves.toBeDefined();

    const current = await manager.capture(first.viewerToken, "medium", null);
    const resized = await manager.resize({
      viewerToken: first.viewerToken,
      controlToken: control.controlToken,
      expected: {
        sessionId: current.state.sessionId,
        navigationGeneration: current.state.navigationGeneration,
        viewportGeneration: current.state.viewportGeneration,
      },
      viewport: { width: 1024, height: 768 },
    });
    expect(resized.state.viewport).toEqual({ width: 1024, height: 768 });

    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: control.controlToken,
        expected: {
          sessionId: resized.state.sessionId,
          navigationGeneration: resized.state.navigationGeneration,
          viewportGeneration: resized.state.viewportGeneration,
        },
        target: {
          frameId: firstFrame!.frameId,
          navigationGeneration: firstFrame!.navigationGeneration,
          viewportGeneration: firstFrame!.viewportGeneration,
        },
        event: {
          kind: "click",
          point: { x: 50, y: 25, width: 100, height: 50 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).rejects.toThrow("frame is stale");

    await manager.close();
  });

  it("stops a compound gesture and releases input when navigation intervenes", async () => {
    const { manager, contexts } = await createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const capture = await manager.capture(viewer.viewerToken, "medium", null);
    expect(capture.frame).not.toBeNull();
    contexts[0]!.page.navigateOnMouseDown = true;

    await expect(
      manager.sendInput({
        viewerToken: viewer.viewerToken,
        controlToken: control.controlToken,
        expected: {
          sessionId: capture.state.sessionId,
          navigationGeneration: capture.state.navigationGeneration,
          viewportGeneration: capture.state.viewportGeneration,
        },
        target: {
          frameId: capture.frame!.frameId,
          navigationGeneration: capture.frame!.navigationGeneration,
          viewportGeneration: capture.frame!.viewportGeneration,
        },
        event: {
          kind: "drag",
          start: { x: 10, y: 10, width: 640, height: 400 },
          end: { x: 50, y: 50, width: 640, height: 400 },
          button: "left",
        },
      }),
    ).rejects.toThrow("frame is stale");
    expect(contexts[0]!.page.mouseUpCalls).toBe(1);
    await manager.close();
  });

  it("cannot create a browser after cleanup begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-browser-unit-"));
    roots.push(root);
    let resolveValidation!: (valid: boolean) => void;
    let markValidationStarted: (() => void) | null = null;
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    const contexts: FakeContext[] = [];
    const manager = new SessionManager({
      stateRoot: root,
      validateWorkspace: async () => {
        markValidationStarted?.();
        return new Promise<boolean>((resolve) => {
          resolveValidation = resolve;
        });
      },
      launchPersistentContext: async () => {
        const context = new FakeContext();
        contexts.push(context);
        return context as unknown as BrowserContext;
      },
    });

    const attaching = manager.attach("workspace-one", "Late client");
    await validationStarted;
    await manager.close();
    resolveValidation(true);

    await expect(attaching).rejects.toThrow("manager is closed");
    expect(contexts).toHaveLength(0);
  });

  it("uses acknowledged CDP frames and stops streaming without viewers", async () => {
    const { manager, contexts } = await createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const capture = await manager.capture(viewer.viewerToken, "medium", null);

    expect(capture.frame?.dataBase64).toBe(Buffer.from("streamed-jpeg-frame").toString("base64"));
    expect(contexts[0]!.page.screenshotCalls).toBe(0);
    expect(contexts[0]!.cdp.acknowledgements).toBe(1);
    await manager.detach(viewer.viewerToken);
    expect(contexts[0]!.cdp.started).toBe(false);
    await manager.close();
  });

  it("applies display, touch, and user-agent device settings together", async () => {
    const { manager, contexts } = await createManager();
    const viewer = await manager.attach("workspace-one", "Client");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    const result = await manager.applyDevicePreset({
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: {
        sessionId: control.state.sessionId,
        navigationGeneration: control.state.navigationGeneration,
        viewportGeneration: control.state.viewportGeneration,
      },
      presetId: "pixel-7",
    });

    expect(result.state.viewport).toEqual({ width: 412, height: 839 });
    expect(result.state.devicePresetId).toBe("pixel-7");
    expect(result.state.userAgent).toContain("Pixel 7");
    expect(contexts[0]!.cdp.lastUserAgent).toContain("Pixel 7");
    expect(contexts[0]!.cdp.methods).toContain("Emulation.setDeviceMetricsOverride");
    expect(contexts[0]!.cdp.methods).toContain("Emulation.setTouchEmulationEnabled");
    await manager.close();
  });
  it("falls back to a bounded screenshot when screencast is unavailable", async () => {
    const { manager, contexts } = await createManager({ screencast: false });
    const viewer = await manager.attach("workspace-one", "Client");
    const capture = await manager.capture(viewer.viewerToken, "medium", null);

    expect(capture.frame?.dataBase64).toBe(Buffer.from("bounded-jpeg-frame").toString("base64"));
    expect(contexts[0]!.page.screenshotCalls).toBe(1);
    await manager.close();
  });
  it("reports only workspaces with attached viewers", async () => {
    const { manager, contexts } = await createManager();
    expect(await manager.listOpenWorkspaceIds()).toEqual([]);
    const viewer = await manager.attach("workspace-one", "Client");
    expect(await manager.listOpenWorkspaceIds()).toEqual(["workspace-one"]);

    await manager.detach(viewer.viewerToken);
    expect(await manager.listOpenWorkspaceIds()).toEqual([]);
    expect(contexts).toHaveLength(1);
    await manager.close();
  });
  it("bounds concurrently live workspace browsers", async () => {
    const { manager, contexts } = await createManager({ maxSessions: 1 });
    await manager.attach("workspace-one", "First client");

    await expect(manager.attach("workspace-two", "Second client")).rejects.toThrow(
      "session limit (1) reached",
    );
    expect(contexts).toHaveLength(1);
    await manager.close();
  });
  it("ignores archive events when the production manager is absent", async () => {
    vi.resetModules();
    // Fresh module state isolates the production singleton from the unit-test manager instances.
    const { cleanupBrowserServer, handleWorkspaceArchived } = await import("../server/browser");

    await cleanupBrowserServer();

    await expect(handleWorkspaceArchived("workspace-never-opened")).resolves.toBeUndefined();
  });
});
