import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserGestureKeySchema } from "../shared/browser";
import { AgentBrowserRuntime, type BrowserViewport } from "./agent-browser-runtime";
import { resolveBrowserRuntimeRoot } from "./runtime-path";
import type { JsonValue } from "./runtime-protocol";
import type { RuntimeOwner } from "./supervisor";

const DEFAULT_BROWSER_URL = "https://example.com/";

interface OwnedRuntime {
  runtimeId: string;
  runtime: AgentBrowserRuntime;
}
interface RuntimeOwnerOptions {
  initialUrl?: string;
  headed?: boolean;
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
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
      const runtime = new AgentBrowserRuntime({
        binaryPath,
        executablePath,
        profilePath: join(root, "profiles", hash),
        ipcDirectory,
        session: `ws-${hash.slice(0, 16)}`,
        initialUrl: options.initialUrl ?? DEFAULT_BROWSER_URL,
        headed: options.headed ?? false,
      });
      await runtime.launch();
      return { runtimeId: randomUUID(), runtime };
    },
    async request(owned, operation, input) {
      const data =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, JsonValue>)
          : {};
      const gestureId = typeof data.gestureId === "string" ? data.gestureId : undefined;
      switch (operation) {
        case "identity":
          return owned.runtime.identity() as unknown as JsonValue;
        case "state":
          return owned.runtime.state() as unknown as JsonValue;
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
        case "screencast.start":
          await owned.runtime.startScreencast(Number(data.quality));
          return null;
        case "screencast.stop":
          await owned.runtime.stopScreencast();
          return null;
        case "frame":
          return (await owned.runtime.frame(
            Number(data.maxBytes),
            Number(data.quality),
            Number(data.waitMs),
          )) as unknown as JsonValue;
        case "mouse.move":
          await owned.runtime.mouseMove(Number(data.x), Number(data.y), gestureId);
          return null;
        case "mouse.down":
          await owned.runtime.mouseDown(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
          );
          return null;
        case "mouse.up":
          await owned.runtime.mouseUp(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
          );
          return null;
        case "mouse.wheel":
          await owned.runtime.wheel(
            Number(data.x),
            Number(data.y),
            Number(data.deltaX),
            Number(data.deltaY),
            gestureId,
          );
          return null;
        case "mouse.leave":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.mouseLeave(gestureId);
          return null;
        case "input.begin":
          if (!gestureId) throw new Error("Gesture identity is required");
          await owned.runtime.beginLiveInput(gestureId);
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
      await owned.runtime.shutdown();
    },
  };
}
