import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";

type TimerHandle = number | NodeJS.Timeout;

export const PROCESS_STOP_TIMEOUT_MS = 750;
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";

export function waitMs(ms: number): Promise<void> {
  const result = Promise.withResolvers<void>();
  setTimeout(result.resolve, ms);
  return result.promise;
}

function processIsGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

export function isConfirmedNoProcessSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/**
 * Terminates the detached process group created for OMP. This covers descendants that remain in
 * that group after the leader exits; descendants that deliberately re-parent into another process
 * group are outside this transport's containment boundary.
 */
export async function terminatePosixProcessTree(
  pid: number,
  graceMs: number,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
  wait: (ms: number) => Promise<void> = waitMs,
): Promise<boolean> {
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGTERM");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGKILL");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
    return false;
  } catch (error) {
    return processIsGone(error);
  }
}

export type ProcessTreeCleanup = "verified" | "uncertain" | "failed";

export async function stopWindowsTree(pid: number): Promise<ProcessTreeCleanup> {
  const result = Promise.withResolvers<ProcessTreeCleanup>();
  const systemRoot = process.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT;
  let taskkill: ChildProcessWithoutNullStreams;
  try {
    taskkill = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { SystemRoot: systemRoot },
      },
    );
  } catch {
    return "failed";
  }
  taskkill.stdout.resume();
  taskkill.stderr.resume();
  let settled = false;
  let deadline: TimerHandle | undefined;
  let finalDeadline: TimerHandle | undefined;
  const finish = (outcome: ProcessTreeCleanup) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(finalDeadline);
    result.resolve(outcome);
  };
  deadline = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finalDeadline = setTimeout(() => finish("failed"), PROCESS_STOP_TIMEOUT_MS);
  }, PROCESS_STOP_TIMEOUT_MS);
  taskkill.once("error", () => finish("failed"));
  taskkill.once("close", (code, signal) => {
    finish(
      code === 0 && signal === null
        ? "verified"
        : code === 128 && signal === null
          ? "uncertain"
          : "failed",
    );
  });
  return result.promise;
}

export async function terminateSpawnedProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32") return (await stopWindowsTree(pid)) === "verified";
  return await terminatePosixProcessTree(pid, PROCESS_STOP_TIMEOUT_MS);
}
