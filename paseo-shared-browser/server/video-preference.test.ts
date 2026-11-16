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

describe("launch-option relaunch against a live runtime registry", () => {
  /** One current runtime per workspace, like the supervisor; identity can be gated. */
  async function registry() {
    let next = 0;
    const current = new Map<string, string>();
    const stopped: string[] = [];
    const gate = { identity: null as Promise<void> | null, failEnsure: false };
    let counter = 0;
    const manager = new SessionManager({
      validateWorkspace: async () => true,
      issueToken: () => (++counter).toString().padStart(32, "0"),
      client: {
        connect: async () => ({ epoch: 1 }),
        ensureWorkspace: async (workspaceId) => {
          if (gate.failEnsure) throw new Error("launch failed");
          let runtimeId = current.get(workspaceId);
          if (!runtimeId) {
            runtimeId = String(++next).padStart(32, "r");
            current.set(workspaceId, runtimeId);
          }
          return { workspaceId, runtimeId, createdAt: 1 };
        },
        requestWorkspace: async (_workspace, operation, input) => {
          if (operation === "identity") {
            if (gate.identity) await gate.identity;
            const data = (input ?? {}) as { targetId?: string };
            return { userAgent: "Fixture", targetId: data.targetId ?? "root" };
          }
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
        closeWorkspace: async (workspaceId, runtimeId) => {
          if (current.get(workspaceId) === runtimeId) current.delete(workspaceId);
          stopped.push(runtimeId);
        },
        disconnect: () => {},
      },
    });
    await manager.connect();
    return { manager, current, stopped, gate };
  }

  it("never publishes a page whose creation overlapped the restart of its runtime", async () => {
    const { manager, current, stopped, gate } = await registry();
    const viewer = await manager.attach("workspace", "Viewer");
    const oldRuntime = viewer.state.runtimeId!;
    let release!: () => void;
    let late!: ReturnType<typeof manager.attach>;
    await manager.relaunchOpenBrowsers(
      viewer.viewerToken,
      async () => {},
      async () => {
        // A second-tab attachment starts after the relaunch drained pending creations.
        gate.identity = new Promise<void>((resolve) => {
          release = resolve;
        });
        late = manager.attach("workspace", "Late", "second");
        await new Promise((resolve) => setTimeout(resolve, 0));
        gate.identity = null;
        setTimeout(release, 5);
        return [{ workspaceId: "workspace", runtimeId: oldRuntime }];
      },
    );
    const attached = await late;
    expect(stopped).toEqual([oldRuntime]);
    expect(attached.state.runtimeId).toBe(current.get("workspace"));
    expect(attached.state.runtimeId).not.toBe(oldRuntime);
    manager.disconnect();
  });

  it("reports a restart whose replacement browser fails to launch", async () => {
    const { manager, gate } = await registry();
    const viewer = await manager.attach("workspace", "Viewer");
    const other = await manager.attach("other", "Viewer");
    await expect(
      manager.relaunchOpenBrowsers(
        other.viewerToken,
        async () => {
          gate.failEnsure = true;
        },
        async () => [{ workspaceId: "workspace", runtimeId: viewer.state.runtimeId! }],
      ),
    ).rejects.toThrow("Some browsers could not be restarted");
    manager.disconnect();
  });

  it("serializes concurrent identical toggles so the second sees nothing stale", async () => {
    const { manager, current, stopped } = await registry();
    const viewer = await manager.attach("workspace", "Viewer");
    const launchedWith = new Map<string, boolean>([[viewer.state.runtimeId!, false]]);
    let setting = false;
    const stale = async () =>
      [...current].flatMap(([workspaceId, runtimeId]) =>
        (launchedWith.get(runtimeId) ?? setting) !== setting ? [{ workspaceId, runtimeId }] : [],
      );
    const toggle = () =>
      manager.relaunchOpenBrowsers(
        viewer.viewerToken,
        async () => {
          setting = true;
        },
        stale,
      );
    await expect(Promise.all([toggle(), toggle()])).resolves.toBeDefined();
    expect(stopped).toEqual([viewer.state.runtimeId]);
    manager.disconnect();
  });

  it("drops a queued relaunch when the manager resets while it waits", async () => {
    const { manager } = await registry();
    const viewer = await manager.attach("workspace", "Viewer");
    let release!: () => void;
    const first = manager.relaunchOpenBrowsers(
      viewer.viewerToken,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      async () => [],
    );
    let applied = false;
    const queued = manager.relaunchOpenBrowsers(
      viewer.viewerToken,
      async () => {
        applied = true;
      },
      async () => [],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.reset();
    release();
    await first;
    await expect(queued).rejects.toThrow("Shared browser manager was reset");
    expect(applied).toBe(false);
    manager.disconnect();
  });
});
