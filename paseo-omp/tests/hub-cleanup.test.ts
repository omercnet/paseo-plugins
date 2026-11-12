import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type OwnedHubCleanupResult,
  ownedHubCleanupDependencies,
  stopOwnedHubProcesses,
} from "../server/hub";
import { ompHubRunDir } from "../server/paths";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import type { OmpStartOptions } from "../server/provider/omp-rpc-environment";
import {
  createHarness,
  FakeOmpRuntime,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
} from "./helpers/provider-harness";

const PROJECT = "/workspace/project";
const OWNER = "01a1d075-838f-70bd-a76e-3761451eae39";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface DaemonFixture {
  state?: string;
  owner?: string;
  persist?: boolean;
  detached?: boolean;
}

async function runDir(daemons: Record<string, DaemonFixture>, root?: string): Promise<string> {
  if (root === undefined) {
    root = await mkdtemp(join(tmpdir(), "paseo-omp-hub-cleanup-"));
    temporaryDirectories.push(root);
  }
  await mkdir(join(root, "0123456789abcdef"), { recursive: true });
  await writeFile(
    join(root, "0123456789abcdef", "scope.json"),
    JSON.stringify({ projectDir: PROJECT }),
  );
  for (const [name, daemon] of Object.entries(daemons)) await writeDaemon(root, name, daemon);
  return root;
}

async function writeDaemon(root: string, name: string, daemon: DaemonFixture): Promise<void> {
  const dir = join(root, "0123456789abcdef", "daemons", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({
      daemon: {
        state: daemon.state ?? "running",
        owner: daemon.owner ?? OWNER,
        persist: daemon.persist ?? true,
        detached: daemon.detached ?? false,
      },
    }),
  );
  await writeFile(join(dir, "spec.json"), JSON.stringify({ application: "sleep", args: ["3600"] }));
}

async function stateOf(root: string, name: string): Promise<string> {
  const meta = JSON.parse(
    await readFile(join(root, "0123456789abcdef", "daemons", name, "meta.json"), "utf8"),
  ) as { daemon: { state: string } };
  return meta.daemon.state;
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("owned Hub service cleanup", () => {
  test("stops only live, persistent, attached services owned by the closed sessions", async () => {
    const root = await runDir({
      "canary-sleeper-1": {},
      "earlier-branch": { owner: "branch-session", state: "ready" },
      "other-agent": { owner: "someone-else" },
      handed_off: { detached: true },
      "pre-18-18-9": { persist: false },
      finished: { state: "exited" },
      "-flag-like": {},
    });
    const commands: string[][] = [];
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER, "branch-session"]), {
      ...ownedHubCleanupDependencies(async (args) => {
        commands.push([...args]);
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      }, root),
      ...fakeClock(),
    });

    expect(commands.sort()).toEqual([
      ["ps", "stop", "--dir", PROJECT, "--", "canary-sleeper-1"],
      ["ps", "stop", "--dir", PROJECT, "--", "earlier-branch"],
    ]);
    expect(result).toEqual({
      stopped: expect.arrayContaining(["canary-sleeper-1", "earlier-branch"]),
      failed: [],
      complete: true,
    });
    expect(await stateOf(root, "other-agent")).toBe("running");
    expect(await stateOf(root, "handed_off")).toBe("running");
    expect(await stateOf(root, "pre-18-18-9")).toBe("running");
  });

  test("never reports a service as stopped until OMP's metadata settles", async () => {
    const root = await runDir({ stuck: {}, refused: {} });
    const clock = fakeClock();
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER]), {
      ...ownedHubCleanupDependencies(async (args) => {
        // `stuck` acknowledges the stop but its broker never records a terminal state.
        if (args.at(-1) === "stuck") await writeDaemon(root, "stuck", { state: "stopping" });
        return args.at(-1) === "stuck";
      }, root),
      ...clock,
    });
    expect(result).toEqual({
      stopped: [],
      failed: expect.arrayContaining(["stuck", "refused"]),
      complete: true,
    });
    expect(clock.now()).toBeGreaterThanOrEqual(3_000);
  });

  test("treats a record it cannot read after the stop as not stopped", async () => {
    const root = await runDir({ web: {}, api: {} });
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER]), {
      ...ownedHubCleanupDependencies(async (args) => {
        const name = args.at(-1) ?? "";
        if (name === "api") await writeDaemon(root, name, { state: "exited" });
        // A partly written or corrupt record is unknown, never proof the service settled.
        else await writeFile(join(root, "0123456789abcdef", "daemons", name, "meta.json"), "{");
        return true;
      }, root),
      ...fakeClock(),
    });
    expect(result).toEqual({ stopped: ["api"], failed: ["web"], complete: true });
  });

  test("reports an incomplete lookup when a project's records cannot be read", async () => {
    const root = await runDir({ web: {} });
    await mkdir(join(root, "fedcba9876543210"));
    await writeFile(join(root, "fedcba9876543210", "scope.json"), "{");
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER]), {
      ...ownedHubCleanupDependencies(async (args) => {
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      }, root),
      ...fakeClock(),
    });
    expect(result).toEqual({ stopped: [], failed: ["web"], complete: false });
  });

  test("finds a project's services through a symlinked or trailing-slash cwd", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "paseo-omp-hub-cwd-")));
    temporaryDirectories.push(base);
    const project = join(base, "project");
    const link = join(base, "link");
    await mkdir(project);
    await symlink(project, link, "junction");
    const root = await runDir({ web: {} });
    await writeFile(
      join(root, "0123456789abcdef", "scope.json"),
      JSON.stringify({ projectDir: project }),
    );
    for (const cwd of [link, `${project}${sep}`]) {
      await writeDaemon(root, "web", {});
      const result = await stopOwnedHubProcesses(cwd, new Set([OWNER]), {
        ...ownedHubCleanupDependencies(async (args) => {
          await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
          return true;
        }, root),
        ...fakeClock(),
      });
      expect(result).toEqual({ stopped: ["web"], failed: [], complete: true });
    }
  });

  test("bounds every stop command under one deadline and runs a few at once", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `hung-${index}`);
    const root = await runDir(Object.fromEntries(names.map((name) => [name, {}])));
    let now = 0;
    let running = 0;
    let peak = 0;
    const timeouts: number[] = [];
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER]), {
      ...ownedHubCleanupDependencies(async (_args, timeoutMs) => {
        // A hung CLI only returns when the runner kills it at its timeout.
        const started = now;
        timeouts.push(timeoutMs);
        running += 1;
        peak = Math.max(peak, running);
        await setImmediate();
        now = Math.max(now, started + timeoutMs);
        running -= 1;
        return false;
      }, root),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toEqual({ stopped: [], failed: expect.arrayContaining(names), complete: true });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(10_000);
    // One 12s deadline for stops and verification, however many services hang.
    expect(now).toBeLessThanOrEqual(12_100);
  });

  test("runs nothing when the sessions own no live persistent service", async () => {
    const root = await runDir({ "pre-18-18-9": { persist: false } });
    let commands = 0;
    const result = await stopOwnedHubProcesses(PROJECT, new Set([OWNER]), {
      ...ownedHubCleanupDependencies(async () => {
        commands += 1;
        return true;
      }, root),
      ...fakeClock(),
    });
    expect(result).toEqual({ stopped: [], failed: [], complete: true });
    expect(commands).toBe(0);
  });

  test("keeps a launcher prefix and reaches the profile's own broker root", async () => {
    vi.stubEnv("PASEO_OMP_RUN_DIR", undefined);
    const home = await mkdtemp(join(tmpdir(), "paseo-omp-hub-home-"));
    temporaryDirectories.push(home);
    // Named profiles keep their brokers under their own config root (pi-utils 18.18.9+).
    const root = join(home, ".omp", "profiles", "work", "run", "daemons");
    await mkdir(root, { recursive: true });
    await runDir({ web: {} }, root);
    await runDir({ elsewhere: {} }, join(home, ".omp", "run", "daemons"));
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; env: string }> = [];
    const runtime = new OmpRpcRuntime({
      environment: { PATH: "/usr/bin", HOME: home },
      runOmpCommand: async (command, args, env, cwd) => {
        calls.push({ command, args, cwd, env: env.HOME ?? "" });
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      },
    });
    try {
      const result = await runtime.stopOwnedServices(
        {
          cwd: PROJECT,
          // A trailing bare flag would take `ps` as its value, so it never reaches the CLI.
          command: ["npx", "--yes", "omp", "--profile", "work", "--resume"],
        },
        new Set([OWNER]),
      );
      expect(result).toEqual({ stopped: ["web"], failed: [], complete: true });
      expect(calls).toEqual([
        {
          command: "npx",
          args: ["--yes", "omp", "--profile", "work", "ps", "stop", "--dir", PROJECT, "--", "web"],
          cwd: PROJECT,
          env: home,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("resolves the broker root from the profile environment", () => {
    const home = join(tmpdir(), "paseo-omp-hub-no-such-home");
    expect(ompHubRunDir({ HOME: home }, "linux")).toBe(join(home, ".omp", "run", "daemons"));
    expect(ompHubRunDir({ HOME: home, OMP_PROFILE: "work" }, "linux")).toBe(
      join(home, ".omp", "profiles", "work", "run", "daemons"),
    );
  });
});

class HubCleanupRuntime extends FakeOmpRuntime {
  readonly cleanups: Array<{ cwd: string; owners: string[]; nativeCloses: number }> = [];
  async stopOwnedServices(
    options: OmpStartOptions,
    owners: ReadonlySet<string>,
  ): Promise<OwnedHubCleanupResult> {
    this.cleanups.push({
      cwd: options.cwd,
      owners: [...owners],
      nativeCloses: this.sessions.reduce((count, session) => count + session.closes, 0),
    });
    return { stopped: [], failed: [], complete: true };
  }
}

describe("closing an OMP agent", () => {
  test("stops the Hub services its OMP session owns after the OMP tree is gone", async () => {
    const runtime = new HubCleanupRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-1",
    );

    expect(runtime.cleanups).toEqual([
      { cwd: runtime.starts[0]?.cwd, owners: [NATIVE_SESSION_ID], nativeCloses: 1 },
    ]);
    await connection.close();
  });

  test("leaves Hub services alone when the OMP tree cleanup is not verified", async () => {
    const runtime = new HubCleanupRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("native close failed");

    await connection.send({ type: "session.close", requestId: "close-2", sessionId: "session-1" });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "close-2",
    );

    expect(runtime.cleanups).toEqual([]);
  });
});
