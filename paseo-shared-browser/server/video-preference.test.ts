import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./browser-policy";
import { readVideoSettings, VIDEO_PREFERENCE_FILE, writeVideoEnabled } from "./video-preference";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "psb-video-"));
  roots.push(path);
  return join(path, "shared-browser");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("host encoded-video preference", () => {
  it("is disabled when missing or corrupt and persists an atomic choice", async () => {
    const dir = await root();
    expect(await readVideoSettings(dir, {})).toEqual({ enabled: false, forcedByHost: false });
    await writeVideoEnabled(dir, true);
    expect(await readVideoSettings(dir, {})).toEqual({ enabled: true, forcedByHost: false });
    expect(await readdir(dir)).toEqual([VIDEO_PREFERENCE_FILE]);
    expect(JSON.parse(await readFile(join(dir, VIDEO_PREFERENCE_FILE), "utf8"))).toEqual({
      enabled: true,
    });
    await writeFile(join(dir, VIDEO_PREFERENCE_FILE), "{not json");
    expect((await readVideoSettings(dir, {})).enabled).toBe(false);
    await writeFile(join(dir, VIDEO_PREFERENCE_FILE), JSON.stringify({ enabled: "yes" }));
    expect((await readVideoSettings(dir, {})).enabled).toBe(false);
  });

  it("the daemon environment forces video on over a persisted off", async () => {
    const dir = await root();
    await writeVideoEnabled(dir, false);
    expect(await readVideoSettings(dir, { PASEO_SHARED_BROWSER_VIDEO: "1" })).toEqual({
      enabled: true,
      forcedByHost: true,
    });
    expect(await readVideoSettings(dir, { PASEO_SHARED_BROWSER_VIDEO: "0" })).toEqual({
      enabled: false,
      forcedByHost: false,
    });
  });
});

describe("launch-option relaunch", () => {
  async function fixture() {
    let runtime = 0;
    const closed: string[] = [];
    const control = {
      failClose: false,
      ensureGate: null as Promise<void> | null,
    };
    let counter = 0;
    const manager = new SessionManager({
      validateWorkspace: async () => true,
      issueToken: () => (++counter).toString().padStart(32, "0"),
      client: {
        connect: async () => ({ epoch: 1 }),
        ensureWorkspace: async (workspaceId) => {
          if (control.ensureGate) await control.ensureGate;
          return {
            workspaceId,
            runtimeId: String(++runtime).padStart(32, "r"),
            createdAt: 1,
          };
        },
        requestWorkspace: async (_workspace, operation) => {
          if (operation === "identity") return { userAgent: "Fixture", targetId: "t" };
          if (operation === "state")
            return {
              url: "https://fixture.invalid/",
              title: "",
              canGoBack: false,
              canGoForward: false,
            };
          return null;
        },
        archiveWorkspace: async () => {},
        closeWorkspace: async (_workspace, runtimeId) => {
          if (control.failClose) throw new Error("stop failed");
          closed.push(runtimeId);
        },
        disconnect: () => {},
      },
    });
    await manager.connect();
    return { manager, closed, control };
  }

  it("relaunches open browsers on change; old tokens read as expired, not closed", async () => {
    const { manager, closed } = await fixture();
    const first = await manager.attach("workspace", "Viewer");
    await manager.relaunchOpenBrowsers(
      first.viewerToken,
      async () => {},
      async () => [{ workspaceId: "workspace", runtimeId: first.state.runtimeId! }],
    );
    expect(closed).toEqual([first.state.runtimeId]);
    await expect(manager.status(first.viewerToken)).rejects.toThrow(
      "Viewer token is invalid or expired",
    );
    const second = await manager.attach("workspace", "Viewer");
    expect(second.state.runtimeId).not.toBe(first.state.runtimeId);
    manager.disconnect();
  });

  it("does nothing without a stale runtime and refuses an invalid viewer", async () => {
    const { manager, closed } = await fixture();
    const viewer = await manager.attach("workspace", "Viewer");
    let applied = 0;
    await manager.relaunchOpenBrowsers(
      viewer.viewerToken,
      async () => {
        applied += 1;
      },
      async () => [],
    );
    expect(closed).toEqual([]);
    await expect(
      manager.relaunchOpenBrowsers(
        "x".repeat(32),
        async () => {
          applied += 1;
        },
        async () => [{ workspaceId: "workspace", runtimeId: viewer.state.runtimeId! }],
      ),
    ).rejects.toThrow("Viewer token is invalid or expired");
    expect(applied).toBe(1);
    manager.disconnect();
  });

  it("reports a failed stop and retries the same stale runtime on the next call", async () => {
    const { manager, closed, control } = await fixture();
    const viewer = await manager.attach("workspace", "Viewer");
    const stale = [{ workspaceId: "workspace", runtimeId: viewer.state.runtimeId! }];
    control.failClose = true;
    await expect(
      manager.relaunchOpenBrowsers(
        viewer.viewerToken,
        async () => {},
        async () => stale,
      ),
    ).rejects.toThrow("Some browsers could not be restarted");
    expect(closed).toEqual([]);
    // The failed stop dropped the policy session; the registry still lists the runtime.
    control.failClose = false;
    const retry = await manager.attach("other", "Viewer");
    await manager.relaunchOpenBrowsers(
      retry.viewerToken,
      async () => {},
      async () => stale,
    );
    expect(closed).toEqual([viewer.state.runtimeId]);
    manager.disconnect();
  });

  it("waits for a first attachment in flight before reading stale runtimes", async () => {
    const { manager, control } = await fixture();
    const viewer = await manager.attach("workspace", "Viewer");
    let release!: () => void;
    control.ensureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = manager.attach("late", "Viewer");
    let read = false;
    const relaunch = manager.relaunchOpenBrowsers(
      viewer.viewerToken,
      async () => {},
      async () => {
        read = true;
        return [];
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read).toBe(false);
    control.ensureGate = null;
    release();
    await pending;
    await relaunch;
    expect(read).toBe(true);
    manager.disconnect();
  });
});
