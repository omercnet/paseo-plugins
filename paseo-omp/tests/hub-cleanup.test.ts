import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ProviderConnection } from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type HubServiceOwners,
  type OwnedHubCleanupResult,
  ownedHubCleanupDependencies,
  readFailure,
  stopOwnedHubProcesses,
} from "../server/hub";
import type { OmpOperationalFailure } from "../server/operational-failure-diagnostics";
import { ompHubRunDir } from "../server/paths";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import type { OmpStartOptions } from "../server/provider/omp-rpc-environment";
import { createOmpProvider } from "../server/provider/registration";
import {
  createHarness,
  EventLog,
  FakeOmpRuntime,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  openSession,
  sessionAt,
  TEST_RUNTIME_ENV,
} from "./helpers/provider-harness";

const PROJECT = "/workspace/project";
const OWNER = "01a1d075-838f-70bd-a76e-3761451eae39";
const OWNED: HubServiceOwners = new Map([[OWNER, Number.POSITIVE_INFINITY]]);
const temporaryDirectories: string[] = [];

beforeEach(() => {
  // Every test passes its own run dir; the ambient override must never leak in or out.
  vi.stubEnv("PASEO_OMP_RUN_DIR", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
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
  createdAt?: number;
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
        ...(daemon.createdAt === undefined ? {} : { createdAt: daemon.createdAt }),
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
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([
        [OWNER, Number.POSITIVE_INFINITY],
        ["branch-session", Number.POSITIVE_INFINITY],
      ]),
      {
        ...ownedHubCleanupDependencies(async (args) => {
          commands.push([...args]);
          await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
          return true;
        }, root),
        ...fakeClock(),
      },
    );

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

  test("stops a released session id's services only if they started before the hand-off", async () => {
    const root = await runDir({
      before: { owner: "released", createdAt: 1_000 },
      after: { owner: "released", createdAt: 3_000 },
      unknown: { owner: "released" },
      live: { createdAt: 9_000 },
    });
    const commands: string[] = [];
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([
        [OWNER, Number.POSITIVE_INFINITY],
        ["released", 2_000],
      ]),
      {
        ...ownedHubCleanupDependencies(async (args) => {
          commands.push(args.at(-1) ?? "");
          await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
          return true;
        }, root),
        ...fakeClock(),
      },
    );
    expect(commands.sort()).toEqual(["before", "live"]);
    expect(result.failed).toEqual([]);
    expect(await stateOf(root, "after")).toBe("running");
    expect(await stateOf(root, "unknown")).toBe("running");
  });

  test("never reports a service as stopped until OMP's metadata settles", async () => {
    const root = await runDir({ stuck: {}, refused: {} });
    const clock = fakeClock();
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...ownedHubCleanupDependencies(async (args) => {
          // `stuck` acknowledges the stop but its broker never records a terminal state.
          if (args.at(-1) === "stuck") await writeDaemon(root, "stuck", { state: "stopping" });
          return args.at(-1) === "stuck";
        }, root),
        ...clock,
      },
    );
    expect(result).toEqual({
      stopped: [],
      failed: expect.arrayContaining(["stuck", "refused"]),
      complete: true,
    });
    expect(clock.now()).toBeGreaterThanOrEqual(3_000);
  });

  test("bounds the discovery and verification scans by the same deadline", async () => {
    const root = await runDir({ web: {} });
    const real = ownedHubCleanupDependencies(async () => true, root);
    const hung = new Promise<never>(() => {});
    let stops = 0;
    const discovery = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...real,
        ...fakeClock(),
        scan: () => hung,
        expire: () => ({ fired: Promise.resolve(), cancel: () => {} }),
        stop: async () => {
          stops += 1;
          return true;
        },
      },
    );
    expect(discovery).toEqual({ stopped: [], failed: [], complete: false });
    expect(stops).toBe(0);

    let scans = 0;
    const verification = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...real,
        ...fakeClock(),
        scan: (cwd) => (scans++ === 0 ? real.scan(cwd) : hung),
        expire: (ms) => ({
          fired: scans === 0 ? new Promise<void>(() => {}) : Promise.resolve(),
          cancel: () => expect(ms).toBeLessThanOrEqual(12_000),
        }),
      },
    );
    expect(verification).toEqual({ stopped: [], failed: ["web"], complete: true });
  });

  test("treats a record it cannot read after the stop as not stopped", async () => {
    const root = await runDir({ web: {}, api: {} });
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...ownedHubCleanupDependencies(async (args) => {
          const name = args.at(-1) ?? "";
          if (name === "api") await writeDaemon(root, name, { state: "exited" });
          // A partly written or corrupt record is unknown, never proof the service settled.
          else await writeFile(join(root, "0123456789abcdef", "daemons", name, "meta.json"), "{");
          return true;
        }, root),
        ...fakeClock(),
      },
    );
    expect(result).toEqual({ stopped: ["api"], failed: ["web"], complete: true });
  });

  test("reports an incomplete lookup when a record is corrupt before any stop", async () => {
    const root = await runDir({ web: {}, broken: {} });
    await writeFile(join(root, "0123456789abcdef", "daemons", "broken", "meta.json"), "{");
    const stopped: string[] = [];
    const result = await stopOwnedHubProcesses(PROJECT, OWNED, {
      ...ownedHubCleanupDependencies(async (args) => {
        stopped.push(args.at(-1) ?? "");
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      }, root),
      ...fakeClock(),
    });
    // `broken` may be ours: the live one still stops, but the lookup is reported incomplete.
    expect(stopped).toEqual(["web"]);
    expect(result).toEqual({ stopped: ["web"], failed: [], complete: false });
    const none = await stopOwnedHubProcesses(PROJECT, new Map([["someone-else", Infinity]]), {
      ...ownedHubCleanupDependencies(async () => true, root),
      ...fakeClock(),
    });
    expect(none).toEqual({ stopped: [], failed: [], complete: false });
  });

  test("treats an owned record that is no longer a directory as not stopped", async () => {
    const root = await runDir({ web: {}, api: {} });
    const daemons = join(root, "0123456789abcdef", "daemons");
    // omp skips non-directory entries, so a stray file is not a service.
    await writeFile(join(daemons, ".DS_Store"), "");
    const result = await stopOwnedHubProcesses(PROJECT, OWNED, {
      ...ownedHubCleanupDependencies(async (args) => {
        const name = args.at(-1) ?? "";
        if (name === "api") await writeDaemon(root, name, { state: "exited" });
        else {
          await rm(join(daemons, name), { recursive: true });
          await writeFile(join(daemons, name), "");
        }
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
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...ownedHubCleanupDependencies(async (args) => {
          await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
          return true;
        }, root),
        ...fakeClock(),
      },
    );
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
      const result = await stopOwnedHubProcesses(
        cwd,
        new Map([[OWNER, Number.POSITIVE_INFINITY]]),
        {
          ...ownedHubCleanupDependencies(async (args) => {
            await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
            return true;
          }, root),
          ...fakeClock(),
        },
      );
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
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
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
      },
    );

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
    const result = await stopOwnedHubProcesses(
      PROJECT,
      new Map([[OWNER, Number.POSITIVE_INFINITY]]),
      {
        ...ownedHubCleanupDependencies(async () => {
          commands += 1;
          return true;
        }, root),
        ...fakeClock(),
      },
    );
    expect(result).toEqual({ stopped: [], failed: [], complete: true });
    expect(commands).toBe(0);
  });

  // OMP strips `--profile` before it looks for the subcommand, so any bare flag left in front of
  // `ps` would take it as its value.
  for (const [command, launcher] of [
    [
      ["npx", "--yes", "omp", "--profile", "work"],
      ["npx", ["--yes", "omp"]],
    ],
    [
      ["omp", "--resume", "--profile", "work"],
      ["omp", []],
    ],
    [
      ["omp", "--weird", "--profile=work"],
      ["omp", []],
    ],
    [
      ["bunx", "omp", "--profile", "work", "--mode", "rpc-ui", "--resume"],
      ["bunx", ["omp", "--mode", "rpc-ui"]],
    ],
  ] as const) {
    test(`runs omp ps through ${command.join(" ")} in the profile's own broker root`, async () => {
      const home = await mkdtemp(join(tmpdir(), "paseo-omp-hub-home-"));
      temporaryDirectories.push(home);
      // Named profiles keep their brokers under their own config root (pi-utils 18.18.9+).
      const root = join(home, ".omp", "profiles", "work", "run", "daemons");
      await mkdir(root, { recursive: true });
      await runDir({ web: {} }, root);
      await runDir({ elsewhere: {} }, join(home, ".omp", "run", "daemons"));
      const calls: Array<{ command: string; args: readonly string[]; env: string[] }> = [];
      const runtime = new OmpRpcRuntime({
        environment: { PATH: "/usr/bin", HOME: home },
        runOmpCommand: async (command, args, env, cwd) => {
          expect(cwd).toBe(PROJECT);
          calls.push({ command, args, env: [env.HOME ?? "", env.OMP_PROFILE ?? ""] });
          await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
          return true;
        },
      });
      {
        const result = await runtime.stopOwnedServices(
          { cwd: PROJECT, command: [...command] },
          new Map([[OWNER, Number.POSITIVE_INFINITY]]),
        );
        expect(result).toEqual({ stopped: ["web"], failed: [], complete: true });
        expect(calls).toEqual([
          {
            command: launcher[0],
            args: [...launcher[1], "ps", "stop", "--dir", PROJECT, "--", "web"],
            env: [home, "work"],
          },
        ]);
      }
    });
  }

  // An env wrapper can move OMP to another profile or store root (or change PATH, or clear the
  // environment) in ways the plugin cannot follow, so cleanup fails closed instead of guessing.
  for (const command of [
    ["env", "OMP_PROFILE=other", "omp", "--profile", "work"],
    ["env", "PATH=/x", "omp"],
    ["env", "-i", "OMP_PROFILE=work", "omp"],
    ["/usr/bin/env", "omp"],
    ["OMP_PROFILE=work", "omp"],
  ]) {
    test(`runs no omp ps and reports an unsupported launcher for ${command.join(" ")}`, async () => {
      const root = await runDir({ web: {} });
      let runs = 0;
      const runtime = new OmpRpcRuntime({
        environment: { PATH: "/usr/bin", HOME: "/home/test" },
        hubRunDir: root,
        runOmpCommand: async () => {
          runs += 1;
          return true;
        },
      });
      const result = await runtime.stopOwnedServices({ cwd: PROJECT, command }, OWNED);
      expect(result).toEqual({
        stopped: [],
        failed: [],
        complete: false,
        unsupportedLauncher: true,
      });
      expect(runs).toBe(0);
      expect(await stateOf(root, "web")).toBe("running");
    });
  }

  test("still stops services through a plain bunx omp launcher", async () => {
    const root = await runDir({ web: {} });
    const calls: string[][] = [];
    const runtime = new OmpRpcRuntime({
      environment: { PATH: "/usr/bin", HOME: "/home/test" },
      hubRunDir: root,
      runOmpCommand: async (command, args) => {
        calls.push([command, ...args]);
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      },
    });
    const result = await runtime.stopOwnedServices(
      { cwd: PROJECT, command: ["bunx", "omp"] },
      OWNED,
    );
    expect(result).toEqual({ stopped: ["web"], failed: [], complete: true });
    expect(calls).toEqual([["bunx", "omp", "ps", "stop", "--dir", PROJECT, "--", "web"]]);
  });

  test("treats only ENOENT as a gone record and any other read error as unknown", () => {
    expect(readFailure(Object.assign(new Error("gone"), { code: "ENOENT" }))).toEqual({
      missing: true,
    });
    for (const code of ["ENOTDIR", "EACCES", "EIO", undefined]) {
      expect(readFailure(Object.assign(new Error("read failed"), { code }))).toEqual({
        unreadable: true,
      });
    }
  });

  test("ignores stray files beside broker scopes", async () => {
    const root = await runDir({ web: {} });
    await writeFile(join(root, ".DS_Store"), "");
    const result = await stopOwnedHubProcesses(PROJECT, OWNED, {
      ...ownedHubCleanupDependencies(async (args) => {
        await writeDaemon(root, args.at(-1) ?? "", { state: "exited" });
        return true;
      }, root),
      ...fakeClock(),
    });
    expect(result).toEqual({ stopped: ["web"], failed: [], complete: true });
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
  lastOwners: HubServiceOwners = new Map();
  result: OwnedHubCleanupResult = { stopped: [], failed: [], complete: true };
  async stopOwnedServices(
    options: OmpStartOptions,
    owners: HubServiceOwners,
  ): Promise<OwnedHubCleanupResult> {
    this.lastOwners = owners;
    this.cleanups.push({
      cwd: options.cwd,
      owners: [...owners.keys()],
      nativeCloses: this.sessions.reduce((count, session) => count + session.closes, 0),
    });
    return this.result;
  }
}

async function closeSession(connection: ProviderConnection, events: EventLog, requestId: string) {
  await connection.send({ type: "session.close", requestId, sessionId: "session-1" });
  return events.waitFor(
    (event) =>
      (event.type === "request.completed" || event.type === "request.failed") &&
      event.requestId === requestId,
  );
}

describe("closing an OMP agent", () => {
  test("stops the Hub services its OMP session owns after the OMP tree is gone", async () => {
    const runtime = new HubCleanupRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);

    await closeSession(connection, events, "close-1");

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

    const outcome = await closeSession(connection, events, "close-2");

    expect(outcome.type).toBe("request.failed");
    expect(runtime.cleanups).toEqual([]);
  });

  test("records an unsupported launcher as its own failure", async () => {
    const failures: OmpOperationalFailure[] = [];
    const runtime = new HubCleanupRuntime();
    runtime.result = { stopped: [], failed: [], complete: false, unsupportedLauncher: true };
    const { connection, events } = await createHarness(
      runtime,
      undefined,
      undefined,
      undefined,
      (failure) => failures.push(failure),
    );
    await openSession(connection, events);

    await closeSession(connection, events, "close-launcher");

    expect(failures).toEqual([
      { category: "session-close", stage: "hub-cleanup-unsupported-launcher" },
    ]);
    await connection.close();
  });

  for (const [label, result, recorded] of [
    ["the lookup is incomplete", { stopped: [], failed: [], complete: false }, true],
    ["a service did not stop", { stopped: ["api"], failed: ["web"], complete: true }, true],
    ["every service stopped", { stopped: ["web"], failed: [], complete: true }, false],
  ] as const) {
    test(`${recorded ? "records" : "records no"} failure when ${label}`, async () => {
      const failures: OmpOperationalFailure[] = [];
      const runtime = new HubCleanupRuntime();
      runtime.result = {
        stopped: [...result.stopped],
        failed: [...result.failed],
        complete: result.complete,
      };
      const { connection, events } = await createHarness(
        runtime,
        undefined,
        undefined,
        undefined,
        (failure) => failures.push(failure),
      );
      await openSession(connection, events);

      await closeSession(connection, events, "close-3");

      expect(failures).toEqual(
        recorded ? [{ category: "session-close", stage: "hub-cleanup" }] : [],
      );
      await connection.close();
    });
  }

  test("still stops Hub services when only an MCP host-tool tree fails to close", async () => {
    const runtime = new HubCleanupRuntime();
    const connection = await createOmpProvider({
      runtime,
      timelineScheduler: new ManualScheduler(),
      environment: TEST_RUNTIME_ENV,
      mcpConnector: async () => ({
        listTools: async () => ({ tools: [{ name: "read", inputSchema: { type: "object" } }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          throw new Error("MCP tree cleanup failed");
        },
      }),
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(
      connection,
      events,
      "open-mcp",
      "session-1",
      {},
      MODEL_PUBLIC_ID,
      "medium",
      false,
      {
        mcpServers: { repo: { type: "stdio", command: "repo" } },
      },
    );

    const outcome = await closeSession(connection, events, "close-4");

    expect(outcome.type).toBe("request.failed");
    expect(runtime.cleanups).toEqual([
      { cwd: runtime.starts[0]?.cwd, owners: [NATIVE_SESSION_ID], nativeCloses: 1 },
    ]);
  });

  for (const cleanupFails of [false, true]) {
    test(`after a committed rewind fails, ${cleanupFails ? "skips" : "stops"} Hub services ${cleanupFails ? "when the OMP tree is unverified" : "for every OMP session id"}`, async () => {
      const branched = "01a08f6b-8da9-72cb-9080-fc50139bdfd3";
      const runtime = new HubCleanupRuntime();
      runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
      runtime.nextHistoryMessages = [{ role: "user", entryId: "replay-entry", content: "earlier" }];
      const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
        "prompt.message",
        "session.list",
        "session.persistence",
        "session.revert.conversation",
      ]);
      await connection.send({
        type: "session.open",
        requestId: "rewind-open",
        sessionId: "session-1",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === "rewind-open",
      );
      const user = events.find(
        (event) => event.type === "timeline.item" && event.item.type === "user_message",
      );
      if (user?.type !== "timeline.item" || user.item.type !== "user_message") {
        throw new Error("Missing rewind token");
      }
      const session = sessionAt(runtime);
      if (cleanupFails) session.closeError = new Error("cleanup failed");
      session.branchSessionIdAfter = branched;
      session.branchHistoryErrorAfter = new Error("replay failed");

      await connection.send({
        type: "session.revert",
        requestId: "rewind",
        sessionId: "session-1",
        token: user.item.revertToken ?? null,
        scope: "conversation",
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === "rewind",
      );

      expect(runtime.cleanups).toEqual(
        cleanupFails
          ? []
          : [{ cwd: "/repo", owners: [NATIVE_SESSION_ID, branched], nativeCloses: 1 }],
      );
      if (!cleanupFails) {
        // The released id keeps only the services it started before the branch.
        expect(runtime.lastOwners.get(NATIVE_SESSION_ID)).toBeLessThanOrEqual(Date.now());
        expect(runtime.lastOwners.get(branched)).toBe(Number.POSITIVE_INFINITY);
      }
    });
  }
});
