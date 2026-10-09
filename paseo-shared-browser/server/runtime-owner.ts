import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserGestureKeySchema } from "../shared/browser";
import { videoBitrateSchema, videoFrameRateSchema } from "../shared/video-settings";
import { AgentBrowserRuntime, type BrowserViewport } from "./agent-browser-runtime";
import { resolveBrowserRuntimeRoot } from "./runtime-path";
import type { JsonValue } from "./runtime-protocol";
import type { RuntimeOwner } from "./supervisor";
import {
  createPrivateVirtualDisplay,
  PrivateDisplayError,
  type PrivateVirtualDisplay,
} from "./virtual-display";

const DEFAULT_BROWSER_URL = "https://example.com/";

interface OwnedRuntime {
  runtimeId: string;
  runtime: AgentBrowserRuntime;
  display: PrivateVirtualDisplay | null;
  /** Bounded, secret-free reason an opted-in private display is not in use. */
  displayNotice: string | null;
}
interface RuntimeOwnerOptions {
  initialUrl?: string;
  headed?: boolean;
  /**
   * Trusted opt-in for a private Linux Xvfb display. When omitted, each runtime creation reads
   * PASEO_SHARED_BROWSER_XVFB from this process's environment and enables it only for "1".
   * Explicit false overrides the environment.
   */
  virtualDisplay?: boolean;
  /** Encoded video is opt-in; defaults to PASEO_SHARED_BROWSER_VIDEO=1 in the daemon environment. */
  nativeVideo?: boolean;
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

/** Retain omission for legacy/native held-key inference; reject malformed explicit masks. */
function optionalMouseModifiers(data: Record<string, JsonValue>): [] | [number] {
  return data.modifiers === undefined
    ? []
    : [browserGestureKeySchema.shape.modifiers.parse(data.modifiers)];
}

export async function createRuntimeOwner(
  options: RuntimeOwnerOptions = {},
): Promise<RuntimeOwner<OwnedRuntime>> {
  const home = paseoHome();
  const root = join(home, "plugin-data", "shared-browser");
  const runtimeRoot = resolveBrowserRuntimeRoot(home);
  const ipcDirectory =
    process.platform === "win32"
      ? join(root, "ipc")
      : join(
          "/tmp",
          `paseo-shared-browser-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
        );
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
  return {
    async create(workspaceId) {
      const hash = createHash("sha256").update(workspaceId).digest("hex");
      // Explicit headed mode uses the caller's real display. Hidden Linux mode
      // gets a private virtual mouse so native pointer media survive emulation.
      let display: PrivateVirtualDisplay | null = null;
      let displayNotice: string | null = null;
      const wantsDisplay = options.virtualDisplay ?? process.env.PASEO_SHARED_BROWSER_XVFB === "1";
      if (!options.headed && wantsDisplay) {
        try {
          display = await createPrivateVirtualDisplay();
          if (!display) displayNotice = "Private display unavailable: Xvfb was not found.";
        } catch (error) {
          // The helper has finished cleanup and no Chromium was constructed yet.
          displayNotice = `Private display unavailable: ${
            error instanceof PrivateDisplayError ? error.message : "unexpected startup failure"
          }.`;
        }
        if (displayNotice) {
          // The detached supervisor discards stdio; the notice also reaches the viewer state.
          console.warn(`[shared-browser] ${displayNotice} Using headless mode.`);
        }
      }
      let runtime: AgentBrowserRuntime | null = null;
      try {
        runtime = new AgentBrowserRuntime({
          binaryPath,
          executablePath,
          profilePath: join(root, "profiles", hash),
          ipcDirectory,
          session: `ws-${hash.slice(0, 16)}`,
          initialUrl: options.initialUrl ?? DEFAULT_BROWSER_URL,
          headed: display ? true : (options.headed ?? false),
          nativeVideo: options.nativeVideo ?? process.env.PASEO_SHARED_BROWSER_VIDEO === "1",
          ...(display ? { launchEnvironment: display.launchEnvironment } : {}),
        });
        await runtime.launch();
        display?.assertAvailable();
        return { runtimeId: randomUUID(), runtime, display, displayNotice };
      } catch (error) {
        let cleanupFailure: unknown = null;
        try {
          await runtime?.shutdown();
        } catch (failure) {
          cleanupFailure = failure;
        } finally {
          await display?.stop();
        }
        // An unconfirmed cleanup must not hide why creation failed.
        if (cleanupFailure)
          throw new AggregateError(
            [error, cleanupFailure],
            `Runtime creation failed (${error instanceof Error ? error.message : String(error)}) and its cleanup was not confirmed`,
          );
        throw error;
      }
    },
    async request(owned, operation, input) {
      owned.display?.assertAvailable();
      const data =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, JsonValue>)
          : {};
      const gestureId = typeof data.gestureId === "string" ? data.gestureId : undefined;
      switch (operation) {
        case "identity": {
          const identity = await owned.runtime.identity();
          return {
            ...identity,
            ...(owned.displayNotice ? { displayNotice: owned.displayNotice } : {}),
          } as unknown as JsonValue;
        }
        case "state":
          if (data.timeoutMs === undefined) return owned.runtime.state() as unknown as JsonValue;
          if (typeof data.timeoutMs !== "number")
            throw new Error("Invalid browser metadata timeout");
          return owned.runtime.state({ timeoutMs: data.timeoutMs }) as unknown as JsonValue;
        case "navigate":
          await owned.runtime.navigate(String(data.url));
          return null;
        case "back":
          await owned.runtime.back();
          return null;
        case "forward":
          await owned.runtime.forward();
          return null;
        case "reload":
          await owned.runtime.reload();
          return null;
        case "emulate":
          await owned.runtime.emulate(data as unknown as BrowserViewport);
          return null;
        case "capture.density":
          await owned.runtime.setCaptureDensity(
            Number(data.density),
            Number(data.deviceScaleFactor),
          );
          return null;
        case "screencast.start":
          await owned.runtime.startScreencast(Number(data.quality));
          return null;
        case "screencast.stop":
          await owned.runtime.stopScreencast();
          return null;
        case "video.read":
          return (await owned.runtime.readVideo({
            quality: data.quality === "low" || data.quality === "medium" ? data.quality : "high",
            streamId: typeof data.streamId === "string" ? data.streamId : null,
            requestKeyFrame: data.requestKeyFrame === true,
            ...(data.bitrate === undefined
              ? {}
              : { bitrate: videoBitrateSchema.parse(data.bitrate) }),
            ...(data.fps === undefined ? {} : { fps: videoFrameRateSchema.parse(data.fps) }),
            afterSequence: Number(data.afterSequence ?? 0),
            waitMs: Number(data.waitMs ?? 250),
          })) as unknown as JsonValue;
        case "video.stop":
          await owned.runtime.stopVideo();
          return null;
        case "video.invalidate":
          owned.runtime.invalidateQueuedVideoFrames();
          return null;
        case "frame":
          return (await owned.runtime.frame(
            Number(data.maxBytes),
            Number(data.quality),
            Number(data.waitMs),
          )) as unknown as JsonValue;
        case "mouse.move":
          await owned.runtime.mouseMove(
            Number(data.x),
            Number(data.y),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.down":
          await owned.runtime.mouseDown(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.up":
          await owned.runtime.mouseUp(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.wheel":
          await owned.runtime.wheel(
            Number(data.x),
            Number(data.y),
            Number(data.deltaX),
            Number(data.deltaY),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.leave":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.mouseLeave(gestureId);
          return null;
        case "input.begin":
          if (!gestureId) throw new Error("Gesture identity is required");
          if (typeof data.expectedInputGeneration !== "string") {
            throw new Error("Expected native input generation is required");
          }
          await owned.runtime.beginLiveInput(gestureId, data.expectedInputGeneration);
          return null;
        case "input.check":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.assertLiveInput(gestureId);
          return null;
        case "input.end":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.endLiveInput(gestureId);
          return null;
        case "cursor":
          if (!gestureId) throw new Error("Gesture identity is required");
          return owned.runtime.cursorAt(Number(data.x), Number(data.y), gestureId);
        case "touch": {
          if (!gestureId || !Array.isArray(data.points) || data.points.length > 5)
            throw new Error("Invalid touch input");
          const points = data.points.map((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Invalid touch point");
            const id = value.id;
            if (
              typeof id !== "number" ||
              typeof value.x !== "number" ||
              typeof value.y !== "number"
            )
              throw new Error("Invalid touch point numbers");
            if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647)
              throw new Error("Invalid touch identifier");
            return { x: Number(value.x), y: Number(value.y), id };
          });
          if (new Set(points.map((point) => point.id)).size !== points.length)
            throw new Error("Duplicate touch identifiers");
          const type = data.type;
          if (type !== "start" && type !== "move" && type !== "end" && type !== "cancel")
            throw new Error("Invalid touch phase");
          if ((type === "end" || type === "cancel") !== (points.length === 0))
            throw new Error("Invalid touch phase points");
          const nativeType =
            type === "start"
              ? "touchStart"
              : type === "move"
                ? "touchMove"
                : type === "end"
                  ? "touchEnd"
                  : "touchCancel";
          await owned.runtime.touch(nativeType, points, gestureId);
          return null;
        }
        case "input.key":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.dispatchKey(browserGestureKeySchema.parse(data.event), gestureId);
          return null;
        case "input.text":
          if (
            !gestureId ||
            typeof data.text !== "string" ||
            data.text.length < 1 ||
            data.text.length > 16_000
          ) {
            throw new Error("Invalid committed text input");
          }
          await owned.runtime.insertText(data.text, gestureId);
          return null;
        case "text.insert":
          await owned.runtime.insertText(String(data.text), gestureId);
          return null;
        case "key.down":
          await owned.runtime.keyDown(String(data.key), String(data.key), gestureId);
          return null;
        case "key.up":
          await owned.runtime.keyUp(String(data.key), String(data.key), gestureId);
          return null;
        default:
          throw new Error(`Unknown browser runtime operation: ${operation}`);
      }
    },
    async stop(owned) {
      try {
        await owned.runtime.shutdown();
      } finally {
        await owned.display?.stop();
      }
    },
  };
}
