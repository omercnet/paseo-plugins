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
  ): Promise<BoundedRun>;
}

function runOmp(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  stderrLimit: number,
): Promise<BoundedRun> {
  return runBounded(
    defaultSpawn,
    executable,
    args,
    buildStatefulCommandEnv(currentOmpEnvironment()),
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

// OMP prints these two lines to stderr and exits 0 when it drops a bad models.yml.
const WARNING_LINE = /^Warning: models\.yml validation failed/m;
const DETAIL_LINE =
  /^Failed to load config file models, (?:Validate\(models\) error|Unexpected error): (.+)$/m;

/** Reads OMP's models.yml warning. The detail is one bounded line with no control characters. */
export function parseOmpModelsWarning(stderr: string): OmpModelsFileStatus {
  if (!WARNING_LINE.test(stderr)) return { state: "ok" };
  const detail = DETAIL_LINE.exec(stderr)?.[1] ?? "OMP could not load it";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control characters
  const clean = detail.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return { state: "invalid", detail: clean.slice(0, MAX_DETAIL_CHARS) };
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
  const run = await dependencies.run(executable, ["models", "refresh"], REFRESH_TIMEOUT_MS, 0);
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
