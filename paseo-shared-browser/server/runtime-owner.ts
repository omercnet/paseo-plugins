import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentBrowserRuntime, type BrowserViewport } from "./agent-browser-runtime";
import type { JsonValue } from "./runtime-protocol";
import type { RuntimeOwner } from "./supervisor";

const DEFAULT_BROWSER_URL = "https://example.com/";

interface OwnedRuntime {
  runtimeId: string;
  runtime: AgentBrowserRuntime;
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export async function createRuntimeOwner(): Promise<RuntimeOwner<OwnedRuntime>> {
  const root = join(paseoHome(), "plugin-data", "shared-browser");
  const binaryPath =
    process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ??
    join(root, "runtime", "node_modules", ".bin", "agent-browser");
  const executablePath =
    process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ??
    join(root, "runtime", "chromium", "chrome");
  return {
    async create(workspaceId) {
      const hash = createHash("sha256").update(workspaceId).digest("hex");
      const runtime = new AgentBrowserRuntime({
        binaryPath,
        executablePath,
        profilePath: join(root, "profiles", hash),
        ipcDirectory: join(root, "ipc"),
        session: `ws-${hash.slice(0, 16)}`,
        initialUrl: DEFAULT_BROWSER_URL,
      });
      await runtime.launch();
      return { runtimeId: randomUUID(), runtime };
    },
    async request(owned, operation, input) {
      const data =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, JsonValue>)
          : {};
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
          await owned.runtime.mouseMove(Number(data.x), Number(data.y));
          return null;
        case "mouse.down":
          await owned.runtime.mouseDown(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
          );
          return null;
        case "mouse.up":
          await owned.runtime.mouseUp(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
          );
          return null;
        case "mouse.wheel":
          await owned.runtime.wheel(
            Number(data.x),
            Number(data.y),
            Number(data.deltaX),
            Number(data.deltaY),
          );
          return null;
        case "text.insert":
          await owned.runtime.insertText(String(data.text));
          return null;
        case "key.down":
          await owned.runtime.keyDown(String(data.key));
          return null;
        case "key.up":
          await owned.runtime.keyUp(String(data.key));
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
