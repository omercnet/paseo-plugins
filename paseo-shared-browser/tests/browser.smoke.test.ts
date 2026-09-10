import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserFrame, BrowserState } from "../shared/browser";
import { SessionManager } from "../server/browser";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

function target(frame: BrowserFrame) {
  return {
    frameId: frame.frameId,
    navigationGeneration: frame.navigationGeneration,
    viewportGeneration: frame.viewportGeneration,
  };
}

it("shares one sandboxed Chromium session between viewers and retains its dedicated profile", async () => {
  const { stdout } = await execFile("tailscale", ["ip", "-4"]);
  const host = stdout.trim().split("\n")[0];
  if (!host || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error("A Tailscale IPv4 address is required for the browser smoke listener");
  }

  let typedValue = "";
  let clicked = 0;
  let scrolledTo = 0;
  let retainedCookie = "";
  let lastUserAgent = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    lastUserAgent = request.headers["user-agent"] ?? "";
    if (url.pathname === "/typed") {
      typedValue = url.searchParams.get("value") ?? "";
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/clicked") {
      clicked += 1;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/scrolled") {
      scrolledTo = Number(url.searchParams.get("y") ?? 0);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/set-cookie") {
      response.setHeader(
        "Set-Cookie",
        "shared-browser-profile=retained; Path=/; Max-Age=3600; SameSite=Lax",
      );
    }
    if (url.pathname === "/read-cookie") retainedCookie = request.headers.cookie ?? "";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html><head><title>Shared Browser Smoke</title><style>
        input{position:absolute;left:40px;top:30px;width:220px;height:32px}
        button{position:absolute;left:300px;top:30px;width:140px;height:36px}
        main{padding-top:100px;height:2400px}
      </style></head><body>
        <input aria-label="Shared value" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
        <button onclick="fetch('/clicked')">Record click</button>
        <main onwheel="fetch('/scrolled?y='+window.scrollY)">Shared browser test</main>
        <script>addEventListener('scroll',()=>fetch('/scrolled?y='+window.scrollY))</script>
      </body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Smoke listener did not expose a TCP port");
  const origin = `http://${host}:${address.port}`;
  const stateRoot = await mkdtemp(join(tmpdir(), "shared-browser-smoke-"));
  roots.push(stateRoot);

  const createManager = () =>
    new SessionManager({
      stateRoot,
      validateWorkspace: async (workspaceId) => workspaceId === "workspace-smoke",
      launchPersistentContext: (userDataDir, options) =>
        chromium.launchPersistentContext(userDataDir, options),
    });

  let manager = createManager();
  try {
    const first = await manager.attach("workspace-smoke", "Desktop client");
    const second = await manager.attach("workspace-smoke", "Mobile client");
    expect(second.state.sessionId).toBe(first.state.sessionId);
    expect(second.state.viewport).toEqual({ width: 1280, height: 800 });
    expect(second.state.viewerCount).toBe(2);

    const firstControl = await manager.acquireControl(first.viewerToken, false);
    const navigated = await manager.navigate({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstControl.state),
      action: { kind: "goto", url: origin },
    });
    expect(navigated.state.url).toBe(`${origin}/`);

    const captureStarted = performance.now();
    const firstCapture = await manager.capture(first.viewerToken, "medium", null);
    const captureElapsedMs = Math.round(performance.now() - captureStarted);
    const firstFrame = firstCapture.frame;
    expect(firstFrame).not.toBeNull();
    expect(firstFrame!.byteLength).toBeLessThanOrEqual(800_000);
    expect(firstFrame!.transport).toBe("cdp-screencast");
    console.log(
      `[smoke] ${firstFrame!.width}x${firstFrame!.height} ${firstFrame!.transport} JPEG ${firstFrame!.byteLength} bytes in ${captureElapsedMs} ms`,
    );

    const secondCapture = await manager.capture(second.viewerToken, "medium", null);
    expect(secondCapture.state.sessionId).toBe(firstCapture.state.sessionId);
    expect(secondCapture.state.url).toBe(`${origin}/`);
    expect(secondCapture.state.controller).toBe("other");
    await expect(manager.acquireControl(second.viewerToken, false)).rejects.toThrow(
      "held by another viewer",
    );

    const clickedInput = await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstCapture.state),
      target: target(firstFrame!),
      event: {
        kind: "click",
        point: { x: 75, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    const focusedFrame = (await manager.capture(first.viewerToken, "medium", null)).frame;
    expect(focusedFrame).not.toBeNull();
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(clickedInput.state),
      target: target(focusedFrame!),
      event: { kind: "type", text: "same live page" },
    });
    await vi.waitFor(() => expect(typedValue).toBe("same live page"));

    const buttonFrame = (await manager.capture(first.viewerToken, "medium", null)).frame;
    expect(buttonFrame).not.toBeNull();
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstCapture.state),
      target: target(buttonFrame!),
      event: {
        kind: "click",
        point: { x: 185, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    await vi.waitFor(() => expect(clicked).toBe(1));

    const beforeHandoff = await manager.capture(first.viewerToken, "medium", null);
    await manager.releaseControl(first.viewerToken, firstControl.controlToken);
    const secondControl = await manager.acquireControl(second.viewerToken, false);
    const secondFrame = await manager.capture(second.viewerToken, "medium", null);
    await manager.sendInput({
      viewerToken: second.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(secondFrame.state),
      target: target(secondFrame.frame!),
      event: {
        kind: "scroll",
        point: { x: 320, y: 200, width: 640, height: 400 },
        deltaX: 0,
        deltaY: 600,
      },
    });
    await vi.waitFor(() => expect(scrolledTo).toBeGreaterThan(0));

    const resized = await manager.resize({
      viewerToken: second.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(secondFrame.state),
      viewport: { width: 1024, height: 768 },
    });
    expect(resized.state.viewport).toEqual({ width: 1024, height: 768 });
    await expect(
      manager.sendInput({
        viewerToken: second.viewerToken,
        controlToken: secondControl.controlToken,
        expected: expected(resized.state),
        target: target(beforeHandoff.frame!),
        event: {
          kind: "click",
          point: { x: 10, y: 10, width: 640, height: 400 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).rejects.toThrow("frame is stale");

    const emulated = await manager.applyDevicePreset({
      viewerToken: second.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(resized.state),
      presetId: "pixel-7",
    });
    expect(emulated.state.viewport).toEqual({ width: 412, height: 839 });
    expect(emulated.state.devicePresetId).toBe("pixel-7");
    expect(emulated.state.userAgent).toContain("Pixel 7");
    await vi.waitFor(() => expect(lastUserAgent).toContain("Pixel 7"));

    const cookieNavigation = await manager.navigate({
      viewerToken: second.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(emulated.state),
      action: { kind: "goto", url: `${origin}/set-cookie` },
    });
    await manager.detach(first.viewerToken);
    await manager.detach(second.viewerToken);
    const reconnected = await manager.attach("workspace-smoke", "Reconnected client");
    expect(reconnected.state.sessionId).toBe(cookieNavigation.state.sessionId);
    expect(reconnected.state.url).toBe(`${origin}/set-cookie`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clicked).toBe(1);

    await manager.close();
    await expect(manager.attach("workspace-smoke", "Late client")).rejects.toThrow("closed");

    manager = createManager();
    const restored = await manager.attach("workspace-smoke", "Restarted client");
    expect(restored.state.sessionId).not.toBe(reconnected.state.sessionId);
    const restoredControl = await manager.acquireControl(restored.viewerToken, false);
    await manager.navigate({
      viewerToken: restored.viewerToken,
      controlToken: restoredControl.controlToken,
      expected: expected(restoredControl.state),
      action: { kind: "goto", url: `${origin}/read-cookie` },
    });
    await vi.waitFor(() => expect(retainedCookie).toContain("shared-browser-profile=retained"));
  } finally {
    await manager.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
