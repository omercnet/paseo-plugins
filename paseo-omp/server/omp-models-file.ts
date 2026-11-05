import { tmpdir } from "node:os";
import type { RpcInput } from "@getpaseo/plugin";
import type {
  getOmpModelsFileStatus,
  OmpModelsFileStatus,
  refreshOmpModels,
} from "../shared/omp-models-file";
import { SerialMutationQueue } from "./mutation-queue";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment } from "./paths";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  runBounded,
} from "./provider-diagnostics";

const CHECK_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_DETAIL_CHARS = 300;

export interface OmpModelsDependencies {
  resolveExecutable(): Promise<string | null>;
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    stderrLimit: number,
    daemonEnvironment: boolean,
  ): Promise<BoundedRun>;
}

/**
 * A refresh asks hosted catalogs for their lists with the API keys the daemon holds, exactly as
 * Paseo's own omp provider launches OMP, so it gets the daemon environment. The models.yml check
 * only needs the stateful probe environment.
 */
export function modelsEnvironment(daemonEnvironment: boolean): NodeJS.ProcessEnv {
  const source = currentOmpEnvironment();
  return daemonEnvironment ? { ...source, NO_COLOR: "1" } : buildStatefulCommandEnv(source);
}

function runOmp(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  stderrLimit: number,
  daemonEnvironment: boolean,
): Promise<BoundedRun> {
  return runBounded(
    defaultSpawn,
    executable,
    args,
    modelsEnvironment(daemonEnvironment),
    timeoutMs,
    KILL_GRACE_MS,
    MAX_OUTPUT_BYTES,
    tmpdir(),
    stderrLimit,
  );
}

const DEFAULT_DEPENDENCIES: OmpModelsDependencies = {
  resolveExecutable: resolveOmpExecutable,
  run: runOmp,
};

function succeeded(run: BoundedRun): boolean {
  return (
    run.outcome === "exited" &&
    run.exitCode === 0 &&
    run.signal === null &&
    !run.truncated &&
    !run.cleanupFailed
  );
}

// OMP prints these lines to stderr and exits 0 when it drops a bad models.yml:
//   Warning: models.yml validation failed ...
//   Failed to load config file models, <label>: <message>
// and a schema error may continue with indented "  - <path>: <message>" lines.
const WARNING_LINE = /^Warning: models\.yml validation failed/m;
const FAILURE_PREFIX = /^Failed to load config file models, [^:]*:\s*/;
const BULLET = /^\s+- /;
// Schema errors echo the offending value as "(was ...)": a key in the wrong field would leak.
const ECHOED_VALUE = /\s*\(was .*\)\s*$/;

/** Reads OMP's models.yml warning. The detail is bounded, free of control characters and values. */
export function parseOmpModelsWarning(stderr: string): OmpModelsFileStatus {
  if (!WARNING_LINE.test(stderr)) return { state: "ok" };
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => FAILURE_PREFIX.test(line));
  const pieces: string[] = [];
  if (start >= 0) {
    pieces.push((lines[start] ?? "").replace(FAILURE_PREFIX, ""));
    for (const line of lines.slice(start + 1)) {
      if (!BULLET.test(line)) break;
      pieces.push(line.replace(BULLET, ""));
    }
  }
  const detail = pieces
    .map((piece) => piece.replace(ECHOED_VALUE, "").trim())
    .filter((piece) => piece !== "")
    .join("; ");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control characters
  const clean = detail.replace(/[\u0000-\u001f\u007f]/g, " ");
  return {
    state: "invalid",
    detail: (clean || "OMP could not load it").slice(0, MAX_DETAIL_CHARS),
  };
}

export async function getOmpModelsFileStatusWithDependencies(
  dependencies: OmpModelsDependencies,
): Promise<OmpModelsFileStatus> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) return { state: "unknown" };
  const run = await dependencies.run(
    executable,
    ["models", "--json", "--no-extensions"],
    CHECK_TIMEOUT_MS,
    MAX_STDERR_BYTES,
    false,
  );
  return succeeded(run) ? parseOmpModelsWarning(run.stderr ?? "") : { state: "unknown" };
}

function refreshMessage(run: BoundedRun): string {
  if (run.cleanupFailed) return "OMP models process cleanup could not be confirmed.";
  if (run.outcome === "timeout") return "OMP took too long to refresh its model lists.";
  if (!succeeded(run)) return "OMP could not refresh its model lists.";
  return "OMP refreshed its model lists.";
}

export async function refreshOmpModelsWithDependencies(
  dependencies: OmpModelsDependencies,
): Promise<{ ok: boolean; message: string }> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) return { ok: false, message: "The OMP executable could not be resolved." };
  const run = await dependencies.run(
    executable,
    ["models", "refresh"],
    REFRESH_TIMEOUT_MS,
    0,
    true,
  );
  return { ok: succeeded(run), message: refreshMessage(run) };
}

const refreshQueue = new SerialMutationQueue();

export function resolveGetOmpModelsFileStatus(
  _input: RpcInput<typeof getOmpModelsFileStatus>,
): Promise<OmpModelsFileStatus> {
  return getOmpModelsFileStatusWithDependencies(DEFAULT_DEPENDENCIES);
}

export function resolveRefreshOmpModels(
  _input: RpcInput<typeof refreshOmpModels>,
): Promise<{ ok: boolean; message: string }> {
  return refreshQueue.run(() => refreshOmpModelsWithDependencies(DEFAULT_DEPENDENCIES));
}
