import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listHubProcessesFrom,
  resolveListHubProcesses,
  resolveTailHubLog,
  tailHubLogFrom,
} from "../server/hub";

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
      application: "bun",
      args: ["run", "dev"],
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
      application: "bun",
      args: ["run", "dev"],
      state: "running",
      owner: "omp-session-1",
      restartCount: 2,
      persist: true,
    });
    expect(processes[1]?.exitCode).toBe(0);
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
    const previous = process.env.PASEO_OMP_RUN_DIR;
    process.env.PASEO_OMP_RUN_DIR = root;
    try {
      await expect(resolveListHubProcesses({ cwd: "/workspace" })).resolves.toEqual({
        processes: [expect.objectContaining({ name: "worker", state: "running" })],
      });
      await expect(resolveTailHubLog({ cwd: "/workspace", name: "worker" })).resolves.toEqual({
        content: "ready",
        truncated: false,
      });
      await expect(resolveTailHubLog({ cwd: "/workspace", name: "missing" })).resolves.toEqual({
        content: "",
        truncated: false,
      });
    } finally {
      if (previous === undefined) delete process.env.PASEO_OMP_RUN_DIR;
      else process.env.PASEO_OMP_RUN_DIR = previous;
    }
  });
});
