import { type ChildProcessByStdio, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
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
}

const DEFAULT_ROUTING_LIMITS: RoutingScriptLimits = {
  timeoutMs: COMMAND_TIMEOUT_MS,
  outputBytes: 1024 * 1024,
  killGraceMs: 2_000,
};

const STICKY_BIT = 0o1000;

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
  const scriptPath = await realpath(expanded);
  const info = await stat(scriptPath);
  if (!info.isFile()) {
    throw new Error(`Routing script is not a regular file: ${scriptPath}`);
  }
  const trustedOwner = (owner: number) => uid === undefined || owner === uid || owner === 0;
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
  for (let dir = dirname(scriptPath); ; dir = dirname(dir)) {
    const dirInfo = await stat(dir);
    if (!trustedOwner(dirInfo.uid)) {
      throw new Error(
        `Routing script directory ${dir} is owned by another user; move the script somewhere you own, or run chown on it.`,
      );
    }
    if ((dirInfo.mode & 0o022) !== 0 && (dirInfo.mode & STICKY_BIT) === 0) {
      throw new Error(
        `Routing script directory ${dir} must not be writable by group or others; run chmod go-w on it.`,
      );
    }
    if (dirname(dir) === dir) break;
  }
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
}

function startScriptCapped(
  scriptPath: string,
  payload: unknown,
  limits: RoutingScriptLimits,
): ScriptRun {
  const finishedGate = Promise.withResolvers<void>();
  const result = new Promise<string>((resolvePromise, rejectPromise) => {
    // Its own process group, so a timeout reaches the script's descendants too.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(scriptPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: allowListedEnv(new Set()),
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
    let killTimer: NodeJS.Timeout | undefined;

    function signalGroup(signal: NodeJS.Signals): void {
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
    function terminate(): void {
      if (terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finishedGate.resolve();
      }, limits.killGraceMs);
    }
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
    child.on("close", (code) => {
      // Having asked it to stop, make sure no descendant outlives the script.
      if (terminating) signalGroup("SIGKILL");
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
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
  return { result, finished: finishedGate.promise };
}

let routingScriptRunning = false;
let routingScriptFinished: Promise<void> | null = null;

export async function waitForRoutingScriptIdleForTests(): Promise<void> {
  await routingScriptFinished;
}

export async function runRoutingScriptHandler(
  input: z.output<typeof runRoutingScript.input>,
  readSettings: ReadWorkspaceSettings,
  limits: RoutingScriptLimits = DEFAULT_ROUTING_LIMITS,
): Promise<z.output<typeof runRoutingScript.output>> {
  if (process.platform === "win32") {
    throw new Error("Routing scripts are not supported on Windows.");
  }
  const settings = await readSettings();
  const scriptPath = await resolveRoutingScript(settings.routingScriptPath);
  if (routingScriptRunning) {
    throw new Error("A routing script is already running; try again when it has finished.");
  }
  routingScriptRunning = true;
  // The guard is held until the script's process group is gone or has been sent SIGKILL, which can
  // be after the call itself has failed on a timeout.
  const run = startScriptCapped(scriptPath, input.payload, limits);
  routingScriptFinished = run.finished.then(() => {
    routingScriptRunning = false;
    routingScriptFinished = null;
  });
  void routingScriptFinished;
  const stdout = await run.result;

  if (!stdout) return {};
  const parsed = JSON.parse(stdout) as unknown;
  return RoutingScriptResultSchema.parse(parsed);
}
