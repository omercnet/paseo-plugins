import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserFrame, BrowserState } from "../shared/browser";
import { SessionManager } from "../server/browser";
import { createRuntimeOwner } from "../server/runtime-owner";
import { SupervisorClient } from "../server/supervisor-client";
import { resolveSupervisorPaths, startSupervisorServer } from "../server/supervisor";

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

it("shares and persists a production agent-browser runtime across supervisor clients", async () => {
  const binaryPath = process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY;
  const executablePath = process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE;
  if (!binaryPath || !executablePath) {
    throw new Error(
      "Browser smoke prerequisites missing: set PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY and PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE",
    );
  }
  await Promise.all([
    access(binaryPath).catch(() => {
      throw new Error(`Browser smoke agent-browser binary is not accessible: ${binaryPath}`);
    }),
    access(executablePath).catch(() => {
      throw new Error(`Browser smoke Chromium executable is not accessible: ${executablePath}`);
    }),
  ]);

  let typedValue = "";
  let clicked = 0;
  let retainedCookie = "";
  let lastUserAgent = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
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
    if (url.pathname === "/set-cookie") {
      response.setHeader(
        "Set-Cookie",
        "shared-browser-profile=retained; Path=/; Max-Age=3600; SameSite=Lax",
      );
    }
    if (url.pathname === "/read-cookie") retainedCookie = request.headers.cookie ?? "";
    if (url.pathname === "/after-navigation") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><html><body style='background:#123456'>New page</body></html>");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html><head><title>Shared Browser Smoke</title><style>
        input{position:absolute;left:40px;top:30px;width:220px;height:32px}
        button{position:absolute;left:300px;top:30px;width:140px;height:36px}
      </style></head><body>
        <input aria-label="Shared value" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
        <button onclick="fetch('/clicked')">Record click</button>
      </body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Smoke listener did not expose a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const paseoHome = await mkdtemp(join(tmpdir(), "shared-browser-smoke-"));
  roots.push(paseoHome);
  const previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = paseoHome;

  const paths = resolveSupervisorPaths(paseoHome);
  const running = await startSupervisorServer(await createRuntimeOwner(), paths);
  const createManager = async (bridgeId: string) => {
    const manager = new SessionManager({
      client: new SupervisorClient({ bridgeId, paths }),
      validateWorkspace: async (workspaceId) => workspaceId === "workspace-smoke",
    });
    await manager.connect();
    return manager;
  };

  let manager = await createManager("smoke-bridge-one");
  try {
    const first = await manager.attach("workspace-smoke", "Desktop client");
    expect(first.state.url).toBe("https://example.com/");
    const second = await manager.attach("workspace-smoke", "Mobile client");
    expect(second.state.sessionId).toBe(first.state.sessionId);
    expect(second.state.viewerCount).toBe(2);

    const firstControl = await manager.acquireControl(first.viewerToken, false);
    const navigated = await manager.navigate({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstControl.state),
      action: { kind: "goto", url: origin },
    });
    expect(navigated.state.url).toBe(`${origin}/`);

    const firstCapture = await manager.capture(first.viewerToken, "medium", null);
    expect(firstCapture.frame?.transport).toBe("cdp-screencast");
    expect(firstCapture.frame?.byteLength).toBeLessThanOrEqual(800_000);
    const secondCapture = await manager.capture(second.viewerToken, "medium", null);
    expect(secondCapture.state.sessionId).toBe(firstCapture.state.sessionId);
    expect(secondCapture.state.controller).toBe("other");

    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstCapture.state),
      target: target(firstCapture.frame!),
      event: {
        kind: "click",
        point: { x: 75, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    const focused = await manager.capture(first.viewerToken, "medium", null);
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(focused.state),
      target: target(focused.frame!),
      event: { kind: "type", text: "same live page" },
    });
    await vi.waitFor(() => expect(typedValue).toBe("same live page"));

    const buttonFrame = await manager.capture(first.viewerToken, "medium", null);
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(buttonFrame.state),
      target: target(buttonFrame.frame!),
      event: {
        kind: "click",
        point: { x: 185, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    await vi.waitFor(() => expect(clicked).toBe(1));

    const afterNavigation = await manager.navigate({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(buttonFrame.state),
      action: { kind: "goto", url: `${origin}/after-navigation` },
    });
    const postNavigationFrame = await manager.capture(first.viewerToken, "medium", null);
    expect(postNavigationFrame.frame?.dataBase64).not.toBe(buttonFrame.frame?.dataBase64);
    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: firstControl.controlToken,
        expected: expected(afterNavigation.state),
        target: target(buttonFrame.frame!),
        event: {
          kind: "click",
          point: { x: 185, y: 23, width: 640, height: 400 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).rejects.toThrow("stale");

    await manager.releaseControl(first.viewerToken, firstControl.controlToken);
    await expect(manager.detach(first.viewerToken)).resolves.toEqual({ detached: true });
    await expect(manager.detach(second.viewerToken)).resolves.toEqual({ detached: true });
    const resumed = await manager.attach("workspace-smoke", "Reattached client");
    const resumedCapture = await manager.capture(resumed.viewerToken, "medium", null);
    expect(resumedCapture.frame?.transport).toBe("cdp-screencast");
    const secondControl = await manager.acquireControl(resumed.viewerToken, false);
    const emulated = await manager.applyDevicePreset({
      viewerToken: resumed.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(secondControl.state),
      presetId: "pixel-7",
    });
    expect(emulated.state.viewport).toEqual({ width: 412, height: 839 });
    expect(emulated.state.userAgent).toContain("Pixel 7");
    await manager.navigate({
      viewerToken: resumed.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(emulated.state),
      action: { kind: "goto", url: `${origin}/set-cookie` },
    });
    await vi.waitFor(() => expect(lastUserAgent).toContain("Pixel 7"));

    manager.disconnect();
    manager = await createManager("smoke-bridge-two");
    const restored = await manager.attach("workspace-smoke", "Reconnected client");
    expect(restored.state.url).toBe(`${origin}/set-cookie`);
    expect(restored.state.viewport).toEqual({ width: 1280, height: 800 });
    const restoredControl = await manager.acquireControl(restored.viewerToken, false);
    await manager.navigate({
      viewerToken: restored.viewerToken,
      controlToken: restoredControl.controlToken,
      expected: expected(restoredControl.state),
      action: { kind: "goto", url: `${origin}/read-cookie` },
    });
    await vi.waitFor(() => expect(retainedCookie).toContain("shared-browser-profile=retained"));

    await manager.archiveWorkspace("workspace-smoke");
    await expect(manager.capture(restored.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
  } finally {
    manager.disconnect();
    await running.close();
    if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousPaseoHome;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
