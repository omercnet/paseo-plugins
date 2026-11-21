import { type ChildProcessByStdio, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { z } from "zod";
import { RoutingScriptResultSchema, type runRoutingScript } from "../shared/viewer-scope";
import {
  allowListedEnv,
  COMMAND_TIMEOUT_MS,
  exists,
  expandUserPath,
  isAbsoluteOrHomePath,
  type ReadWorkspaceSettings,
} from "./workspace-ops";

export interface RoutingScriptLimits {
  timeoutMs: number;
  outputBytes: number;
  killGraceMs: number;
  /** Largest stdin payload the script is sent; `DEFAULT_ROUTING_INPUT_BYTES` when left out. */
  inputBytes?: number;
}

// The payload carries PR text (title, labels, linked issues) that another person wrote, so it has
// no natural bound. An oversize one is refused rather than cut: the script would otherwise route
// on a silently shortened record. The cap matches the output cap.
const DEFAULT_ROUTING_INPUT_BYTES = 1024 * 1024;

const DEFAULT_ROUTING_LIMITS: RoutingScriptLimits = {
  timeoutMs: COMMAND_TIMEOUT_MS,
  outputBytes: 1024 * 1024,
  killGraceMs: 2_000,
};

const STICKY_BIT = 0o1000;

// The script's PATH. The daemon's own PATH can list directories other users or tools write to
// (~/.local/bin, a project's node_modules/.bin), and the script's `#!/usr/bin/env interpreter` line
// would search it. These are the system and Homebrew directories; a script that needs a tool
// elsewhere should name it by absolute path. A directory is dropped at run time unless it passes the
// same trust check as the script's own directories (a Homebrew prefix owned by another user, or one
// group-writable, would let that user supply the interpreter).
const ROUTING_SCRIPT_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export async function trustedScriptPath(
  uid: number | undefined = process.getuid?.(),
  dirs: readonly string[] = ROUTING_SCRIPT_PATH_DIRS,
  // Directories whose own trust is already settled; the walk up from a PATH entry stops at them.
  verified: Set<string> = new Set(),
): Promise<string> {
  const trustedOwner = (owner: number) => uid === undefined || owner === uid || owner === 0;
  const kept: string[] = [];
  for (const dir of dirs) {
    try {
      // Strict: a sticky bit stops others deleting each other's files, not creating a `python3`.
      // The entry may be, or sit behind, a symbolic link: every link on the way, the directory
      // holding it and that directory's ancestors are checked, then the real directory it ends at
      // and every real parent of that (a link into a directory under a writable parent would
      // otherwise pass, since a walk of the entry's own parents never reaches it).
      await assertTrustedSymlinkChain(dir, trustedOwner, verified, false);
      await assertTrustedDirectories(dir, trustedOwner, verified, false);
      kept.push(dir);
    } catch {
      // Missing, owned by another user, or writable by others: not searched.
    }
  }
  return kept.join(":");
}

type OwnerCheck = (owner: number) => boolean;

/**
 * `start` and every directory above it must have a trusted owner and not be group/other-writable.
 * A sticky directory (like /tmp) is exempt from the write test unless `allowSticky` is false.
 * `start` is resolved first, so a symbolic link is judged by the real directory it ends at and by
 * that directory's real parents, never by the parents of the link's own spelling.
 */
async function assertTrustedDirectories(
  start: string,
  trustedOwner: OwnerCheck,
  verified: Set<string>,
  allowSticky = true,
): Promise<void> {
  // Remembered as trusted only once the whole walk has passed: a directory is trustworthy only if
  // everything above it is, so one that sat below a failure must not vouch for a later walk that
  // reaches it (say, through a link) and stops there.
  const passed: string[] = [];
  for (let dir = await realpath(start); !verified.has(dir); dir = dirname(dir)) {
    const dirInfo = await stat(dir);
    if (!trustedOwner(dirInfo.uid)) {
      throw new Error(
        `Routing script directory ${dir} is owned by another user; move the script somewhere you own, or run chown on it.`,
      );
    }
    if ((dirInfo.mode & 0o022) !== 0 && !(allowSticky && (dirInfo.mode & STICKY_BIT) !== 0)) {
      throw new Error(
        `Routing script directory ${dir} must not be writable by group or others; run chmod go-w on it.`,
      );
    }
    passed.push(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of passed) verified.add(dir);
}

// The kernel stops following links after this many (MAXSYMLINKS is 32 on macOS, 40 on Linux).
const MAX_SYMLINK_HOPS = 32;

/**
 * Walks the configured path component by component, as the kernel would, without following a link
 * blindly: every symbolic link met on the way (including links reached through another link, such
 * as /a/l1 -> /b/l2 -> /c/file) must belong to a trusted owner, and the directory that holds it
 * and all that directory's ancestors must not be writable by group or others. A link that anyone
 * else can create, replace or rename could otherwise point the script at any executable the user
 * can run, and that executable would pass every check on the resolved path.
 */
async function assertTrustedSymlinkChain(
  expanded: string,
  trustedOwner: OwnerCheck,
  verifiedDirs = new Set<string>(),
  allowSticky = true,
): Promise<void> {
  const split = (path: string) => path.split("/").filter((part) => part !== "" && part !== ".");
  let pending = split(expanded);
  let current = "/";
  let hops = 0;
  while (pending.length > 0) {
    const [name, ...rest] = pending;
    pending = rest;
    if (name === "..") {
      // The directory being left is part of the path too, even though realpath will not list it.
      await assertTrustedDirectories(current, trustedOwner, verifiedDirs, allowSticky);
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    const info = await lstat(next);
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) {
      throw new Error(`Routing script path ${expanded} has too many levels of symbolic links.`);
    }
    if (!trustedOwner(info.uid)) {
      throw new Error(
        `Routing script path goes through the symbolic link ${next}, which is owned by another user; point the setting at the real file, or run chown on the link.`,
      );
    }
    // `current` holds no links (each one is replaced by its target), so this is the real directory
    // that contains the link.
    await assertTrustedDirectories(current, trustedOwner, verifiedDirs, allowSticky);
    const target = await readlink(next);
    pending = [...split(target), ...pending];
    if (isAbsolute(target)) current = "/";
  }
}

/**
 * Resolves the configured script to a real path and refuses anything but a regular, executable
 * file that only this user (or root) can modify: the file must be owned by the user or root, and so
 * must every directory above it, none of them writable by group or others unless sticky (like
 * /tmp). Otherwise another local user could create the script or swap a path component for their
 * own, and it would run as this user. `uid` is a parameter so tests can stand in for another user.
 */
export async function resolveRoutingScript(
  rawPath: string,
  uid: number | undefined = process.getuid?.(),
): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("No routing script is configured in the PR Radar settings.");
  }
  if (!isAbsoluteOrHomePath(trimmed)) {
    throw new Error(`Routing script path must be an absolute or ~/ path: ${trimmed}`);
  }
  const expanded = expandUserPath(trimmed);
  if (!(await exists(expanded))) {
    throw new Error(`Routing script not found: ${expanded}`);
  }
  const trustedOwner = (owner: number) => uid === undefined || owner === uid || owner === 0;
  await assertTrustedSymlinkChain(expanded, trustedOwner);
  const scriptPath = await realpath(expanded);
  const info = await stat(scriptPath);
  if (!info.isFile()) {
    throw new Error(`Routing script is not a regular file: ${scriptPath}`);
  }
  if (!trustedOwner(info.uid)) {
    throw new Error(
      `Routing script ${scriptPath} is owned by another user; run chown on it, or use a script you own.`,
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(
      `Routing script ${scriptPath} must not be writable by group or others; run chmod go-w on it.`,
    );
  }
  await assertTrustedDirectories(dirname(scriptPath), trustedOwner, new Set());
  try {
    await access(scriptPath, constants.X_OK);
  } catch {
    throw new Error(`Routing script is not executable: ${scriptPath}`);
  }
  return scriptPath;
}

interface ScriptRun {
  /** Settles with the script's stdout, or rejects on failure, timeout or the output cap. */
  result: Promise<string>;
  /** Resolves once the script's process group has exited or has been sent SIGKILL. */
  finished: Promise<void>;
  /** Ends the script now (SIGTERM, then SIGKILL after a short grace) and fails `result`. */
  stop(): void;
}

function startScriptCapped(
  scriptPath: string,
  stdin: string,
  limits: RoutingScriptLimits,
  path: string,
): ScriptRun {
  const finishedGate = Promise.withResolvers<void>();
  let stop = () => {};
  const result = new Promise<string>((resolvePromise, rejectPromise) => {
    // Its own process group, so a timeout reaches the script's descendants too.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(scriptPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...allowListedEnv(new Set()), PATH: path },
        detached: true,
      });
    } catch (spawnError) {
      finishedGate.resolve();
      rejectPromise(spawnError);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let terminating = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Once the script has exited its process-group id is free to be reused, so nothing may signal
    // it after the one SIGKILL sent from the 'exit' handler.
    function signalGroup(signal: NodeJS.Signals): void {
      if (exited) return;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    }
    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A surviving descendant could otherwise keep feeding buffers nobody reads any more.
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }
    function terminate(graceMs = limits.killGraceMs): void {
      if (terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finishedGate.resolve();
      }, graceMs);
    }
    stop = () => {
      if (terminating) {
        // A timeout or the output cap already sent SIGTERM and armed the full grace, which can
        // outlast the host's own deadline: end the group now.
        clearTimeout(killTimer);
        signalGroup("SIGKILL");
        finishedGate.resolve();
      } else {
        terminate(Math.min(limits.killGraceMs, SHUTDOWN_KILL_GRACE_MS));
      }
      settle(() => rejectPromise(new Error(ROUTING_STOPPED_MESSAGE)));
    };
    function overCap(): void {
      terminate();
      settle(() =>
        rejectPromise(new Error(`Routing script output exceeded ${limits.outputBytes} bytes.`)),
      );
    }

    const timer = setTimeout(() => {
      terminate();
      settle(() =>
        rejectPromise(new Error(`Routing script timed out after ${limits.timeoutMs}ms.`)),
      );
    }, limits.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outBytes += chunk.length;
      if (outBytes > limits.outputBytes) return overCap();
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      errBytes += chunk.length;
      if (errBytes > limits.outputBytes) return overCap();
      err.push(chunk);
    });
    child.on("error", (spawnError) => {
      settle(() => rejectPromise(spawnError));
      finishedGate.resolve();
    });
    // 'exit' fires when the script itself has ended, while 'close' waits for every holder of the
    // pipes. A descendant that kept them open would otherwise delay 'close' until the timeout and a
    // script that exited 0 would be reported as timed out. Bytes the script already wrote stay in
    // the pipe, so 'close' still delivers the full output.
    // That one kill is the only group signal once the script has ended: a `setsid` descendant can
    // hold the pipes (and 'close') for up to the timeout, and by then the group id may belong to an
    // unrelated process.
    child.on("exit", () => {
      signalGroup("SIGKILL");
      exited = true;
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      finishedGate.resolve();
      settle(() => {
        if (code !== 0) {
          const message = Buffer.concat(err).toString("utf8").trim();
          rejectPromise(new Error(message || `Routing script exited with code ${code}.`));
          return;
        }
        resolvePromise(Buffer.concat(out).toString("utf8").trim());
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
  return { result, finished: finishedGate.promise, stop: () => stop() };
}

// The daemon waits 2 s for a plugin's cleanup before it signals the plugin process, so the script
// must be gone sooner than that.
const SHUTDOWN_KILL_GRACE_MS = 1_000;
const ROUTING_STOPPED_MESSAGE = "The routing script was stopped because PR Radar is shutting down.";

// One script runs at a time; up to this many further calls wait their turn, the rest are refused.
const MAX_QUEUED_ROUTING_CALLS = 2;
const ROUTING_BUSY_MESSAGE = "A routing script is already running; try again when it has finished.";

// Resolves when every admitted call has finished its turn: its script's process group is gone or
// has been sent SIGKILL, which can be after the call itself has failed on a timeout. A queued call
// waits on this gate (`run.finished`), not on the previous call's result, so a timed-out script
// that ignores SIGTERM never overlaps the next one.
let routingTail: Promise<void> = Promise.resolve();
let routingInFlight = 0;
let routingWaiting = 0;
// The script now running, and whether the plugin has been told to stop.
let activeRun: ScriptRun | undefined;
let routingStopped = false;

/**
 * Plugin cleanup. The script runs in its own process group (so a timeout reaches its descendants),
 * which also means the daemon stopping, reloading or disabling the plugin does not reach it: end
 * it here, and refuse any call still waiting. Resolves once its process group is gone or has been
 * sent SIGKILL. A daemon that is killed outright never runs this; the script then ends on its own.
 */
export async function stopRoutingScripts(): Promise<void> {
  routingStopped = true;
  const run = activeRun;
  if (!run) return;
  run.stop();
  await run.finished;
}

/** Called when the plugin starts: a plugin process is fresh, and tests start it more than once. */
export function startRoutingScripts(): void {
  routingStopped = false;
}

export async function waitForRoutingScriptIdleForTests(): Promise<void> {
  for (let tail = routingTail; ; tail = routingTail) {
    await tail;
    if (tail === routingTail) return;
  }
}

// Resolves with `work`, or rejects with `message` once `ms` have passed. The work itself cannot be
// cancelled, but the caller stops waiting for it, so a hung filesystem read cannot hold a turn.
async function withinBudget<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  // Work abandoned below may still reject later; nobody is left to hear it.
  work.catch(() => {});
  if (ms <= 0) throw new Error(message);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const ROUTING_PREFLIGHT_MESSAGE =
  "Reading the routing script settings or checking the script took longer than the time budget.";

export async function runRoutingScriptHandler(
  input: z.output<typeof runRoutingScript.input>,
  readSettings: ReadWorkspaceSettings,
  limits: RoutingScriptLimits = DEFAULT_ROUTING_LIMITS,
): Promise<z.output<typeof runRoutingScript.output>> {
  if (process.platform === "win32") {
    throw new Error("Routing scripts are not supported on Windows.");
  }
  if (routingStopped) throw new Error(ROUTING_STOPPED_MESSAGE);
  // Checked before a place in line is taken: an oversize payload costs nothing to refuse.
  const stdin = `${JSON.stringify(input.payload)}\n`;
  const inputCap = limits.inputBytes ?? DEFAULT_ROUTING_INPUT_BYTES;
  const inputBytes = Buffer.byteLength(stdin);
  if (inputBytes > inputCap) {
    throw new Error(
      `The routing script input is ${inputBytes} bytes, over the ${inputCap} byte limit; the script was not run.`,
    );
  }
  // Paseo gives a plugin request the same 30 s as one script run, so time spent queued comes out
  // of the run's own budget.
  const startedAt = performance.now();
  const budgetLeft = () => Math.floor(limits.timeoutMs - (performance.now() - startedAt));

  // Take a place in line before the first await, so calls keep their arrival order however long
  // each one's settings read and path check take, and the capacity check sees every earlier call.
  const queued = routingInFlight > 0;
  if (queued && routingWaiting >= MAX_QUEUED_ROUTING_CALLS) {
    throw new Error(ROUTING_BUSY_MESSAGE);
  }
  const previous = routingTail;
  const myTurn = Promise.withResolvers<void>();
  routingTail = myTurn.promise;
  routingInFlight += 1;
  void myTurn.promise.then(() => {
    routingInFlight -= 1;
  });
  let waiting = queued;
  if (waiting) routingWaiting += 1;
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = false;
    routingWaiting -= 1;
  };

  let run: ScriptRun;
  try {
    const preflight = async () => resolveRoutingScript((await readSettings()).routingScriptPath);
    let scriptPath = await withinBudget(preflight(), budgetLeft(), ROUTING_PREFLIGHT_MESSAGE);
    if (queued) {
      try {
        await withinBudget(previous, budgetLeft(), ROUTING_BUSY_MESSAGE);
      } finally {
        stopWaiting();
      }
      // The configuration may have changed while this call waited.
      scriptPath = await withinBudget(preflight(), budgetLeft(), ROUTING_PREFLIGHT_MESSAGE);
    }
    const path = await withinBudget(trustedScriptPath(), budgetLeft(), ROUTING_PREFLIGHT_MESSAGE);
    // A call that was waiting or reading settings when the plugin stopped must not start a script.
    if (routingStopped) throw new Error(ROUTING_STOPPED_MESSAGE);
    // Taken last, after every await, so the script's own timer starts when the budget says. A first
    // call has spent time on its settings read and path checks too, so it is trimmed like a queued one.
    const remaining = budgetLeft();
    if (remaining <= 0) throw new Error(queued ? ROUTING_BUSY_MESSAGE : ROUTING_PREFLIGHT_MESSAGE);
    run = startScriptCapped(scriptPath, stdin, { ...limits, timeoutMs: remaining }, path);
  } catch (error) {
    // This call never ran: pass the turn on once the one in front is done, so the order holds.
    stopWaiting();
    void previous.then(() => myTurn.resolve());
    throw error;
  }
  activeRun = run;
  void run.finished.then(() => {
    if (activeRun === run) activeRun = undefined;
    myTurn.resolve();
  });
  const stdout = await run.result;

  if (!stdout) return {};
  const parsed = JSON.parse(stdout) as unknown;
  return RoutingScriptResultSchema.parse(parsed);
}
