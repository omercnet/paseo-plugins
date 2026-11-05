import { tmpdir } from "node:os";
import { delimiter, dirname, parse } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  type getOmpUpdateStatus,
  type installOmpUpdate,
  type OmpUpdateStatus,
  OmpUpdateStatusSchema,
} from "../shared/omp-update";
import { SerialMutationQueue } from "./mutation-queue";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment } from "./paths";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  runBounded,
} from "./provider-diagnostics";

const CHECK_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CHECK_CACHE_TTL_MS = 10 * 60_000;
// Network and install-root settings an npm, bun or binary self-update needs. Credentials and
// tokens stay excluded.
const UPDATE_ENV = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "BUN_INSTALL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export interface OmpUpdateDependencies {
  resolveExecutable(): Promise<string | null>;
  run(executable: string, args: readonly string[], timeoutMs: number): Promise<BoundedRun>;
}

export interface OmpInstallResult {
  ok: boolean;
  message: string;
  status: OmpUpdateStatus;
}

/**
 * `omp update` finds the install to replace by looking up `omp` on PATH, not by its own path, so
 * the directory of the executable we run goes first: the check and the update then act on the
 * install the Diagnostics card shows.
 */
export function updateEnvironment(executable: string): NodeJS.ProcessEnv {
  const source = currentOmpEnvironment();
  const env = buildStatefulCommandEnv(source);
  for (const name of UPDATE_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = [dirname(executable), env.PATH].filter(Boolean).join(delimiter);
  env.NO_COLOR = "1";
  return env;
}

function runOmp(executable: string, args: readonly string[], timeoutMs: number) {
  return runBounded(
    defaultSpawn,
    executable,
    args,
    updateEnvironment(executable),
    timeoutMs,
    KILL_GRACE_MS,
    MAX_OUTPUT_BYTES,
    tmpdir(),
  );
}

/** An executable under another name cannot be found by omp's PATH lookup, so it is refused. */
async function resolveUpdateTarget(): Promise<string | null> {
  const executable = await resolveOmpExecutable();
  return executable && parse(executable).name.toLowerCase() === "omp" ? executable : null;
}

function succeeded(run: BoundedRun): boolean {
  return (
    run.outcome === "exited" &&
    run.exitCode === 0 &&
    run.signal === null &&
    !run.truncated &&
    !run.cleanupFailed
  );
}

/** Reads the two lines `omp update --check` documents: "New version available" or "Already up to date". */
export function parseOmpUpdateCheck(stdout: string): OmpUpdateStatus {
  const available = /^New version available: (\S+)\s*$/m.exec(stdout);
  if (available) {
    const parsed = OmpUpdateStatusSchema.safeParse({ state: "available", version: available[1] });
    return parsed.success ? parsed.data : { state: "unknown" };
  }
  return /Already up to date/.test(stdout) ? { state: "up-to-date" } : { state: "unknown" };
}

function installMessage(run: BoundedRun, status: OmpUpdateStatus): string {
  if (run.cleanupFailed) return "OMP update process cleanup could not be confirmed.";
  if (run.outcome === "timeout") return "OMP update timed out. The install may be incomplete.";
  if (!succeeded(run)) return "OMP could not update itself. Update it the way it was installed.";
  if (status.state === "available") {
    return "OMP is still on the old version. If a package manager installed it, update it there.";
  }
  if (status.state === "unknown") return "OMP update finished, but the new version is unconfirmed.";
  return "OMP updated. Running agents keep the old version until they restart.";
}

/**
 * Owns the update check cache. `omp update --check` goes to the network, so a recent answer is
 * reused and concurrent callers share one run. A failed check is never cached. An install
 * invalidates every check that started before it ended, so a slow check cannot write a stale
 * answer over the post-install one.
 */
export function createOmpUpdateService(
  dependencies: OmpUpdateDependencies,
  now: () => number = Date.now,
) {
  let cached: { status: OmpUpdateStatus; expiresAt: number } | null = null;
  let inFlight: Promise<OmpUpdateStatus> | null = null;
  let generation = 0;
  const installs = new SerialMutationQueue();

  async function checkNow(): Promise<OmpUpdateStatus> {
    const executable = await dependencies.resolveExecutable();
    if (!executable) return { state: "unknown" };
    const run = await dependencies.run(executable, ["update", "--check"], CHECK_TIMEOUT_MS);
    return succeeded(run) ? parseOmpUpdateCheck(run.stdout) : { state: "unknown" };
  }

  function check(force: boolean): Promise<OmpUpdateStatus> {
    if (!force && cached && cached.expiresAt > now()) return Promise.resolve(cached.status);
    if (inFlight) return inFlight;
    const started = generation;
    const request = checkNow()
      .then((status) => {
        if (started === generation && status.state !== "unknown") {
          cached = { status, expiresAt: now() + CHECK_CACHE_TTL_MS };
        }
        return status;
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  }

  function invalidate(): void {
    generation += 1;
    cached = null;
    inFlight = null;
  }

  async function install(): Promise<OmpInstallResult> {
    const executable = await dependencies.resolveExecutable();
    if (!executable) {
      return {
        ok: false,
        message: "OMP can only be updated when its executable is named omp.",
        status: { state: "unknown" },
      };
    }
    invalidate();
    const run = await dependencies.run(executable, ["update"], INSTALL_TIMEOUT_MS);
    invalidate();
    const status = await check(true);
    return {
      ok: succeeded(run) && status.state === "up-to-date",
      message: installMessage(run, status),
      status,
    };
  }

  return {
    status: (input: RpcInput<typeof getOmpUpdateStatus>) => check(input.force === true),
    install: () => installs.run(install),
  };
}

// Binary-global, so the handlers are not store-scoped: a selected profile changes nothing here.
const service = createOmpUpdateService({ resolveExecutable: resolveUpdateTarget, run: runOmp });

export function resolveGetOmpUpdateStatus(
  input: RpcInput<typeof getOmpUpdateStatus>,
): Promise<OmpUpdateStatus> {
  return service.status(input);
}

export function resolveInstallOmpUpdate(
  _input: RpcInput<typeof installOmpUpdate>,
): Promise<OmpInstallResult> {
  return service.install();
}
