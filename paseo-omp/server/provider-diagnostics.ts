import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve as resolvePath, sep } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type {
  getOmpProviderHealth,
  OmpProviderHealth,
  OmpVersionStatus,
} from "../shared/provider-diagnostics";
import { readOmpConfigFrom } from "./omp-config";
import { ompAgentDir } from "./paths";

const VERSION_TIMEOUT_MS = 3_000;
const HELP_TIMEOUT_MS = 3_000;
const MAX_VERSION_BYTES = 2_048;
const MAX_HELP_BYTES = 65_536;

const AGENT_DB_FILENAME = "agent.db";
const HISTORY_DB_FILENAME = "history.db";
// Matches the `--session-dir` default omp documents in its own `--help` output and the layout
// providers.md describes for terminal-started session import (`~/.omp/agent/sessions`).
const SESSION_DIR_NAME = "sessions";

export type SpawnFn = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the omp executable purely from the filesystem: a literal path is checked directly,
 * otherwise every `pathDirs` entry is probed in order. No shell is ever invoked to do this
 * lookup (unlike `which omp`), and no subprocess is spawned unless a candidate is found.
 */
export async function resolveExecutablePath(
  command: string,
  pathDirs: readonly string[],
): Promise<string | null> {
  if (command.includes("/") || command.includes(sep)) {
    return (await isExecutableFile(command)) ? resolvePath(command) : null;
  }
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

type BoundedRun = { ok: true; stdout: string } | { ok: false; reason: "not-found" | "timeout" };

/** Runs one bounded, argv-only subprocess. stderr is drained and discarded, never inspected. */
function runBounded(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxBytes: number,
): Promise<BoundedRun> {
  const { promise, resolve } = Promise.withResolvers<BoundedRun>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(command, args);
  } catch {
    resolve({ ok: false, reason: "not-found" });
    return promise;
  }
  let settled = false;
  let stdout = "";
  const finish = (result: BoundedRun) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    resolve(result);
  };
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited between the timer firing and the kill call.
    }
    finish({ ok: false, reason: "timeout" });
  }, timeoutMs);
  child.on("error", () => finish({ ok: false, reason: "not-found" }));
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length >= maxBytes) return;
    stdout += chunk.toString("utf8").slice(0, maxBytes - stdout.length);
  });
  child.stderr?.on("data", () => {
    // Intentionally discarded: never stored, parsed, or forwarded across the RPC boundary.
  });
  child.on("close", () => finish({ ok: true, stdout }));
  return promise;
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/;

async function probeVersion(
  spawnFn: SpawnFn,
  resolvedPath: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: OmpVersionStatus; version: string | null }> {
  const result = await runBounded(spawnFn, resolvedPath, ["--version"], timeoutMs, maxBytes);
  if (!result.ok) return { status: result.reason, version: null };
  const version = result.stdout.match(VERSION_PATTERN)?.[1] ?? null;
  return version ? { status: "ok", version } : { status: "malformed", version: null };
}

/** Static feature detection only: never starts a real rpc-ui session (that has side effects). */
async function probeRpcUiSupport(
  spawnFn: SpawnFn,
  resolvedPath: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<boolean | null> {
  const result = await runBounded(spawnFn, resolvedPath, ["--help"], timeoutMs, maxBytes);
  if (!result.ok) return null;
  return /rpc-ui/i.test(result.stdout);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface ProviderDiagnosticsDeps {
  agentDir: string;
  command: string;
  pathDirs: readonly string[];
  spawnFn: SpawnFn;
  versionTimeoutMs?: number;
  helpTimeoutMs?: number;
  maxVersionBytes?: number;
  maxHelpBytes?: number;
}

export async function computeOmpProviderHealth(
  deps: ProviderDiagnosticsDeps,
): Promise<OmpProviderHealth> {
  const versionTimeoutMs = deps.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  const helpTimeoutMs = deps.helpTimeoutMs ?? HELP_TIMEOUT_MS;
  const maxVersionBytes = deps.maxVersionBytes ?? MAX_VERSION_BYTES;
  const maxHelpBytes = deps.maxHelpBytes ?? MAX_HELP_BYTES;

  const resolvedPath = await resolveExecutablePath(deps.command, deps.pathDirs);
  const installed = resolvedPath !== null;

  const [versionResult, rpcUiSupported, configResult] = await Promise.all([
    installed
      ? probeVersion(deps.spawnFn, resolvedPath, versionTimeoutMs, maxVersionBytes)
      : Promise.resolve({ status: "not-found" as const, version: null }),
    installed
      ? probeRpcUiSupport(deps.spawnFn, resolvedPath, helpTimeoutMs, maxHelpBytes)
      : Promise.resolve(null),
    readOmpConfigFrom(deps.agentDir),
  ]);

  const agentDbPath = join(deps.agentDir, AGENT_DB_FILENAME);
  const historyDbPath = join(deps.agentDir, HISTORY_DB_FILENAME);
  const sessionRoot = join(deps.agentDir, SESSION_DIR_NAME);
  const [agentDbPresent, historyDbPresent, sessionRootAvailable] = await Promise.all([
    pathExists(agentDbPath),
    pathExists(historyDbPath),
    pathExists(sessionRoot),
  ]);

  return {
    binary: {
      installed,
      resolvedPath,
      version: versionResult.version,
      versionStatus: versionResult.status,
    },
    rpcUi: {
      checked: installed,
      supported: rpcUiSupported,
    },
    roots: {
      agentRoot: deps.agentDir,
      configPath: configResult.path,
      configAvailable: configResult.available,
      sessionRoot,
      sessionRootAvailable,
    },
    databases: {
      agentDbPresent,
      historyDbPresent,
    },
    memoryBackend: configResult.config?.memory?.backend ?? null,
    checkedAt: new Date().toISOString(),
  };
}

export async function resolveGetOmpProviderHealth(
  _input: RpcInput<typeof getOmpProviderHealth>,
): Promise<OmpProviderHealth> {
  return computeOmpProviderHealth({
    agentDir: ompAgentDir(),
    command: process.env.OMP_COMMAND ?? "omp",
    pathDirs: (process.env.PATH ?? "").split(delimiter),
    spawnFn: defaultSpawn,
  });
}
