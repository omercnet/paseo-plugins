import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  computeOmpProviderHealth,
  type ProbeChildProcess,
  type ProbeReadable,
  type ProviderDiagnosticsDeps,
  resolveExecutablePath,
  runBounded,
  type SpawnFn,
} from "../server/provider-diagnostics";
import { OmpProviderHealthSchema } from "../shared/provider-diagnostics";

const temporaryDirectories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function createFakeBinary(
  dir = await tempDir("paseo-omp-bin-"),
  name = "omp",
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

class FakeReadable implements ProbeReadable {
  private listeners: Array<(chunk: Buffer) => void> = [];

  on(_event: "data", listener: (chunk: Buffer) => void): void {
    this.listeners.push(listener);
  }

  removeAllListeners(): void {
    this.listeners = [];
  }

  emit(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const listener of this.listeners) listener(buffer);
  }
}

class FakeChild implements ProbeChildProcess {
  readonly pid = 12345;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killSignals: NodeJS.Signals[] = [];
  closeEvents = 0;
  onKill?: (signal: NodeJS.Signals) => void;
  private errorListeners: Array<(error: NodeJS.ErrnoException) => void> = [];
  private closeListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  onError(listener: (error: NodeJS.ErrnoException) => void): void {
    this.errorListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  removeAllListeners(): void {
    this.errorListeners = [];
    this.closeListeners = [];
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  emitError(code: string): void {
    const error = Object.assign(new Error(code), { code });
    for (const listener of this.errorListeners) listener(error);
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.closeEvents += 1;
    for (const listener of this.closeListeners) listener(code, signal);
  }
}

interface RespondingSpawnOptions {
  versionStdout?: string;
  helpStdout?: string;
  stderr?: string;
  exitCode?: number;
  helpExitCode?: number;
  captureEnv?: NodeJS.ProcessEnv[];
}

function respondingSpawn(options: RespondingSpawnOptions = {}): SpawnFn {
  return (_command, args, env) => {
    options.captureEnv?.push({ ...env });
    const child = new FakeChild();
    queueMicrotask(() => {
      const isVersion = args[0] === "--version";
      child.stdout.emit(
        isVersion
          ? (options.versionStdout ?? "omp/18.1.15\n")
          : (options.helpStdout ??
              "--mode=<value>  Output mode: text (default), json, rpc, or rpc-ui\n" +
                "lsp  - Language server protocol (code intelligence)\n"),
      );
      if (options.stderr) child.stderr.emit(options.stderr);
      child.emitClose(isVersion ? (options.exitCode ?? 0) : (options.helpExitCode ?? 0), null);
    });
    return child;
  };
}

function baseDeps(
  agentDir: string,
  binaryDir: string,
  overrides: Partial<ProviderDiagnosticsDeps> = {},
): ProviderDiagnosticsDeps {
  return {
    agentDir,
    command: "omp",
    pathDirs: [binaryDir],
    cwd: agentDir,
    platform: "linux",
    pathExt: ".EXE;.CMD",
    env: { PATH: binaryDir, HOME: agentDir },
    spawnFn: respondingSpawn(),
    hubRunRoot: join(agentDir, "hub-run"),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveExecutablePath", () => {
  test("finds the first executable and returns its realpath", async () => {
    const dir = await tempDir("paseo-omp-bin-");
    const target = await createFakeBinary(dir, "omp-real");
    const link = join(dir, "omp");
    await symlink(target, link);

    expect(
      await resolveExecutablePath("omp", [dir], {
        cwd: dir,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(target);
  });

  test("skips empty PATH entries and resolves relative entries against explicit cwd", async () => {
    const cwd = await tempDir("paseo-omp-cwd-");
    const binDir = join(cwd, "bin");
    await mkdir(binDir);
    const target = await createFakeBinary(binDir);

    expect(
      await resolveExecutablePath("omp", ["", "bin"], {
        cwd,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(target);
  });

  test("uses PATHEXT when resolving a Windows command", async () => {
    const dir = await tempDir("paseo-omp-win-bin-");
    const target = await createFakeBinary(dir, "omp.EXE");

    expect(
      await resolveExecutablePath("omp", [dir], {
        cwd: dir,
        platform: "win32",
        pathExt: ".EXE;.CMD",
      }),
    ).toBe(target);
  });

  test("checks a literal relative path against explicit cwd", async () => {
    const cwd = await tempDir("paseo-omp-cwd-");
    const binDir = join(cwd, "bin");
    await mkdir(binDir);
    const target = await createFakeBinary(binDir);

    expect(
      await resolveExecutablePath(relative(cwd, target), ["/ignored"], {
        cwd,
        platform: "linux",
        pathExt: ".EXE",
      }),
    ).toBe(target);
  });
});

describe("runBounded", () => {
  test("preserves exit code and signal from close", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(7, "SIGTERM"));

    const result = await runBounded(() => child, "omp", ["--version"], {}, 100, 20, 64);

    expect(result).toMatchObject({
      outcome: "exited",
      exitCode: 7,
      signal: "SIGTERM",
      truncated: false,
      cleanupFailed: false,
    });
  });

  test("kills the process tree on timeout and waits for close", async () => {
    const child = new FakeChild();
    child.onKill = (signal) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.emitClose(null, "SIGTERM"));
    };

    const result = await runBounded(() => child, "omp", ["--help"], {}, 10, 10, 64);

    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(child.closeEvents).toBe(1);
    expect(result).toMatchObject({
      outcome: "timeout",
      signal: "SIGTERM",
      cleanupFailed: false,
    });
  });

  test("reports cleanup failure after the full bounded kill sequence", async () => {
    const child = new FakeChild();

    const result = await runBounded(() => child, "omp", ["--help"], {}, 5, 5, 64);

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.closeEvents).toBe(0);
    expect(result).toMatchObject({ outcome: "timeout", cleanupFailed: true });
  });

  test("caps output in bytes and marks an oversized single chunk truncated", async () => {
    const child = new FakeChild();
    queueMicrotask(() => {
      child.stdout.emit(Buffer.from("0123456789SECRET"));
      child.emitClose(0, null);
    });

    const result = await runBounded(() => child, "omp", ["--help"], {}, 100, 20, 10);

    expect(result.stdout).toBe("0123456789");
    expect(Buffer.byteLength(result.stdout)).toBe(10);
    expect(result.truncated).toBe(true);
  });
});

describe("computeOmpProviderHealth", () => {
  test("reports safe provider, storage, process, and compatibility facts", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    const binaryPath = await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");
    const hubRunRoot = join(agentDir, "hub-run");
    await mkdir(join(agentDir, "sessions"));
    await writeFile(join(agentDir, "agent.db"), "");
    await writeFile(join(agentDir, "history.db"), "");
    await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: mnemopi\n");
    await mkdir(join(hubRunRoot, "project-a", "daemons", "one"), { recursive: true });
    await mkdir(join(hubRunRoot, "project-a", "daemons", "two"), { recursive: true });
    const capturedEnvs: NodeJS.ProcessEnv[] = [];

    const health = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        hubRunRoot,
        env: {
          PATH: binaryDir,
          HOME: agentDir,
          LANG: "C.UTF-8",
          API_KEY: "must-not-reach-child",
          MCP_HEADERS: "must-not-reach-child",
        },
        spawnFn: respondingSpawn({
          versionStdout: "omp/18.1.15-beta.1\nSECRET_TOKEN=abc123\n",
          stderr: "STDERR_SECRET=shhh\n",
          captureEnv: capturedEnvs,
        }),
      }),
    );

    expect(health.binary).toEqual({
      installed: true,
      resolvedPath: binaryPath,
      version: { major: 18, minor: 1, patch: 15, prerelease: "beta.1" },
      versionStatus: "ok",
      processCleanupFailed: false,
    });
    expect(health.rpcUi).toEqual({ checked: true, supported: true });
    expect(health.lsp).toEqual({ status: "supported" });
    expect(health.mcp.status).toBe("unknown");
    expect(health.process).toEqual({ status: "ok", trackedCount: 2 });
    expect(health.roots).toMatchObject({
      agentRootState: "available",
      configState: "available",
      sessionRootState: "available",
    });
    expect(health.databases).toEqual({
      agentDbState: "available",
      historyDbState: "available",
    });
    expect(health.memoryBackend).toBe("mnemopi");
    expect(capturedEnvs).toHaveLength(2);
    for (const env of capturedEnvs) {
      expect(env.API_KEY).toBeUndefined();
      expect(env.MCP_HEADERS).toBeUndefined();
      expect(env.PATH).toBe(binaryDir);
      expect(env.HOME).toBe(agentDir);
    }
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("STDERR_SECRET");
    expect(serialized).not.toContain("abc123");
    expect(OmpProviderHealthSchema.safeParse(health).success).toBe(true);
  });

  test("reports not-found and never spawns when the binary cannot be resolved", async () => {
    const agentDir = await tempDir("paseo-omp-agent-");
    let spawnCalls = 0;
    const spawnFn: SpawnFn = () => {
      spawnCalls += 1;
      throw new Error("spawn should not run for an unresolved binary");
    };

    const health = await computeOmpProviderHealth(
      baseDeps(agentDir, "/does/not/exist", { spawnFn }),
    );

    expect(health.binary).toMatchObject({
      installed: false,
      resolvedPath: null,
      version: null,
      versionStatus: "not-found",
    });
    expect(health.rpcUi).toEqual({ checked: false, supported: null });
    expect(spawnCalls).toBe(0);
  });

  test("distinguishes a resolved but unrunnable executable from not-found", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");
    const spawnFn: SpawnFn = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };

    const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir, { spawnFn }));

    expect(health.binary.versionStatus).toBe("unrunnable");
  });

  test("distinguishes nonzero probe exit from malformed successful output", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");

    const failed = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ versionStdout: "no version\n", exitCode: 2 }),
      }),
    );
    const malformed = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ versionStdout: "no version\n", exitCode: 0 }),
      }),
    );

    expect(failed.binary.versionStatus).toBe("probe-failed");
    expect(malformed.binary.versionStatus).toBe("malformed");
  });

  test("rejects prefixed and build-metadata version text instead of forwarding it", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");

    for (const versionStdout of ["prefix omp/1.2.3\n", "omp/1.2.3+secret\n"]) {
      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, { spawnFn: respondingSpawn({ versionStdout }) }),
      );
      expect(health.binary.versionStatus).toBe("malformed");
      expect(health.binary.version).toBeNull();
    }
  });

  test("treats failed, empty, and truncated help as unknown instead of unsupported", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");

    const empty = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ helpStdout: "" }),
      }),
    );
    const failed = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        spawnFn: respondingSpawn({ helpStdout: "--mode=<value> rpc-ui\n", helpExitCode: 2 }),
      }),
    );
    const truncated = await computeOmpProviderHealth(
      baseDeps(agentDir, binaryDir, {
        maxHelpBytes: 8,
        spawnFn: respondingSpawn({ helpStdout: "--mode=<value> rpc-ui\n" }),
      }),
    );

    expect(empty.rpcUi.supported).toBeNull();
    expect(failed.rpcUi.supported).toBeNull();
    expect(truncated.rpcUi.supported).toBeNull();
    expect(truncated.lsp.status).toBe("unknown");
  });

  test("classifies config and filesystem states without collapsing them to missing", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);

    const missingDir = await tempDir("paseo-omp-missing-");
    const missing = await computeOmpProviderHealth(baseDeps(missingDir, binaryDir));
    expect(missing.roots.configState).toBe("missing");

    const malformedDir = await tempDir("paseo-omp-malformed-");
    await writeFile(join(malformedDir, "config.yml"), "memory: [\n");
    const malformed = await computeOmpProviderHealth(baseDeps(malformedDir, binaryDir));
    expect(malformed.roots.configState).toBe("invalid");

    const unreadableDir = await tempDir("paseo-omp-unreadable-");
    const unreadablePath = join(unreadableDir, "config.yml");
    await writeFile(unreadablePath, "memory:\n  backend: local\n");
    await chmod(unreadablePath, 0o000);
    const unreadable = await computeOmpProviderHealth(baseDeps(unreadableDir, binaryDir));
    expect(unreadable.roots.configState).toBe("invalid");

    const wrongTypeDir = await tempDir("paseo-omp-wrong-type-");
    await mkdir(join(wrongTypeDir, "config.yml"));
    const wrongType = await computeOmpProviderHealth(baseDeps(wrongTypeDir, binaryDir));
    expect(wrongType.roots.configState).toBe("wrong-type");

    const availableDir = await tempDir("paseo-omp-available-");
    await writeFile(join(availableDir, "config.yml"), "memory:\n  backend: local\n");
    const available = await computeOmpProviderHealth(baseDeps(availableDir, binaryDir));
    expect(available.roots.configState).toBe("available");
    expect(available.memoryBackend).toBe("local");
  });
});
