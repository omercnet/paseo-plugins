import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  listHubProcessesFrom,
  resolveListHubProcesses,
  resolveTailHubLog,
  tailHubLogFrom,
} from "../server/hub";
import { writeDaemonUnits } from "./helpers/omp-daemon-store";

const temporaryDirectories: string[] = [];

async function createProcess(
  root: string,
  hash: string,
  projectDir: string,
  name: string,
  meta: unknown,
  log = "",
) {
  const daemonDir = join(root, hash, "daemons", name);
  await mkdir(daemonDir, { recursive: true });
  await writeFile(join(root, hash, "scope.json"), JSON.stringify({ projectDir }));
  await writeFile(join(daemonDir, "meta.json"), JSON.stringify(meta));
  await writeFile(join(daemonDir, "output.log"), log);
}

function meta(state: string, startedAt: number, exitCode?: number) {
  return {
    daemon: {
      state,
      owner: "omp-session-1",
      restartCount: 2,
      persist: true,
      detached: false,
      createdAt: startedAt - 1,
      startedAt,
      readyAt: startedAt + 1,
      ...(exitCode === undefined ? {} : { exitedAt: startedAt + 2, exitCode }),
    },
    spec: {
      application: "node",
      args: ["server.js"],
      cwd: "/workspace",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp hub state reader", () => {
  test("scopes processes by project cwd and orders newest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    await createProcess(root, "matching", "/workspace", "older", meta("exited", 100, 0));
    await createProcess(root, "matching", "/workspace", "newer", meta("running", 200));
    await createProcess(root, "foreign", "/other", "hidden", meta("running", 300));

    const processes = await listHubProcessesFrom(root, "/workspace");

    expect(processes.map((process) => process.name)).toEqual(["newer", "older"]);
    expect(processes[0]).toMatchObject({
      application: "node",
      args: ["server.js"],
      state: "running",
      owner: "omp-session-1",
      restartCount: 2,
      persist: true,
    });
    expect(processes[1]?.exitCode).toBe(0);
  });

  test("reads the spec from spec.json when meta.json has none (omp 18.8+)", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    const { spec, ...withoutSpec } = meta("running", 5);
    await createProcess(root, "split", "/workspace", "split", withoutSpec);
    await writeFile(join(root, "split", "daemons", "split", "spec.json"), JSON.stringify(spec));

    expect(await listHubProcessesFrom(root, "/workspace")).toMatchObject([
      { name: "split", application: "node", args: ["server.js"], cwd: "/workspace" },
    ]);
  });

  test("ignores malformed scope and process files", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    await createProcess(root, "valid", "/workspace", "good", meta("ready", 1));
    await createProcess(root, "valid", "/workspace", "bad", { daemon: { state: "running" } });
    await mkdir(join(root, "malformed"), { recursive: true });
    await writeFile(join(root, "malformed", "scope.json"), "not json");

    expect((await listHubProcessesFrom(root, "/workspace")).map((process) => process.name)).toEqual(
      ["good"],
    );
  });

  test("returns only the latest 64 KiB of a process log", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    const content = `${"a".repeat(1024)}${"z".repeat(64 * 1024)}`;
    await createProcess(root, "matching", "/workspace", "server", meta("running", 1), content);

    const result = await tailHubLogFrom(root, "/workspace", "server");

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("z".repeat(64 * 1024));
  });

  test("resolves process lists and logs through the configured run root", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-hub-resolver-"));
    temporaryDirectories.push(root);
    await createProcess(root, "project", "/workspace", "worker", meta("running", 7), "ready");
    const daemonDir = join(root, "daemon");
    await writeDaemonUnits(
      daemonDir,
      [{ id: "u1", key: "web", startedAt: 9, log: "listening" }],
      "/workspace",
    );
    const previous = {
      runDir: process.env.PASEO_OMP_RUN_DIR,
      daemonDir: process.env.PASEO_OMP_DAEMON_DIR,
    };
    process.env.PASEO_OMP_RUN_DIR = root;
    process.env.PASEO_OMP_DAEMON_DIR = daemonDir;
    try {
      await expect(resolveListHubProcesses({ cwd: "/workspace" })).resolves.toEqual({
        processes: [
          expect.objectContaining({ name: "web", state: "running" }),
          expect.objectContaining({ name: "worker", state: "running" }),
        ],
      });
      await expect(resolveTailHubLog({ cwd: "/workspace", name: "worker" })).resolves.toEqual({
        content: "ready",
        truncated: false,
      });
      await expect(resolveTailHubLog({ cwd: "/workspace", name: "web" })).resolves.toEqual({
        content: "listening",
        truncated: false,
      });
      await expect(resolveTailHubLog({ cwd: "/workspace", name: "missing" })).resolves.toEqual({
        content: "",
        truncated: false,
      });
    } finally {
      if (previous.runDir === undefined) delete process.env.PASEO_OMP_RUN_DIR;
      else process.env.PASEO_OMP_RUN_DIR = previous.runDir;
      if (previous.daemonDir === undefined) delete process.env.PASEO_OMP_DAEMON_DIR;
      else process.env.PASEO_OMP_DAEMON_DIR = previous.daemonDir;
    }
  });
});

describe("omp 19 daemon state reader", () => {
  async function roots(): Promise<{ root: string; daemonDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-daemon-"));
    temporaryDirectories.push(root);
    return { root: join(root, "run", "daemons"), daemonDir: join(root, "run", "daemon") };
  }

  test("lists the project's services from the daemon store beside broker records", async () => {
    const { root, daemonDir } = await roots();
    await createProcess(root, "matching", "/workspace", "legacy", meta("running", 150));
    await writeDaemonUnits(
      daemonDir,
      [
        {
          id: "u-web",
          key: "web",
          owner: "omp-session-2",
          startedAt: 300,
          createdAt: 299,
          command: "bun run dev",
        },
        { id: "u-old", key: "old", state: "exited", startedAt: 100, hold: "leases" },
        { id: "u-detached", key: "kept", startedAt: 200, hold: "detached" },
        { id: "u-other", key: "other-project", scopeKey: "project:/other", startedAt: 400 },
        { id: "u-global", key: "lsp", scopeKey: "global", startedAt: 500 },
        { id: "u-module", key: "speech", kind: "speech", startedAt: 600 },
      ],
      "/workspace",
    );

    const processes = await listHubProcessesFrom(root, "/workspace", daemonDir);

    expect(processes.map((process) => process.name)).toEqual(["web", "kept", "legacy", "old"]);
    expect(processes[0]).toEqual({
      name: "web",
      application: "bun run dev",
      args: [],
      cwd: "/workspace",
      state: "running",
      owner: "omp-session-2",
      restartCount: 0,
      persist: true,
      detached: false,
      createdAt: 299,
      startedAt: 300,
      readyAt: null,
      exitedAt: null,
      exitCode: null,
    });
    expect(processes[1]).toMatchObject({ persist: false, detached: true });
    expect(processes[3]).toMatchObject({ state: "exited", persist: false, detached: false });
  });

  test("ignores the daemon store unless a daemon directory is given", async () => {
    const { root, daemonDir } = await roots();
    await writeDaemonUnits(daemonDir, [{ id: "u1", key: "web" }], "/workspace");

    expect(await listHubProcessesFrom(root, "/workspace")).toEqual([]);
    expect(await listHubProcessesFrom(root, "/workspace", join(daemonDir, "absent"))).toEqual([]);
  });

  test("reports a running record whose main process is gone as exited", async () => {
    const { root, daemonDir } = await roots();
    // PIDs above the Linux and macOS maximum can never be alive.
    const deadPid = 2 ** 22 + 1;
    await writeDaemonUnits(
      daemonDir,
      [
        { id: "u-live", key: "live", pids: [process.pid], startedAt: 6 },
        { id: "u-dead", key: "dead", pids: [deadPid], startedAt: 5 },
        { id: "u-ready", key: "ready", state: "ready", pids: [deadPid], startedAt: 4 },
        // A live daemon may still be ending the tree or restarting the service.
        { id: "u-stopping", key: "stopping", state: "stopping", pids: [deadPid], startedAt: 3 },
        { id: "u-restart", key: "restart", state: "restarting", pids: [deadPid], startedAt: 2 },
        { id: "u-starting", key: "starting", state: "starting", pids: [], startedAt: 1 },
      ],
      "/workspace",
    );

    const processes = await listHubProcessesFrom(root, "/workspace", daemonDir);

    expect(processes.map(({ name, state }) => [name, state])).toEqual([
      ["live", "running"],
      ["dead", "exited"],
      ["ready", "exited"],
      ["stopping", "stopping"],
      ["restart", "restarting"],
      ["starting", "starting"],
    ]);
  });

  test("skips malformed snapshots and an unreadable store", async () => {
    const { root, daemonDir } = await roots();
    await createProcess(root, "matching", "/workspace", "legacy", meta("running", 1));
    await writeDaemonUnits(
      daemonDir,
      [
        { id: "u-good", key: "good", startedAt: 5 },
        { id: "u-bad", key: "bad", rawSnapshot: "{not json" },
        { id: "u-shape", key: "shape", rawSnapshot: JSON.stringify({ state: 7 }) },
      ],
      "/workspace",
    );
    expect(
      (await listHubProcessesFrom(root, "/workspace", daemonDir)).map((process) => process.name),
    ).toEqual(["good", "legacy"]);

    const corrupt = join(daemonDir, "..", "corrupt");
    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, "daemon.db"), "not a database");
    expect(
      (await listHubProcessesFrom(root, "/workspace", corrupt)).map((process) => process.name),
    ).toEqual(["legacy"]);
  });

  test("tails the newest daemon unit's log, preferring it over a broker record", async () => {
    const { root, daemonDir } = await roots();
    await createProcess(root, "matching", "/workspace", "web", meta("exited", 1, 0), "broker");
    await writeDaemonUnits(
      daemonDir,
      [
        { id: "u-old", key: "web", state: "exited", startedAt: 10, log: "old" },
        { id: "u-new", key: "web", startedAt: 20, log: `${"a".repeat(1024)}${"z".repeat(65536)}` },
        { id: "u-quiet", key: "quiet", startedAt: 30 },
      ],
      "/workspace",
    );

    expect(await tailHubLogFrom(root, "/workspace", "web", daemonDir)).toEqual({
      content: "z".repeat(64 * 1024),
      truncated: true,
    });
    expect(await tailHubLogFrom(root, "/workspace", "quiet", daemonDir)).toEqual({
      content: "",
      truncated: false,
    });
    expect(await tailHubLogFrom(root, "/workspace", "web")).toEqual({
      content: "broker",
      truncated: false,
    });
  });
});
