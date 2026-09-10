import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeOmpProviderHealth,
  resolveExecutablePath,
  type SpawnFn,
} from "../server/provider-diagnostics";
import { OmpProviderHealthSchema } from "../shared/provider-diagnostics";

const temporaryDirectories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function createFakeBinary(name = "omp"): Promise<{ dir: string; path: string }> {
  const dir = await tempDir("paseo-omp-bin-");
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return { dir, path };
}

type FakeChild = EventEmitter & {
  kill(signal?: NodeJS.Signals | number): boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

/** A spawnFn that replies to `--version` and `--help` with fixed stdout, then exits cleanly. */
function respondingSpawn(versionStdout: string, helpStdout: string): SpawnFn {
  return (_command, args) => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(args[0] === "--version" ? versionStdout : helpStdout));
      child.emit("close", 0);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

/** A spawnFn whose child never emits close/error, to exercise the bounded timeout path. */
function hangingSpawn(): SpawnFn {
  return () => createFakeChild() as unknown as ChildProcessWithoutNullStreams;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveExecutablePath", () => {
  test("finds an executable file across the given PATH-like directories", async () => {
    const { dir, path } = await createFakeBinary();
    const decoyDir = await tempDir("paseo-omp-bin-decoy-");
    expect(await resolveExecutablePath("omp", [decoyDir, dir])).toBe(path);
  });

  test("returns null when no directory has a matching executable", async () => {
    const decoyDir = await tempDir("paseo-omp-bin-decoy-");
    expect(await resolveExecutablePath("omp", [decoyDir])).toBeNull();
  });

  test("checks a literal path directly without walking PATH-like directories", async () => {
    const { path } = await createFakeBinary("custom-omp");
    expect(await resolveExecutablePath(path, ["/does/not/exist"])).toBe(path);
  });
});

describe("computeOmpProviderHealth", () => {
  test("reports installed, version, and rpc-ui support when the binary responds", async () => {
    const { dir, path } = await createFakeBinary();
    const agentDir = await tempDir("paseo-omp-agent-");
    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp",
      pathDirs: [dir],
      spawnFn: respondingSpawn("omp/18.1.15\n", "Output mode: text, json, rpc, or rpc-ui\n"),
    });

    expect(health.binary).toEqual({
      installed: true,
      resolvedPath: path,
      version: "18.1.15",
      versionStatus: "ok",
    });
    expect(health.rpcUi).toEqual({ checked: true, supported: true });
    expect(health.roots.agentRoot).toBe(agentDir);
    expect(health.roots.configAvailable).toBe(false);
    expect(health.roots.sessionRootAvailable).toBe(false);
    expect(health.databases).toEqual({ agentDbPresent: false, historyDbPresent: false });
    expect(health.memoryBackend).toBeNull();
    expect(OmpProviderHealthSchema.safeParse(health).success).toBe(true);
  });

  test("reports not-found without spawning when the binary cannot be resolved", async () => {
    const agentDir = await tempDir("paseo-omp-agent-");
    let spawnCalls = 0;
    const spawnFn: SpawnFn = () => {
      spawnCalls += 1;
      throw new Error("spawnFn must not be called for an unresolved binary");
    };

    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp-does-not-exist",
      pathDirs: [],
      spawnFn,
    });

    expect(health.binary).toEqual({
      installed: false,
      resolvedPath: null,
      version: null,
      versionStatus: "not-found",
    });
    expect(health.rpcUi).toEqual({ checked: false, supported: null });
    expect(spawnCalls).toBe(0);
  });

  test("reports a timeout instead of hanging when the probes never exit", async () => {
    const { dir } = await createFakeBinary();
    const agentDir = await tempDir("paseo-omp-agent-");

    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp",
      pathDirs: [dir],
      spawnFn: hangingSpawn(),
      versionTimeoutMs: 20,
      helpTimeoutMs: 20,
    });

    expect(health.binary.versionStatus).toBe("timeout");
    expect(health.binary.version).toBeNull();
    expect(health.rpcUi).toEqual({ checked: true, supported: null });
  });

  test("reports malformed when --version exits cleanly with no parsable version", async () => {
    const { dir } = await createFakeBinary();
    const agentDir = await tempDir("paseo-omp-agent-");

    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp",
      pathDirs: [dir],
      spawnFn: respondingSpawn("unexpected output\n", "no protocol modes documented\n"),
    });

    expect(health.binary.versionStatus).toBe("malformed");
    expect(health.binary.version).toBeNull();
    expect(health.rpcUi).toEqual({ checked: true, supported: false });
  });

  test("surfaces config-derived roots, database presence, and memory backend", async () => {
    const { dir } = await createFakeBinary();
    const agentDir = await tempDir("paseo-omp-agent-");
    await writeFile(join(agentDir, "agent.db"), "");
    await writeFile(join(agentDir, "history.db"), "");
    await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: mnemopi\n");

    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp",
      pathDirs: [dir],
      spawnFn: respondingSpawn("omp/1.0.0\n", "rpc-ui\n"),
    });

    expect(health.roots.configPath).toBe(join(agentDir, "config.yml"));
    expect(health.roots.configAvailable).toBe(true);
    expect(health.roots.sessionRoot).toBe(join(agentDir, "sessions"));
    expect(health.databases).toEqual({ agentDbPresent: true, historyDbPresent: true });
    expect(health.memoryBackend).toBe("mnemopi");
  });

  test("never forwards raw stdout or stderr, only the parsed version substring", async () => {
    const { dir } = await createFakeBinary();
    const agentDir = await tempDir("paseo-omp-agent-");
    const spawnFn: SpawnFn = (_command, args) => {
      const child = createFakeChild();
      queueMicrotask(() => {
        if (args[0] === "--version") {
          child.stdout.emit("data", Buffer.from("omp/18.1.15 SECRET_TOKEN=abc123\n"));
        } else {
          child.stdout.emit("data", Buffer.from("rpc-ui mode enabled AUTH_HEADER=xyz\n"));
        }
        child.stderr.emit("data", Buffer.from("STDERR_SECRET=shhh\n"));
        child.emit("close", 0);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };

    const health = await computeOmpProviderHealth({
      agentDir,
      command: "omp",
      pathDirs: [dir],
      spawnFn,
    });

    expect(health.binary.version).toBe("18.1.15");
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("AUTH_HEADER");
    expect(serialized).not.toContain("STDERR_SECRET");
    expect(serialized).not.toContain("abc123");
  });
});
