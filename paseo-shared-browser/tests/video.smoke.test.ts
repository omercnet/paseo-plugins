/**
 * Opt-in real native capture to authenticated Unix socket to client canvas proof.
 * Resolves existing prepared assets read-only, then owns every profile, socket,
 * HTTP fixture, consumer target and virtual display. Never uses the live browser.
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { attachToTarget, type CdpConnection, type CdpSession } from "../server/cdp";
import { createRuntimeOwner } from "../server/runtime-owner";
import { resolveBrowserRuntimeRoot } from "../server/runtime-path";
import { resolveSupervisorPaths, startSupervisorServer } from "../server/supervisor";
import { SupervisorClient } from "../server/supervisor-client";
import type { BrowserState, DevicePresetId } from "../shared/browser";
import {
  type BrowserVideoPacket,
  type BrowserVideoReadReply,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../shared/browser-video";

interface Presentation {
  frameId: string;
  width: number;
  height: number;
  corners: number[][];
  sourceToDrawMs: number;
}
interface Readback {
  presented: Presentation[];
  failures: string[];
  needsKey: boolean;
}
const source = `<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Owned native video source</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#243448}.corner{position:fixed;width:24px;height:24px}
#a{top:0;left:0;background:red}#b{top:0;right:0;background:lime}#c{bottom:0;left:0;background:blue}#d{bottom:0;right:0;background:yellow}
#moving{position:fixed;top:50%;width:30px;height:30px;background:white}</style>
<button style="position:fixed;left:300px;top:300px;width:100px;height:40px" onclick="a.style.background='cyan';window.humanClicks=(window.humanClicks||0)+1">Change view</button><div id=a class=corner></div><div id=b class=corner></div><div id=c class=corner></div><div id=d class=corner></div><div id=moving></div>
<div style="position:fixed;left:100px;top:100px;width:32px;height:8px;background:repeating-linear-gradient(to right,#f00 0px 1px,#00f 1px 2px)"></div>
<div style="position:fixed;left:100px;top:112px;width:32px;height:8px;background:repeating-linear-gradient(to right,#f00 0px .5px,#00f .5px 1px)"></div>
<script>function tick(t){moving.style.left=((t/5)%200)+'px';requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;
function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    runtimeId: state.runtimeId!,
    bridgeEpoch: state.bridgeEpoch!,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

/** Inspect owned source pixels only for density validation, never as a viewer presentation. */
async function sourcePixels(consumer: CdpSession, dataBase64: string, density: 1 | 2) {
  const observation = await consumer.send<{
    result: {
      value: {
        width: number;
        height: number;
        stripes: number[][];
        subpixel: number[][];
        corners: number[][];
      };
    };
  }>("Runtime.evaluate", {
    expression: `(async () => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
      image.src = ${JSON.stringify(`data:image/png;base64,${dataBase64}`)};
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const row = (y) => {
        const bytes = context.getImageData(${100 * density}, y * ${density}, ${8 * density}, 1).data;
        return Array.from({length:${8 * density}}, (_, index) => Array.from(bytes.slice(index * 4, index * 4 + 4)));
      };
      const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
      return {
        width: canvas.width,
        height: canvas.height,
        stripes: row(102),
        subpixel: row(114),
        corners: [pixel(4,4), pixel(canvas.width-5,4), pixel(4,canvas.height-5), pixel(canvas.width-5,canvas.height-5)],
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return observation.result.value;
}

/** Derive only this mkdtemp home's runtime-owner IPC root, never a shared live root. */
function ownedIpcDirectory(home: string): string {
  if (
    dirname(resolve(home)) !== resolve(tmpdir()) ||
    !/^shared-browser-video-smoke-[A-Za-z0-9]+$/.test(basename(home))
  ) {
    throw new Error("Video smoke cleanup requires its own temporary home");
  }
  const root = join(home, "plugin-data", "shared-browser");
  if (process.platform === "win32") return join(root, "ipc");

  // Match runtime-owner's exact home-derived hash; no directory enumeration or
  // prefix deletion may touch another fixture or the real Paseo runtime.
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join("/tmp", `paseo-shared-browser-${hash}`);
}

/** Prove mouse and native touch acknowledgements retain fresh encoded playback. */
async function proveNativeVideo(pointerKind: "mouse" | "touch") {
  const preparedHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const runtimeRoot = resolveBrowserRuntimeRoot(preparedHome);
  const binaryPath =
    process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ??
    join(
      runtimeRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
    );
  const executablePath =
    process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ??
    join(runtimeRoot, "chromium", process.platform === "win32" ? "chrome.exe" : "chrome");
  await Promise.all([access(binaryPath), access(executablePath)]);
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/video-consumer.ts", import.meta.url))],
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    plugins: [
      {
        name: "owned-web-platform",
        setup(builder) {
          builder.onResolve({ filter: /^react-native$/ }, () => ({
            path: "platform",
            namespace: "owned-platform",
          }));
          builder.onLoad({ filter: /.*/, namespace: "owned-platform" }, () => ({
            contents: 'export const Platform={OS:"web"};',
            loader: "js",
          }));
        },
      },
    ],
  });
  const consumerBundle = compiled.outputFiles[0]!.text;
  let heldScriptRequested = false;
  let releaseDom = () => {};
  const server = createServer((request, response) => {
    if (request.url === "/consumer.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(consumerBundle);
    } else if (request.url === "/consumer") {
      response.end(
        '<!doctype html><div id=video style="width:640px;height:640px"></div><script src=/consumer.js></script>',
      );
    } else if (request.url === "/pending-dom") {
      response.end(
        `<!doctype html><title>Pending DOM</title><script src="/held-script"></script>${source}`,
      );
    } else if (request.url === "/held-script") {
      heldScriptRequested = true;
      response.setHeader("Content-Type", "text/javascript");
      response.flushHeaders();
      releaseDom = () => response.end("/* Deliberately delayed parser completion. */");
    } else {
      response.end(source);
    }
  });
  const home = await mkdtemp(join(tmpdir(), "shared-browser-video-smoke-"));
  const ipcDirectory = ownedIpcDirectory(home);
  let running: Awaited<ReturnType<typeof startSupervisorServer>> | null = null;
  let client: SupervisorClient | null = null;
  let consumer: CdpSession | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Owned video HTTP listener unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PASEO_HOME", home);
    vi.stubEnv("PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY", binaryPath);
    vi.stubEnv("PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE", executablePath);
    const owner = await createRuntimeOwner({
      initialUrl: `${origin}/source`,
      nativeVideo: true,
      headed: process.platform === "win32",
    });
    let owned: Awaited<ReturnType<typeof owner.create>> | null = null;
    const paths = resolveSupervisorPaths(home);
    running = await startSupervisorServer(
      {
        ...owner,
        create: async (workspace) => {
          owned = await owner.create(workspace);
          return owned;
        },
      },
      paths,
    );
    client = new SupervisorClient({ bridgeId: "owned-video-smoke", paths });
    await client.connect();
    const attached = await client.requestBrowser<{ viewerToken: string; state: BrowserState }>(
      "attach",
      { workspaceId: "video-smoke", viewerLabel: "Owned video test" },
    );
    const lease = await client.requestBrowser<{ controlToken: string; state: BrowserState }>(
      "acquire-control",
      { viewerToken: attached.viewerToken },
    );
    let state = lease.state;
    // Test-only access to the owned CDP connection creates the consumer, never reads
    // source pixels. All video bytes below traverse the authenticated public RPC.
    const runtime = (
      owned as unknown as {
        runtime: { connection: CdpConnection; page: CdpSession };
      }
    ).runtime;
    const connection = runtime.connection;
    const created = await connection.send<{ targetId: string }>("Target.createTarget", {
      url: `${origin}/consumer`,
      background: true,
    });
    consumer = await attachToTarget(connection, created.targetId);
    await consumer.send("Runtime.enable");
    await vi.waitFor(
      async () => {
        const ready = await consumer!.send<{ result: { value: boolean } }>("Runtime.evaluate", {
          expression: 'typeof prepareVideo==="function"',
          returnByValue: true,
        });
        expect(ready.result.value).toBe(true);
      },
      { timeout: 5000 },
    );
    await connection.send("Target.activateTarget", { targetId: created.targetId });
    const presets: readonly { id: DevicePresetId; width: number; height: number }[] = [
      { id: "desktop-1280x800", width: 1280, height: 800 },
      { id: "pixel-7", width: 412, height: 839 },
      { id: "iphone-15-pro", width: 393, height: 659 },
      { id: "pixel-7-sharp", width: 824, height: 1678 },
      { id: "desktop-2560x2560", width: 2560, height: 2560 },
    ];
    let burstPacketsPainted = 0;
    for (const preset of presets) {
      const changed = await client.requestBrowser<{ state: BrowserState }>("device", {
        viewerToken: attached.viewerToken,
        controlToken: lease.controlToken,
        expected: expected(state),
        presetId: preset.id,
      });
      state = changed.state;
      await consumer.send("Runtime.evaluate", {
        expression: `prepareVideo(${JSON.stringify(state)})`,
      });
      let streamId: string | null = null;
      let sequence = 0;
      let readback: Readback = { presented: [], failures: [], needsKey: false };
      const start = Date.now();
      for (let attempt = 0; attempt < 30 && !readback.presented.length; attempt++) {
        const reply: BrowserVideoReadReply = await client.requestBrowser<BrowserVideoReadReply>(
          "video.read",
          {
            viewerToken: attached.viewerToken,
            quality: "high",
            streamId,
            afterSequence: sequence,
            waitMs: 250,
            requestKeyFrame: attempt === 0 || readback.needsKey,
          },
        );
        expect(reply.status).not.toBe("unsupported");
        if (reply.streamId) streamId = reply.streamId;
        if (reply.packets.length) sequence = reply.packets.at(-1)!.sequence;
        await consumer.send("Runtime.evaluate", {
          expression: `consumeVideo(${JSON.stringify(reply)})`,
        });
        const observation = await consumer.send<{ result: { value: Readback } }>(
          "Runtime.evaluate",
          { expression: "({presented,failures,needsKey})", returnByValue: true },
        );
        readback = observation.result.value;
        expect(readback.failures).toEqual([]);
      }
      expect(readback.presented.length).toBeGreaterThan(0);
      const front = readback.presented.at(-1)!;
      expect([front.width, front.height]).toEqual([preset.width, preset.height]);
      const [red, green, blue, yellow] = front.corners;
      expect(red![0]).toBeGreaterThan(180);
      expect(red![1]).toBeLessThan(90);
      expect(green![1]).toBeGreaterThan(150);
      expect(green![0]).toBeLessThan(90);
      expect(blue![2]).toBeGreaterThan(180);
      expect(blue![0]).toBeLessThan(90);
      expect(yellow![0]).toBeGreaterThan(180);
      expect(yellow![1]).toBeGreaterThan(180);
      expect(front.frameId.length).toBeGreaterThan(0);
      console.log(
        "video-smoke:",
        JSON.stringify({
          preset: preset.id,
          sourceToDrawMs: front.sourceToDrawMs,
          firstDrawMs: Date.now() - start,
        }),
      );

      if (preset.id === "desktop-1280x800") {
        // A slower relay delivers a burst rather than one packet per RPC. Keep
        // the genuine codec and draw path: synchronous fakes missed resets that
        // closed the keyframe before WebCodecs could produce asynchronous output.
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        const burst = await client.requestBrowser<BrowserVideoReadReply>("video.read", {
          viewerToken: attached.viewerToken,
          quality: "high",
          streamId,
          afterSequence: sequence,
          waitMs: 250,
        });
        expect(burst.packets.length).toBeGreaterThan(4);
        const finalFrameId = burst.packets.at(-1)!.frame.frameId;
        await consumer.send("Runtime.evaluate", {
          expression: `consumeVideo(${JSON.stringify(burst)})`,
        });
        await vi.waitFor(
          async () => {
            const observation = await consumer!.send<{ result: { value: Readback } }>(
              "Runtime.evaluate",
              { expression: "({presented,failures,needsKey})", returnByValue: true },
            );
            expect(observation.result.value.failures).toEqual([]);
            expect(observation.result.value.needsKey).toBe(false);
            expect(observation.result.value.presented.at(-1)?.frameId).toBe(finalFrameId);
          },
          { timeout: 2000, interval: 25 },
        );
        burstPacketsPainted = burst.packets.length;
        console.log(
          "video-smoke-burst:",
          JSON.stringify({ packets: burst.packets.length, paintedLastPacket: true }),
        );
      }
    }
    // Reuse the owned browser and authenticated path. Density changes source
    // rendering, not CSS geometry. Direct source inspection is fixture-only.
    const desktop = await client.requestBrowser<{ state: BrowserState }>("device", {
      viewerToken: attached.viewerToken,
      controlToken: lease.controlToken,
      expected: expected(state),
      presetId: "desktop-1280x800",
    });
    state = desktop.state;
    for (const density of [1, 2] as const) {
      const changed = await client.requestBrowser<{ state: BrowserState }>("capture.density", {
        viewerToken: attached.viewerToken,
        controlToken: lease.controlToken,
        expected: expected(state),
        density,
      });
      state = changed.state;
      expect(state.viewport).toEqual({ width: 1280, height: 800 });
      expect(state.captureScale).toBe(density);
      const metrics = await runtime.page.send<{ result: { value: number[] } }>("Runtime.evaluate", {
        expression: "[innerWidth,innerHeight,devicePixelRatio]",
        returnByValue: true,
      });
      expect(metrics.result.value).toEqual([1280, 800, density]);
      // Verify production video uses the denser source without another browser.
      let video: BrowserVideoReadReply | null = null;
      for (let attempt = 0; attempt < 10 && !video?.packets.length; attempt++) {
        video = await client.requestBrowser<BrowserVideoReadReply>("video.read", {
          viewerToken: attached.viewerToken,
          quality: "high",
          streamId: null,
          afterSequence: 0,
          waitMs: 250,
          requestKeyFrame: true,
        });
        expect(video.status).not.toBe("unsupported");
      }
      expect(video?.packets.length).toBeGreaterThan(0);
      expect([video!.packets[0]!.width, video!.packets[0]!.height]).toEqual([
        1280 * density,
        800 * density,
      ]);
      // RGB readback proves DPR2 source detail, not lossless video encoding.
      // This owned DevTools inspection is not a plugin capture API or idle overlay.
      const sourceImage = await runtime.page.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
      });
      const pixels = await sourcePixels(consumer, sourceImage.data, density);
      expect([pixels.width, pixels.height]).toEqual([1280 * density, 800 * density]);
      expect(pixels.stripes).toEqual(
        Array.from({ length: 8 * density }, (_, index) =>
          Math.floor(index / density) % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255],
        ),
      );
      expect(pixels.corners).toEqual([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
      ]);
      if (density === 2) {
        // Half-CSS-pixel stripes resolve as distinct source pixels at DPR2.
        // Upscaling a DPR1 screenshot cannot reconstruct these alternating colours.
        expect(pixels.subpixel).toEqual(
          Array.from({ length: 16 }, (_, index) =>
            index % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255],
          ),
        );
      }
    }
    await consumer.send("Runtime.evaluate", { expression: "finishVideo()" });

    // URL submission acknowledges navigation, not completed page parsing. A
    // parser-blocking resource must not hold the outer RPC or permanently stop
    // native video. Release it explicitly only after acknowledgement is proved.
    const navigation = await client.requestBrowser<{ state: BrowserState }>("navigate", {
      viewerToken: attached.viewerToken,
      controlToken: lease.controlToken,
      expected: expected(state),
      action: { kind: "goto", url: `${origin}/pending-dom` },
    });
    state = navigation.state;
    const navigationAcknowledgedAt = Date.now();
    expect(state.url).toBe(`${origin}/pending-dom`);
    await vi.waitFor(() => expect(heldScriptRequested).toBe(true), { timeout: 1000 });
    releaseDom();
    await consumer.send("Runtime.evaluate", {
      expression: `prepareVideo(${JSON.stringify(state)})`,
    });
    let navigationPainted = false;
    let navigationFront: Presentation | null = null;
    const navigationPackets = new Map<string, BrowserVideoPacket>();
    let navigationSequence = 0;
    let navigationStreamId: string | null = null;
    for (let attempt = 0; attempt < 15 && !navigationPainted; attempt++) {
      const reply: BrowserVideoReadReply = await client.requestBrowser<BrowserVideoReadReply>(
        "video.read",
        {
          viewerToken: attached.viewerToken,
          quality: "high",
          streamId: navigationStreamId,
          afterSequence: navigationSequence,
          waitMs: 250,
          requestKeyFrame: attempt === 0,
        },
      );
      expect(reply.status).not.toBe("unsupported");
      navigationStreamId = reply.streamId;
      if (reply.packets.length) navigationSequence = reply.packets.at(-1)!.sequence;
      for (const packet of reply.packets) navigationPackets.set(packet.frame.frameId, packet);
      await consumer.send("Runtime.evaluate", {
        expression: `consumeVideo(${JSON.stringify(reply)})`,
      });
      const observation = await consumer.send<{ result: { value: Readback } }>("Runtime.evaluate", {
        expression: "({presented,failures,needsKey})",
        returnByValue: true,
      });
      expect(observation.result.value.failures).toEqual([]);
      navigationFront = observation.result.value.presented.at(-1) ?? null;
      const packet = navigationFront ? navigationPackets.get(navigationFront.frameId) : null;
      // The first post-navigation frame can be display-only within the existing
      // 50ms native clock uncertainty. Wait for truly newer pixels before input.
      navigationPainted = Boolean(
        packet &&
          Date.parse(packet.capturedAt) >
            navigationAcknowledgedAt + VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
      );
    }
    expect(navigationPainted).toBe(true);

    // A same-document click must reach Chromium once, then fresh video must
    // show its visual effect. The target is an actually decoded packet receipt.
    const clickedPacket = navigationPackets.get(navigationFront!.frameId)!;
    expect(clickedPacket).toBeDefined();
    const clickContext = {
      viewerToken: attached.viewerToken,
      controlToken: lease.controlToken,
      expected: expected(state),
    };
    const clickTarget = {
      frameId: clickedPacket.frame.frameId,
      navigationGeneration: clickedPacket.frame.navigationGeneration,
      viewportGeneration: clickedPacket.frame.viewportGeneration,
    };
    // Exercise the human pane's down/up channel, rather than the discrete legacy
    // click RPC. Every independent press carries its own decoded receipt.
    const press = async (target: typeof clickTarget) => {
      const gesture = await client!.requestBrowser<
        { gestureId: string; nextSequence: number } | { admission: "stale-frame" }
      >("gesture.begin", { ...clickContext, target, pointerKind });
      if (!("gestureId" in gesture)) return { admitted: false as const };
      const pressed = await client!.requestBrowser<{ state: BrowserState; nextSequence: number }>(
        "gesture.update",
        {
          ...clickContext,
          gestureId: gesture.gestureId,
          sequence: gesture.nextSequence,
          target,
          event:
            pointerKind === "touch"
              ? {
                  kind: "touch",
                  type: "start",
                  points: [{ id: 0, x: 350, y: 320, width: 1280, height: 800 }],
                }
              : {
                  kind: "down",
                  point: { x: 350, y: 320, width: 1280, height: 800 },
                  button: "left",
                  clickCount: 1,
                },
        },
      );
      const released = await client!.requestBrowser<{ state: BrowserState; nextSequence: number }>(
        "gesture.update",
        {
          ...clickContext,
          gestureId: gesture.gestureId,
          sequence: pressed.nextSequence,
          event:
            pointerKind === "touch"
              ? { kind: "touch", type: "end", points: [] }
              : {
                  kind: "up",
                  point: { x: 350, y: 320, width: 1280, height: 800 },
                  button: "left",
                  clickCount: 1,
                },
        },
      );
      const ended = await client!.requestBrowser<{ state: BrowserState }>("gesture.end", {
        ...clickContext,
        gestureId: gesture.gestureId,
        sequence: released.nextSequence,
        cancel: false,
      });
      return { admitted: true as const, state: ended.state };
    };
    const clicksSoFar = async () =>
      (
        await runtime.page.send<{ result: { value: number } }>("Runtime.evaluate", {
          expression: "window.humanClicks||0",
          returnByValue: true,
        })
      ).result.value;
    const first = await press(clickTarget);
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error("First press was not admitted");
    const firstAcknowledgedAt = Date.now();
    state = first.state;
    await vi.waitFor(async () => expect(await clicksSoFar()).toBe(1), { timeout: 2000 });

    // The acknowledged press spent its receipt: the still-painted pixels cannot press again.
    const spent = await press(clickTarget);
    expect(spent.admitted).toBe(false);
    expect(await clicksSoFar()).toBe(1);

    // A newer genuinely decoded packet (captured after the first press) is a fresh receipt.
    let secondTarget: typeof clickTarget | null = null;
    for (let attempt = 0; attempt < 30 && !secondTarget; attempt++) {
      const reply: BrowserVideoReadReply = await client.requestBrowser<BrowserVideoReadReply>(
        "video.read",
        {
          viewerToken: attached.viewerToken,
          quality: "high",
          streamId: navigationStreamId,
          afterSequence: navigationSequence,
          waitMs: 250,
          requestKeyFrame: false,
        },
      );
      expect(reply.status).not.toBe("unsupported");
      if (reply.streamId !== navigationStreamId) navigationSequence = 0;
      navigationStreamId = reply.streamId;
      if (reply.packets.length) navigationSequence = reply.packets.at(-1)!.sequence;
      for (const packet of reply.packets) navigationPackets.set(packet.frame.frameId, packet);
      await consumer.send("Runtime.evaluate", {
        expression: `consumeVideo(${JSON.stringify(reply)})`,
      });
      const observation = await consumer.send<{ result: { value: Readback } }>("Runtime.evaluate", {
        expression: "({presented,failures,needsKey})",
        returnByValue: true,
      });
      expect(observation.result.value.failures).toEqual([]);
      const painted = observation.result.value.presented.at(-1);
      const packet = painted ? navigationPackets.get(painted.frameId) : undefined;
      if (
        packet &&
        Date.parse(packet.capturedAt) > firstAcknowledgedAt + VIDEO_SOURCE_CLOCK_TOLERANCE_MS
      ) {
        secondTarget = {
          frameId: packet.frame.frameId,
          navigationGeneration: packet.frame.navigationGeneration,
          viewportGeneration: packet.frame.viewportGeneration,
        };
      }
    }
    expect(secondTarget).not.toBeNull();
    const secondPress = await press(secondTarget!);
    expect(secondPress.admitted).toBe(true);
    if (!secondPress.admitted) throw new Error("Second press was not admitted");
    state = secondPress.state;
    await vi.waitFor(async () => expect(await clicksSoFar()).toBe(2), { timeout: 2000 });
    expect(state.url).toBe(`${origin}/pending-dom`);
    let ordinaryClickPainted = false;
    for (let attempt = 0; attempt < 20 && !ordinaryClickPainted; attempt++) {
      const reply = await client.requestBrowser<BrowserVideoReadReply>("video.read", {
        viewerToken: attached.viewerToken,
        quality: "high",
        streamId: navigationStreamId,
        afterSequence: navigationSequence,
        waitMs: 250,
        requestKeyFrame: attempt === 0,
      });
      expect(reply.status).not.toBe("unsupported");
      if (reply.streamId !== navigationStreamId) navigationSequence = 0;
      navigationStreamId = reply.streamId;
      if (reply.packets.length) navigationSequence = reply.packets.at(-1)!.sequence;
      await consumer.send("Runtime.evaluate", {
        expression: `consumeVideo(${JSON.stringify(reply)})`,
      });
      const observation = await consumer.send<{ result: { value: Readback } }>("Runtime.evaluate", {
        expression: "({presented,failures,needsKey})",
        returnByValue: true,
      });
      expect(observation.result.value.failures).toEqual([]);
      const corner = observation.result.value.presented.at(-1)?.corners[0];
      ordinaryClickPainted = Boolean(
        corner && corner[0]! < 90 && corner[1]! > 180 && corner[2]! > 180,
      );
    }
    expect(ordinaryClickPainted).toBe(true);
    await consumer.send("Runtime.evaluate", { expression: "finishVideo()" });

    const tab = await client.requestBrowser<{ tabId: string }>("tabs.create", {
      viewerToken: attached.viewerToken,
    });
    const second = await client.requestBrowser<{ viewerToken: string; state: BrowserState }>(
      "attach",
      { workspaceId: "video-smoke", viewerLabel: "Second tab viewer", tabId: tab.tabId },
    );
    const secondControl = await client.requestBrowser<{
      controlToken: string;
      state: BrowserState;
    }>("acquire-control", { viewerToken: second.viewerToken });
    await client.requestBrowser("navigate", {
      viewerToken: second.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(secondControl.state),
      action: { kind: "goto", url: `${origin}/source` },
    });
    const readTabPacket = async (viewerToken: string): Promise<BrowserVideoReadReply> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const reply = await client!.requestBrowser<BrowserVideoReadReply>("video.read", {
          viewerToken,
          quality: "high",
          streamId: null,
          afterSequence: 0,
          waitMs: 250,
          requestKeyFrame: true,
        });
        expect(reply.status).not.toBe("unsupported");
        if (reply.packets.length) return reply;
      }
      throw new Error("Tab produced no native video packets");
    };
    const secondVideo = await readTabPacket(second.viewerToken);
    const firstVideo = await readTabPacket(attached.viewerToken);
    expect(secondVideo.streamId).not.toBe(firstVideo.streamId);
    expect(secondVideo.state.tabId).toBe(tab.tabId);
    expect(firstVideo.state.tabId).toBe(attached.state.tabId);
    expect(firstVideo.state.controller).toBe("self");
    expect(firstVideo.state.url).toBe(`${origin}/pending-dom`);
    await client.requestBrowser("tabs.close", {
      viewerToken: attached.viewerToken,
      controlToken: lease.controlToken,
      tabId: attached.state.tabId!,
    });
    const afterOriginalClose = await readTabPacket(second.viewerToken);
    expect(afterOriginalClose.state.tabId).toBe(tab.tabId);
    expect(afterOriginalClose.state.controller).toBe("self");
    expect(afterOriginalClose.state.url).toBe(`${origin}/source`);
    await client.requestBrowser("detach", { viewerToken: second.viewerToken });
    await client.requestBrowser("detach", { viewerToken: attached.viewerToken });
    if (process.env.PASEO_SHARED_BROWSER_VIDEO_SMOKE_RECEIPT) {
      await writeFile(
        process.env.PASEO_SHARED_BROWSER_VIDEO_SMOKE_RECEIPT,
        JSON.stringify({
          completed: true,
          presetsPainted: presets.length,
          captureDensitiesVerified: [1, 2],
          burstPacketsPainted,
          navigationAcknowledgedBeforeDom: heldScriptRequested,
          navigationVideoPainted: navigationPainted,
          ordinaryClickPainted,
        }),
      );
    }
  } finally {
    releaseDom();
    client?.disconnect();
    await consumer?.detach().catch(() => undefined);
    try {
      await running?.close();
    } finally {
      vi.unstubAllEnvs();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      try {
        await rm(ipcDirectory, { recursive: true, force: true });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
}

it.each(["mouse", "touch"] as const)(
  "paints native video at genuine capture density after %s input",
  proveNativeVideo,
  30000,
);
