import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  computeOmpProviderHealth,
  killWindowsProcessTree,
  type ProbeChildProcess,
  type ProbeReadable,
  type ProviderDiagnosticsDeps,
  resolveExecutablePath,
  runBounded,
  type SpawnFn,
} from "../server/provider-diagnostics";
import { OmpProviderHealthSchema } from "../shared/provider-diagnostics";

const temporaryDirectories: string[] = [];
const HOME_DIR = tmpdir();

function homeRelative(path: string): string {
  const prefix = HOME_DIR.endsWith(sep) ? HOME_DIR : `${HOME_DIR}${sep}`;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function createFakeBinary(dir?: string, name = "omp"): Promise<string> {
  const targetDirectory = dir ?? (await tempDir("paseo-omp-bin-"));
  const path = join(targetDirectory, name);
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
  versionSignal?: NodeJS.Signals;
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
      child.emitClose(
        isVersion ? (options.exitCode ?? 0) : (options.helpExitCode ?? 0),
        isVersion ? (options.versionSignal ?? null) : null,
      );
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
    homeDir: HOME_DIR,
    ...overrides,
  };
}

async function writeDaemonEntry(hubRunRoot: string, project: string, name: string): Promise<void> {
  const dir = join(hubRunRoot, project, "daemons", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), "{}");
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

describe("killWindowsProcessTree", () => {
  const SYSTEM_ROOT = "C:\\Windows";
  const EXPECTED_TASKKILL_PATH = join(SYSTEM_ROOT, "System32", "taskkill.exe");

  test("resolves the absolute System32 taskkill.exe path rather than PATH search", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(0, null));
    const spawnFn: SpawnFn = (command, args) => {
      calls.push({ command, args });
      return child;
    };

    await killWindowsProcessTree(4321, spawnFn, SYSTEM_ROOT, 200);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(EXPECTED_TASKKILL_PATH);
    expect(calls[0]?.args).toEqual(["/pid", "4321", "/t", "/f"]);
  });

  test("resolves promptly on close instead of waiting the full grace period", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitClose(0, null));
    const started = Date.now();

    await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 5_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("never lets a taskkill error event escape unhandled, and still resolves", async () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emitError("ENOENT"));
    const started = Date.now();

    await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 5_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("resolves without throwing when the spawn itself fails synchronously", async () => {
    const spawnFn: SpawnFn = () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };

    await expect(killWindowsProcessTree(1, spawnFn, SYSTEM_ROOT, 200)).resolves.toBeUndefined();
  });

  test("resolves within the grace bound when taskkill never responds", async () => {
    const child = new FakeChild();
    const started = Date.now();

    await killWindowsProcessTree(1, () => child, SYSTEM_ROOT, 30);

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("computeOmpProviderHealth", () => {
  test("reports safe provider, storage, process, and compatibility facts", async () => {
    const binaryDir = await tempDir("paseo-omp-bin-");
    await createFakeBinary(binaryDir);
    const agentDir = await tempDir("paseo-omp-agent-");
    const hubRunRoot = join(agentDir, "hub-run");
    await mkdir(join(agentDir, "sessions"));
    await writeFile(join(agentDir, "agent.db"), "");
    await writeFile(join(agentDir, "history.db"), "");
    await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: mnemopi\n");
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }),
    );
    await writeDaemonEntry(hubRunRoot, "project-a", "one");
    await writeDaemonEntry(hubRunRoot, "project-a", "two");
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
        spawnFn: respondingSpawn({ captureEnv: capturedEnvs }),
      }),
    );

    expect(health.binary).toEqual({
      installed: true,
      resolvedPath: homeRelative(join(binaryDir, "omp")),
      version: { major: 18, minor: 1, patch: 15, prerelease: null },
      versionStatus: "ok",
      processCleanupFailed: false,
    });
    expect(health.rpcUi).toEqual({ checked: true, supported: true });
    expect(health.lsp).toEqual({ status: "supported" });
    expect(health.mcp).toEqual({
      status: "configured",
      serverCount: 2,
      serverNames: ["alpha", "beta"],
      reason: null,
    });
    expect(health.process).toEqual({ status: "ok", trackedCount: 2 });
    expect(health.roots).toEqual({
      agentRoot: homeRelative(agentDir),
      agentRootState: "available",
      configPath: homeRelative(join(agentDir, "config.yml")),
      configState: "available",
      sessionRoot: homeRelative(join(agentDir, "sessions")),
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

  describe("strict single-line canonical version acceptance", () => {
    test("rejects a canonical-looking line when the process exits nonzero", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\n", exitCode: 1 }),
        }),
      );

      expect(health.binary.versionStatus).toBe("probe-failed");
      expect(health.binary.version).toBeNull();
    });

    test("rejects a canonical-looking line when the process was signaled", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\n", versionSignal: "SIGKILL" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("probe-failed");
      expect(health.binary.version).toBeNull();
    });

    test("rejects a canonical line accompanied by extra output lines", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\nSECRET_TOKEN=abc123\n" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("malformed");
      expect(health.binary.version).toBeNull();
      expect(JSON.stringify(health)).not.toContain("SECRET_TOKEN");
    });

    test("rejects a canonical line when the probe output was truncated", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          maxVersionBytes: 4,
          spawnFn: respondingSpawn({ versionStdout: "omp/18.1.15\n" }),
        }),
      );

      expect(health.binary.versionStatus).toBe("malformed");
      expect(health.binary.version).toBeNull();
    });
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

  describe("config diagnostics", () => {
    test("classifies missing, invalid, wrong-type, and available filesystem states", async () => {
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

    test("treats a non-mapping YAML root as invalid rather than available", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "config.yml"), "- one\n- two\n");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.configState).toBe("invalid");
      expect(health.memoryBackend).toBeNull();
    });

    test("treats an invalid memory.backend value as invalid, not merely unset", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "config.yml"), "memory:\n  backend: not-a-real-backend\n");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.configState).toBe("invalid");
      expect(health.memoryBackend).toBeNull();
    });
  });

  describe("MCP manifest diagnostics", () => {
    test("reports a specific unavailable reason backed by the checked filename", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("unavailable");
      expect(health.mcp.reason).toContain("mcp.json");
      expect(health.mcp.serverCount).toBeNull();
      expect(health.mcp.serverNames).toBeNull();
    });

    test("reports invalid for malformed JSON without leaking file content", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "mcp.json"), "{ not json SECRET_SAUCE");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("invalid");
      expect(JSON.stringify(health)).not.toContain("SECRET_SAUCE");
    });

    test("reports invalid when mcpServers is not the expected shape", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: "nope" }));

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp.status).toBe("invalid");
    });

    test("never forwards nested server credentials, only names and a count", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            descope: { command: "npx", env: { API_KEY: "top-secret-value" } },
          },
        }),
      );

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.mcp).toEqual({
        status: "configured",
        serverCount: 1,
        serverNames: ["descope"],
        reason: null,
      });
      expect(JSON.stringify(health)).not.toContain("top-secret-value");
      expect(JSON.stringify(health)).not.toContain("npx");
    });
  });

  describe("directory access and process filtering", () => {
    test("treats a directory without traverse permission as invalid, not available", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      const sessionsDir = join(agentDir, "sessions");
      await mkdir(sessionsDir);
      await chmod(sessionsDir, 0o000);

      try {
        const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));
        expect(health.roots.sessionRootState).toBe("invalid");
      } finally {
        await chmod(sessionsDir, 0o755);
      }
    });

    test("counts only meta.json entries; reports partial for an inaccessible project", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");
      const hubRunRoot = join(agentDir, "hub-run");
      await writeDaemonEntry(hubRunRoot, "project-a", "real");
      await mkdir(join(hubRunRoot, "project-a", "daemons", "junk"), { recursive: true });
      const blockedDaemons = join(hubRunRoot, "project-b", "daemons");
      await mkdir(blockedDaemons, { recursive: true });
      await chmod(blockedDaemons, 0o000);

      try {
        const health = await computeOmpProviderHealth(
          baseDeps(agentDir, binaryDir, { hubRunRoot }),
        );
        expect(health.process).toEqual({ status: "partial", trackedCount: 1 });
      } finally {
        await chmod(blockedDaemons, 0o755);
      }
    });

    test("reports unavailable when the hub run root does not exist", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, { hubRunRoot: join(agentDir, "no-hub-run") }),
      );

      expect(health.process).toEqual({ status: "unavailable", trackedCount: null });
    });
  });

  describe("path sanitization", () => {
    test("renders a coarse custom-path label for roots outside the configured home", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      const binaryPath = await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, { homeDir: "/nonexistent-home-for-tests" }),
      );

      expect(health.roots.agentRoot).toBe(`<custom path>/${agentDir.split(sep).pop()}`);
      expect(health.binary.resolvedPath).toBe(`<custom path>/${binaryPath.split(sep).pop()}`);
      expect(health.roots.agentRoot).not.toContain(agentDir);
      expect(health.binary.resolvedPath).not.toContain(binaryDir);
    });

    test("renders home-relative paths for roots under the configured home", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(baseDeps(agentDir, binaryDir));

      expect(health.roots.agentRoot).toBe(homeRelative(agentDir));
      expect(health.roots.agentRoot.startsWith("~")).toBe(true);
      expect(health.roots.agentRoot).not.toBe(agentDir);
    });

    test("never forwards a raw env-overridden command path unsanitized", async () => {
      const binaryDir = await tempDir("paseo-omp-bin-");
      const binaryPath = await createFakeBinary(binaryDir);
      const agentDir = await tempDir("paseo-omp-agent-");

      const health = await computeOmpProviderHealth(
        baseDeps(agentDir, binaryDir, {
          command: binaryPath,
          pathDirs: [],
          homeDir: "/nonexistent-home-for-tests",
        }),
      );

      expect(health.binary.resolvedPath).not.toBe(binaryPath);
      expect(health.binary.resolvedPath).toBe(`<custom path>/${binaryPath.split(sep).pop()}`);
    });
  });
});
