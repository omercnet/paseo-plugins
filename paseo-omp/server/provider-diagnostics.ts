import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, sep } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type OmpConfig, OmpConfigSchema } from "../shared/omp-config";
import type {
  getOmpProviderHealth,
  OmpLspDiagnostics,
  OmpMcpDiagnostics,
  OmpProcessDiagnostics,
  OmpProviderHealth,
  OmpVersion,
  OmpVersionStatus,
  PathState,
} from "../shared/provider-diagnostics";
import { ompAgentDir } from "./paths";

const VERSION_TIMEOUT_MS = 3_000;
const HELP_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const MAX_VERSION_BYTES = 2_048;
const MAX_HELP_BYTES = 65_536;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_MCP_MANIFEST_BYTES = 64 * 1024;
const HEALTH_CACHE_TTL_MS = 30_000;

const AGENT_DB_FILENAME = "agent.db";
const HISTORY_DB_FILENAME = "history.db";
// Matches the `--session-dir` default omp documents in its own `--help` output and the layout
// providers.md describes for terminal-started session import (`~/.omp/agent/sessions`).
const SESSION_DIR_NAME = "sessions";
const MCP_MANIFEST_FILENAME = "mcp.json";
const CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";

// Only these variables ever reach a diagnostic probe's environment. Daemon credentials, API
// keys, and MCP headers — everything a real provider session legitimately inherits — are
// deliberately excluded; a `--version`/`--help` probe never needs them.
const PROBE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "PATHEXT",
  "LANG",
  "LC_ALL",
] as const;

function buildProbeEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The minimal child-process shape a probe needs: readable stdio, exit reporting, and kill. */
export interface ProbeReadable {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  removeAllListeners(): void;
}

export interface ProbeChildProcess {
  readonly pid: number | undefined;
  readonly stdout: ProbeReadable;
  readonly stderr: ProbeReadable;
  onError(listener: (error: NodeJS.ErrnoException) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  removeAllListeners(): void;
  /** Implementations own full process-tree termination (posix process group / Windows taskkill). */
  kill(signal: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ProbeChildProcess;

function killPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // The real child is spawned detached (its own process group leader); a negative pid
    // signals the whole group, catching grandchildren the direct child spawned. This
    // escalation runs independently of whether the group leader has already closed.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited between the kill attempt and this fallback.
    }
  }
}

/**
 * Terminates a Windows process tree via the resolved absolute `taskkill.exe` (never a bare
 * "taskkill" left to PATH search). `onError`/`onClose` are always attached before this returns,
 * so a missing/failing taskkill can never surface as an unhandled child "error" event; the
 * promise still resolves, bounded by `graceMs`, whichever of close/error/timeout comes first.
 */
export async function killWindowsProcessTree(
  pid: number,
  spawnFn: SpawnFn,
  systemRoot: string,
  graceMs: number,
): Promise<void> {
  const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve();
  };

  let child: ProbeChildProcess;
  try {
    child = spawnFn(taskkillPath, ["/pid", String(pid), "/t", "/f"], buildProbeEnv(process.env));
  } catch {
    return; // Nothing to attach handlers to; best effort ends here.
  }
  timer = setTimeout(finish, graceMs);
  child.onError(() => finish());
  child.onClose(() => finish());
  return promise;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ProbeChildProcess {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (listener) => {
      child.on("error", listener);
    },
    onClose: (listener) => {
      child.on("close", listener);
    },
    removeAllListeners: () => {
      child.removeAllListeners();
    },
    kill: (signal) => {
      if (child.pid === undefined) return true;
      if (process.platform === "win32") {
        void killWindowsProcessTree(
          child.pid,
          defaultSpawn,
          process.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT,
          KILL_GRACE_MS,
        );
      } else {
        killPosixProcessGroup(child.pid, signal);
      }
      return true;
    },
  };
}

async function isRegularExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await stat(candidate);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (platform === "win32") return true; // The X_OK bit is not meaningful on Windows.
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExecutableCandidates(base: string, pathExt: string): string[] {
  if (/\.[^./\\]+$/.test(base)) return [base];
  const extensions = pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return extensions.length > 0 ? extensions.map((ext) => base + ext) : [base];
}

export interface ResolveExecutableOptions {
  cwd: string;
  platform: NodeJS.Platform;
  pathExt: string;
}

/**
 * Resolves the omp executable purely from the filesystem: a literal path (containing a
 * separator) is checked directly; otherwise every `pathDirs` entry is probed in the given order,
 * exactly mirroring how a real launch would find the same binary. No shell is ever invoked to do
 * this lookup. An empty PATH entry conventionally means "current directory" in POSIX shells; that
 * legacy behavior is deliberately not honored here so an attacker-writable daemon cwd can never
 * shadow the real binary. A relative PATH entry resolves against the explicit `cwd`, never a
 * process-global implicit cwd. The final match is realpath'd so a resolved symlink is reported
 * consistently as its canonical target rather than the link path.
 */
export async function resolveExecutablePath(
  command: string,
  pathDirs: readonly string[],
  options: ResolveExecutableOptions,
): Promise<string | null> {
  const isWindows = options.platform === "win32";
  const isLiteralPath = command.includes("/") || (isWindows && command.includes(sep));
  const bases: string[] = [];
  if (isLiteralPath) {
    bases.push(isAbsolute(command) ? command : join(options.cwd, command));
  } else {
    for (const dir of pathDirs) {
      if (dir.length === 0) continue;
      bases.push(isAbsolute(dir) ? join(dir, command) : join(options.cwd, dir, command));
    }
  }
  for (const base of bases) {
    const candidates = isWindows ? windowsExecutableCandidates(base, options.pathExt) : [base];
    for (const candidate of candidates) {
      if (!(await isRegularExecutableFile(candidate, options.platform))) continue;
      try {
        return await realpath(candidate);
      } catch {
        // Candidate disappeared or its link chain changed between stat and canonicalization.
      }
    }
  }
  return null;
}

export type BoundedRunOutcome = "exited" | "spawn-error" | "timeout";

export interface BoundedRun {
  outcome: BoundedRunOutcome;
  stdout: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** ENOENT vs everything else, so "not found" and "found but unrunnable" stay distinct. */
  spawnErrorCode: string | null;
  /** True only when SIGKILL plus the grace-period wait never produced a close event. */
  cleanupFailed: boolean;
}

/**
 * Runs one bounded, argv-only subprocess with a minimal allowlisted environment. stderr is
 * drained and discarded, never inspected or forwarded. On timeout the full process tree is
 * signaled (TERM, then KILL after `killGraceMs`, independent of whether the immediate leader has
 * already closed) and the promise still waits, bounded by one more `killGraceMs`, for the close
 * event so exit status is real whenever the process cooperates, and cleanup failure is reported
 * when it does not.
 */
export function runBounded(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  killGraceMs: number,
  maxBytes: number,
): Promise<BoundedRun> {
  const { promise, resolve } = Promise.withResolvers<BoundedRun>();
  let child: ProbeChildProcess;
  try {
    child = spawnFn(command, args, env);
  } catch (error) {
    resolve({
      outcome: "spawn-error",
      stdout: "",
      truncated: false,
      exitCode: null,
      signal: null,
      spawnErrorCode: (error as NodeJS.ErrnoException)?.code ?? null,
      cleanupFailed: false,
    });
    return promise;
  }

  let settled = false;
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let truncated = false;
  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const getStdout = () => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");

  const cleanupListeners = () => {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    clearTimeout(deadlineTimer);
    clearTimeout(graceTimer);
  };
  const finish = (result: BoundedRun) => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    resolve(result);
  };

  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited between the deadline firing and this call.
    }
    graceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      graceTimer = setTimeout(() => {
        finish({
          outcome: "timeout",
          stdout: getStdout(),
          truncated,
          exitCode: null,
          signal: null,
          spawnErrorCode: null,
          cleanupFailed: true,
        });
      }, killGraceMs);
    }, killGraceMs);
  }, timeoutMs);

  child.onError((error) => {
    finish({
      outcome: "spawn-error",
      stdout: getStdout(),
      truncated,
      exitCode: null,
      signal: null,
      spawnErrorCode: error.code ?? null,
      cleanupFailed: false,
    });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const remaining = maxBytes - stdoutBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > remaining) truncated = true;
    const accepted = chunk.subarray(0, remaining);
    stdoutChunks.push(accepted);
    stdoutBytes += accepted.length;
  });
  child.stderr.on("data", () => {
    // Intentionally discarded: never stored, parsed, or forwarded across the RPC boundary.
  });
  child.onClose((code, signal) => {
    finish({
      outcome: timedOut ? "timeout" : "exited",
      stdout: getStdout(),
      truncated,
      exitCode: code,
      signal,
      spawnErrorCode: null,
      cleanupFailed: false,
    });
  });

  return promise;
}

// Anchored against the entire trimmed stdout (not merely one of several lines) so extra output,
// build metadata after a `+`, or a prefix/suffix can never be mistaken for the version. Digit
// groups are bounded to 4 characters and prerelease text to 32, so nothing unbounded parses out.
const VERSION_LINE_PATTERN =
  /^omp\/(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z][0-9A-Za-z.]{0,31}))?$/;

/** Requires the whole trimmed probe output to be exactly one canonical version line. */
function parseCanonicalVersionLine(stdout: string): OmpVersion | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return null;
  const match = VERSION_LINE_PATTERN.exec(lines[0].trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

function toVersionOutcome(result: BoundedRun): {
  status: OmpVersionStatus;
  version: OmpVersion | null;
} {
  if (result.outcome === "timeout") return { status: "timeout", version: null };
  if (result.outcome === "spawn-error") {
    return {
      status: result.spawnErrorCode === "ENOENT" ? "not-found" : "unrunnable",
      version: null,
    };
  }
  // Only a clean, unsignaled, non-truncated exit can ever license "ok"; a nonzero exit or a
  // delivered signal is a probe failure regardless of how plausible the stdout looks.
  const exitedCleanly = result.exitCode === 0 && result.signal === null;
  if (!exitedCleanly) return { status: "probe-failed", version: null };
  if (result.truncated) return { status: "malformed", version: null };
  const version = parseCanonicalVersionLine(result.stdout);
  return version ? { status: "ok", version } : { status: "malformed", version: null };
}

// Matches the exact flag line omp documents for `--mode`, not a bare "rpc-ui" substring that
// could appear anywhere in unrelated text.
const RPC_UI_HELP_PATTERN = /--mode=<value>\s+Output mode:.*\brpc-ui\b/i;
// Matches the exact "Available Tools" listing line for the built-in lsp tool.
const LSP_TOOL_PATTERN = /^\s*lsp\s+-\s+Language server protocol/im;

/** A clean, non-empty, non-truncated, zero-exit help dump is required before trusting either a
 * positive or a negative match. */
function helpResultUsable(result: BoundedRun): boolean {
  return (
    result.outcome === "exited" &&
    result.exitCode === 0 &&
    result.signal === null &&
    !result.truncated &&
    result.stdout.trim().length > 0
  );
}

function detectRpcUiSupport(result: BoundedRun): boolean | null {
  return helpResultUsable(result) ? RPC_UI_HELP_PATTERN.test(result.stdout) : null;
}

function computeLspDiagnostics(result: BoundedRun): OmpLspDiagnostics {
  if (!helpResultUsable(result)) return { status: "unknown" };
  return { status: LSP_TOOL_PATTERN.test(result.stdout) ? "supported" : "not-advertised" };
}

function isEnoent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Classifies a known diagnostic path without following symlinks. A symlink is "wrong-type"
 * rather than an invitation to read an arbitrary target outside omp's expected state tree.
 * Directories additionally require both read and traverse (X_OK) access before "available";
 * a directory that exists but cannot be listed is not usable state, so it is "invalid".
 */
async function classifyPath(path: string, kind: "file" | "directory"): Promise<PathState> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    return isEnoent(error) ? "missing" : "invalid";
  }
  if (pathStats.isSymbolicLink()) return "wrong-type";
  const matchesKind = kind === "file" ? pathStats.isFile() : pathStats.isDirectory();
  if (!matchesKind) return "wrong-type";
  const mode = kind === "file" ? constants.R_OK : constants.R_OK | constants.X_OK;
  try {
    await access(path, mode);
  } catch {
    return "invalid";
  }
  return "available";
}

type BoundedFileRead =
  | { state: "available"; text: string }
  | { state: "missing" | "wrong-type" | "invalid" };

/** Bounded, no-symlink file read shared by the config and MCP-manifest readers. */
async function readBoundedNoSymlinkFile(path: string, maxBytes: number): Promise<BoundedFileRead> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    return { state: isEnoent(error) ? "missing" : "invalid" };
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) return { state: "wrong-type" };

  let handle: FileHandle | undefined;
  try {
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollowFlag);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return { state: "wrong-type" };
    if (openedStats.size > maxBytes) return { state: "invalid" };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { state: "invalid" };
    return { state: "available", text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { state: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface SafeConfigResult {
  path: string;
  state: PathState;
  config: OmpConfig | null;
}

/**
 * Reads omp's config.yml/.yaml with the same safe-allowlist schema the config surface uses, but
 * classifies anything that parses to a non-mapping root or fails the allowed-section schema
 * (including an invalid `memory.backend`) as "invalid" rather than silently degrading to an
 * empty-but-"available" config — a health check must not call a broken config healthy.
 */
async function readSafeConfig(agentDir: string): Promise<SafeConfigResult> {
  const canonicalPath = join(agentDir, CONFIG_FILENAMES[0]);
  for (const filename of CONFIG_FILENAMES) {
    const path = join(agentDir, filename);
    const fileRead = await readBoundedNoSymlinkFile(path, MAX_CONFIG_BYTES);
    if (fileRead.state === "missing") continue;
    if (fileRead.state !== "available") return { path, state: fileRead.state, config: null };
    try {
      const raw: unknown = parseYaml(fileRead.text);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { path, state: "invalid", config: null };
      }
      const parsed = OmpConfigSchema.safeParse(raw);
      if (!parsed.success) return { path, state: "invalid", config: null };
      return { path, state: "available", config: parsed.data };
    } catch {
      return { path, state: "invalid", config: null };
    }
  }
  return { path: canonicalPath, state: "missing", config: null };
}

const McpManifestSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

/**
 * Reports configured MCP server count/names from omp's own `mcp.json` manifest (server names
 * are identifiers, never the credentials/headers/URLs nested inside each entry, which are never
 * read past the top-level key). When no manifest exists this reports a specific reason backed by
 * the checked filename rather than a placeholder; there is no fabricated "unknown" default.
 */
async function computeMcpDiagnostics(agentDir: string): Promise<OmpMcpDiagnostics> {
  const fileRead = await readBoundedNoSymlinkFile(
    join(agentDir, MCP_MANIFEST_FILENAME),
    MAX_MCP_MANIFEST_BYTES,
  );
  if (fileRead.state === "missing") {
    return {
      status: "unavailable",
      serverCount: null,
      serverNames: null,
      reason: `No ${MCP_MANIFEST_FILENAME} manifest found under the agent root`,
    };
  }
  if (fileRead.state === "wrong-type") {
    return {
      status: "invalid",
      serverCount: null,
      serverNames: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root is not a regular file`,
    };
  }
  if (fileRead.state === "invalid") {
    return {
      status: "invalid",
      serverCount: null,
      serverNames: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root could not be read`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fileRead.text);
  } catch {
    return {
      status: "invalid",
      serverCount: null,
      serverNames: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root is not valid JSON`,
    };
  }
  const parsed = McpManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "invalid",
      serverCount: null,
      serverNames: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root does not match the expected shape`,
    };
  }
  const serverNames = Object.keys(parsed.data.mcpServers ?? {});
  return { status: "configured", serverCount: serverNames.length, serverNames, reason: null };
}

/**
 * Counts daemon-supervised process entries recognized by an existing `meta.json` under each
 * project's `daemons/` directory (never their names, cwd, or args). A project scope missing its
 * `daemons/` subdirectory entirely is normal and skipped; any other read failure (e.g. a
 * permission error) is surfaced as "partial" rather than silently undercounting.
 */
async function computeProcessDiagnostics(hubRunRoot: string): Promise<OmpProcessDiagnostics> {
  let projectHashes: string[];
  try {
    projectHashes = await readdir(hubRunRoot);
  } catch (error) {
    return { status: isEnoent(error) ? "unavailable" : "unknown", trackedCount: null };
  }
  let trackedCount = 0;
  let hadInaccessibleEntries = false;
  for (const hash of projectHashes) {
    const daemonsDir = join(hubRunRoot, hash, "daemons");
    let daemonNames: string[];
    try {
      daemonNames = await readdir(daemonsDir);
    } catch (error) {
      if (!isEnoent(error)) hadInaccessibleEntries = true;
      continue;
    }
    for (const name of daemonNames) {
      try {
        const metaStats = await stat(join(daemonsDir, name, "meta.json"));
        if (metaStats.isFile()) trackedCount += 1;
      } catch {
        // Not a recognizable daemon entry (missing/broken meta.json); do not count it.
      }
    }
  }
  return { status: hadInaccessibleEntries ? "partial" : "ok", trackedCount };
}

function homeRelative(path: string, homeDir: string): string | null {
  if (path === homeDir) return "~";
  const prefix = homeDir.endsWith(sep) ? homeDir : `${homeDir}${sep}`;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : null;
}

/** Home-relative when possible; otherwise a coarse label carrying only the basename, so an
 * override root pointed at an arbitrary machine-specific location never leaks its full path. */
function sanitizeRootPath(path: string, homeDir: string): string {
  return homeRelative(path, homeDir) ?? `<custom path>/${basename(path)}`;
}

function sanitizeDerivedPath(rawRoot: string, sanitizedRoot: string, fullPath: string): string {
  return `${sanitizedRoot}${fullPath.slice(rawRoot.length)}`;
}

export interface ProviderDiagnosticsDeps {
  agentDir: string;
  command: string;
  pathDirs: readonly string[];
  cwd: string;
  platform: NodeJS.Platform;
  pathExt: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  hubRunRoot: string;
  homeDir: string;
  versionTimeoutMs?: number;
  helpTimeoutMs?: number;
  killGraceMs?: number;
  maxVersionBytes?: number;
  maxHelpBytes?: number;
}

export async function computeOmpProviderHealth(
  deps: ProviderDiagnosticsDeps,
): Promise<OmpProviderHealth> {
  const versionTimeoutMs = deps.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  const helpTimeoutMs = deps.helpTimeoutMs ?? HELP_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxVersionBytes = deps.maxVersionBytes ?? MAX_VERSION_BYTES;
  const maxHelpBytes = deps.maxHelpBytes ?? MAX_HELP_BYTES;
  const probeEnv = buildProbeEnv(deps.env);

  const resolvedPath = await resolveExecutablePath(deps.command, deps.pathDirs, {
    cwd: deps.cwd,
    platform: deps.platform,
    pathExt: deps.pathExt,
  });
  const installed = resolvedPath !== null;

  const [versionRun, helpRun] = await Promise.all([
    installed
      ? runBounded(
          deps.spawnFn,
          resolvedPath,
          ["--version"],
          probeEnv,
          versionTimeoutMs,
          killGraceMs,
          maxVersionBytes,
        )
      : null,
    installed
      ? runBounded(
          deps.spawnFn,
          resolvedPath,
          ["--help"],
          probeEnv,
          helpTimeoutMs,
          killGraceMs,
          maxHelpBytes,
        )
      : null,
  ]);

  const versionOutcome = versionRun
    ? toVersionOutcome(versionRun)
    : { status: "not-found" as const, version: null };
  const rpcUiSupported = helpRun ? detectRpcUiSupport(helpRun) : null;
  const lsp = helpRun ? computeLspDiagnostics(helpRun) : { status: "unknown" as const };
  const processCleanupFailed = Boolean(versionRun?.cleanupFailed || helpRun?.cleanupFailed);

  const agentDbPath = join(deps.agentDir, AGENT_DB_FILENAME);
  const historyDbPath = join(deps.agentDir, HISTORY_DB_FILENAME);
  const sessionRoot = join(deps.agentDir, SESSION_DIR_NAME);

  const [
    configResult,
    agentRootState,
    sessionRootState,
    agentDbState,
    historyDbState,
    mcp,
    processDiagnostics,
  ] =
    await Promise.all([
      readSafeConfig(deps.agentDir),
      classifyPath(deps.agentDir, "directory"),
      classifyPath(sessionRoot, "directory"),
      classifyPath(agentDbPath, "file"),
      classifyPath(historyDbPath, "file"),
      computeMcpDiagnostics(deps.agentDir),
      computeProcessDiagnostics(deps.hubRunRoot),
    ]);
  const configState = configResult.state;

  const sanitizedAgentRoot = sanitizeRootPath(deps.agentDir, deps.homeDir);

  return {
    binary: {
      installed,
      resolvedPath: resolvedPath ? sanitizeRootPath(resolvedPath, deps.homeDir) : null,
      version: versionOutcome.version,
      versionStatus: versionOutcome.status,
      processCleanupFailed,
    },
    rpcUi: {
      checked: installed,
      supported: rpcUiSupported,
    },
    lsp,
    mcp,
    process: processDiagnostics,
    roots: {
      agentRoot: sanitizedAgentRoot,
      agentRootState,
      configPath: sanitizeDerivedPath(deps.agentDir, sanitizedAgentRoot, configResult.path),
      configState,
      sessionRoot: sanitizeDerivedPath(deps.agentDir, sanitizedAgentRoot, sessionRoot),
      sessionRootState,
    },
    databases: {
      agentDbState,
      historyDbState,
    },
    memoryBackend:
      configState === "available" ? (configResult.config?.memory?.backend ?? null) : null,
    checkedAt: new Date().toISOString(),
  };
}

let cachedHealth: { value: OmpProviderHealth; expiresAt: number } | null = null;
let inFlightHealth: Promise<OmpProviderHealth> | null = null;

function defaultHubRunRoot(): string {
  return process.env.PASEO_OMP_RUN_DIR ?? join(homedir(), ".omp", "run", "daemons");
}

/**
 * Single-flights and short-TTL-caches the health computation so several connected clients
 * polling or refreshing around the same time never each launch their own `--version`/`--help`
 * subprocess pair; they share one in-flight probe or its just-completed result. `force` skips a
 * still-fresh cached value but still joins an in-flight probe rather than starting a duplicate.
 */
export async function resolveGetOmpProviderHealth(
  input: RpcInput<typeof getOmpProviderHealth>,
): Promise<OmpProviderHealth> {
  const now = Date.now();
  if (!input.force && cachedHealth && cachedHealth.expiresAt > now) return cachedHealth.value;
  if (inFlightHealth) return inFlightHealth;

  const computation = computeOmpProviderHealth({
    agentDir: ompAgentDir(),
    command: process.env.OMP_COMMAND ?? "omp",
    pathDirs: (process.env.PATH ?? "").split(delimiter),
    cwd: process.cwd(),
    platform: process.platform,
    pathExt: process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    env: process.env,
    spawnFn: defaultSpawn,
    hubRunRoot: defaultHubRunRoot(),
    homeDir: homedir(),
  })
    .then((value) => {
      cachedHealth = { value, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlightHealth = null;
    });
  inFlightHealth = computation;
  return computation;
}
