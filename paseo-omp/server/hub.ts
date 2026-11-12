import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { HubProcess, listHubProcesses, tailHubLog } from "../shared/hub";
import { waitMs } from "./provider/omp-rpc-process";

const MAX_LOG_BYTES = 64 * 1024;

const ScopeFileSchema = z.object({ projectDir: z.string() });
// omp 18.8 moved the spec from meta.json to a sibling spec.json; older releases embed it in meta.json.
const SpecSchema = z.object({
  application: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

const MetaFileSchema = z.object({
  daemon: z.object({
    state: z.string(),
    owner: z.string().optional(),
    restartCount: z.number().optional(),
    persist: z.boolean().optional(),
    detached: z.boolean().optional(),
    createdAt: z.number().optional(),
    startedAt: z.number().optional(),
    readyAt: z.number().optional(),
    exitedAt: z.number().optional(),
    exitCode: z.number().optional(),
  }),
  spec: SpecSchema.optional(),
});

/**
 * omp's hub keeps per-project process state at
 * ~/.omp/run/daemons/<projectHash>/{scope.json, daemons/<name>/{meta.json,output.log}}.
 * `scope.json.projectDir` matches a workspace's cwd exactly, so a project's hub processes can
 * be resolved without any cooperation from the omp process itself.
 *
 * This is an internal, unversioned implementation detail of the omp harness: every read below
 * is best-effort and degrades to an empty/partial result instead of throwing when a file is
 * missing, unreadable, or shaped differently than expected (a future omp release is free to
 * change or remove this layout).
 */
function ompRunDir(): string {
  return process.env.PASEO_OMP_RUN_DIR ?? join(homedir(), ".omp", "run", "daemons");
}

type Read<T> = { value: T } | { missing: true } | { unreadable: true };

function readFailure(error: unknown): { missing: true } | { unreadable: true } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Only ENOENT proves a record is gone; anything else (ENOTDIR included) leaves it unknown.
  return code === "ENOENT" ? { missing: true } : { unreadable: true };
}

async function readJson(path: string): Promise<Read<unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return readFailure(error);
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { unreadable: true };
  }
}

async function readDirEntries(path: string): Promise<Read<Dirent[]>> {
  try {
    return { value: await readdir(path, { withFileTypes: true }) };
  } catch (error) {
    return readFailure(error);
  }
}

async function readDirNames(path: string): Promise<Read<string[]>> {
  try {
    return { value: await readdir(path) };
  } catch (error) {
    return readFailure(error);
  }
}

// omp keys a project's broker by its realpath (`canonicalProjectDir`), so a symlinked or
// trailing-slash cwd must be resolved the same way to find its `scope.json`.
async function canonicalProjectDir(cwd: string): Promise<string> {
  const resolved = resolve(cwd);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function findProjectDaemonRoots(
  root: string,
  cwd: string,
): Promise<{ roots: string[]; complete: boolean }> {
  const [hashes, projectDir] = await Promise.all([readDirNames(root), canonicalProjectDir(cwd)]);
  if ("unreadable" in hashes) return { roots: [], complete: false };
  if (!("value" in hashes)) return { roots: [], complete: true };
  const roots: string[] = [];
  let complete = true;
  await Promise.all(
    hashes.value.map(async (hash) => {
      const read = await readJson(join(root, hash, "scope.json"));
      if ("unreadable" in read) complete = false;
      if (!("value" in read)) return;
      const scope = ScopeFileSchema.safeParse(read.value);
      if (scope.success && (scope.data.projectDir === projectDir || scope.data.projectDir === cwd))
        roots.push(join(root, hash));
    }),
  );
  return { roots, complete };
}

function toHubProcess(name: string, value: unknown, specFile: unknown): HubProcess | undefined {
  const parsed = MetaFileSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { daemon } = parsed.data;
  const spec = parsed.data.spec ?? SpecSchema.safeParse(specFile).data;
  if (!spec) return undefined;
  return {
    name,
    application: spec.application,
    args: spec.args ?? [],
    cwd: spec.cwd ?? "",
    state: daemon.state,
    owner: daemon.owner ?? null,
    restartCount: daemon.restartCount ?? 0,
    persist: daemon.persist ?? false,
    detached: daemon.detached ?? false,
    createdAt: daemon.createdAt ?? null,
    startedAt: daemon.startedAt ?? null,
    readyAt: daemon.readyAt ?? null,
    exitedAt: daemon.exitedAt ?? null,
    exitCode: daemon.exitCode ?? null,
  };
}

export interface HubProcessScan {
  processes: HubProcess[];
  /** Records that exist but could not be read or parsed: their state is unknown. */
  unreadable: string[];
  /**
   * Entries under `daemons/` that are not directories. omp skips them too (`readPersistedDaemons`),
   * so they are not services, but an owned service whose record turned into one is unknown.
   */
  strays: string[];
  /** False when a directory that could hold this project's records could not be read. */
  complete: boolean;
}

export async function scanHubProcessesFrom(root: string, cwd: string): Promise<HubProcessScan> {
  const found = await findProjectDaemonRoots(root, cwd);
  const scan: HubProcessScan = {
    processes: [],
    unreadable: [],
    strays: [],
    complete: found.complete,
  };
  await Promise.all(
    found.roots.map(async (projectRoot) => {
      const entries = await readDirEntries(join(projectRoot, "daemons"));
      if ("unreadable" in entries) scan.complete = false;
      if (!("value" in entries)) return;
      await Promise.all(
        entries.value.map(async (entry) => {
          const name = entry.name;
          if (!entry.isDirectory()) {
            scan.strays.push(name);
            return;
          }
          const dir = join(projectRoot, "daemons", name);
          const [meta, spec] = await Promise.all([
            readJson(join(dir, "meta.json")),
            readJson(join(dir, "spec.json")),
          ]);
          if ("missing" in meta) return;
          const process =
            "value" in meta
              ? toHubProcess(name, meta.value, "value" in spec ? spec.value : undefined)
              : undefined;
          if (process) scan.processes.push(process);
          else scan.unreadable.push(name);
        }),
      );
    }),
  );
  scan.processes.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return scan;
}

export async function listHubProcessesFrom(root: string, cwd: string): Promise<HubProcess[]> {
  return (await scanHubProcessesFrom(root, cwd)).processes;
}

export async function resolveListHubProcesses({
  cwd,
}: RpcInput<typeof listHubProcesses>): Promise<{ processes: HubProcess[] }> {
  return { processes: await listHubProcessesFrom(ompRunDir(), cwd) };
}

// omp 18.18.9 made launch services persistent in RPC mode (`launch.persist` is forced on for
// every non-interactive host), so they no longer end with the omp process that started them.
// A Paseo agent owns its OMP session: once that session's process tree is gone, stop the
// services it still owns. Detached services were explicitly handed off and are left alone, and
// non-persistent ones are still stopped by omp's own broker lifecycle.
const LIVE_HUB_STATES: Readonly<Record<string, true>> = {
  starting: true,
  running: true,
  ready: true,
  restarting: true,
};
// The broker records `stopping` before it signals the tree and the terminal state after it
// settles, so a service is only confirmed gone once its metadata leaves both.
const UNSETTLED_HUB_STATES: Readonly<Record<string, true>> = { ...LIVE_HUB_STATES, stopping: true };
const HUB_CLEANUP_POLL_MS = 100;
// One deadline for the whole cleanup, so a hung CLI, a service that ignores SIGTERM or many
// services cannot hold the agent's close. omp's own stop grace is 5s plus 1s to settle. Stops
// leave the last stretch for verification, and the broker stops each record on its own, so a
// few stops run at once.
const HUB_CLEANUP_MS = 12_000;
const HUB_CLEANUP_VERIFY_RESERVE_MS = 2_000;
const HUB_CLEANUP_STOP_CONCURRENCY = 4;

// omp's broker rejects any other service name; anything else read from disk is not ours to stop,
// and the leading-alphanumeric rule keeps a name from ever being parsed as a CLI flag.
const HUB_SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

export interface OwnedHubCleanupDependencies {
  scan(cwd: string): Promise<HubProcessScan>;
  /** A timer that fires after `ms`; scans that outlive it count as incomplete. */
  expire(ms: number): { fired: Promise<void>; cancel(): void };
  /**
   * Asks omp's broker to stop one service within `timeoutMs`; resolves true only when the
   * command succeeded.
   */
  stop(name: string, cwd: string, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OwnedHubCleanupResult {
  stopped: string[];
  failed: string[];
  /** False when omp's records could not all be read, so an owned service may have been missed. */
  complete: boolean;
}

/**
 * OMP session ids whose services an agent may stop, each mapped to the last `createdAt` it can
 * claim: `Infinity` for the live id, the hand-off time for an id the agent left (a rewind or
 * branch releases it, so another agent may resume it and start services of its own).
 */
export type HubServiceOwners = ReadonlyMap<string, number>;

function startedWhileOwned(process: HubProcess, ownedUntil: number | undefined): boolean {
  if (ownedUntil === undefined) return false;
  if (ownedUntil === Number.POSITIVE_INFINITY) return true;
  return process.createdAt !== null && process.createdAt <= ownedUntil;
}

function ownedPersistentServices(
  processes: readonly HubProcess[],
  owners: HubServiceOwners,
  states: Readonly<Record<string, true>>,
): string[] {
  return processes
    .filter(
      (process) =>
        HUB_SERVICE_NAME.test(process.name) &&
        process.owner !== null &&
        startedWhileOwned(process, owners.get(process.owner)) &&
        process.persist &&
        !process.detached &&
        states[process.state] === true,
    )
    .map((process) => process.name);
}

async function boundedScan(
  dependencies: OwnedHubCleanupDependencies,
  cwd: string,
  ms: number,
): Promise<HubProcessScan | undefined> {
  if (ms <= 0) return undefined;
  const timer = dependencies.expire(ms);
  try {
    return await Promise.race([
      dependencies.scan(cwd).catch(() => undefined),
      timer.fired.then(() => undefined),
    ]);
  } finally {
    timer.cancel();
  }
}

export async function stopOwnedHubProcesses(
  cwd: string,
  owners: HubServiceOwners,
  dependencies: OwnedHubCleanupDependencies,
): Promise<OwnedHubCleanupResult> {
  if (owners.size === 0) return { stopped: [], failed: [], complete: true };
  // The deadline covers discovery too, so a hung filesystem cannot hold the close either.
  const deadline = dependencies.now() + HUB_CLEANUP_MS;
  const initial = await boundedScan(dependencies, cwd, deadline - dependencies.now());
  if (!initial) return { stopped: [], failed: [], complete: false };
  const owned = ownedPersistentServices(initial.processes, owners, LIVE_HUB_STATES);
  // A record that cannot be read may be one of ours, so the lookup is not complete.
  const complete = initial.complete && initial.unreadable.length === 0;
  if (owned.length === 0) return { stopped: [], failed: [], complete };
  const failed = new Set<string>();
  const queue = [...owned];
  const stopDeadline = deadline - HUB_CLEANUP_VERIFY_RESERVE_MS;
  const stopNext = async (): Promise<void> => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const remaining = stopDeadline - dependencies.now();
      const stopped =
        remaining > 0 && (await dependencies.stop(name, cwd, remaining).catch(() => false));
      if (!stopped) failed.add(name);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HUB_CLEANUP_STOP_CONCURRENCY, owned.length) }, stopNext),
  );
  // Report success only for services omp's own state confirms have settled. A record that cannot
  // be read is unknown, not stopped.
  let unsettled: ReadonlySet<string>;
  while (true) {
    const current = await boundedScan(dependencies, cwd, deadline - dependencies.now());
    unsettled = new Set(
      current?.complete
        ? [
            ...ownedPersistentServices(current.processes, owners, UNSETTLED_HUB_STATES),
            ...current.unreadable,
            ...current.strays,
          ].filter((name) => owned.includes(name))
        : owned,
    );
    if (unsettled.size === 0 || dependencies.now() >= deadline) break;
    await dependencies.sleep(HUB_CLEANUP_POLL_MS);
    // Keep the last observation rather than scan with no time left.
    if (dependencies.now() >= deadline) break;
  }
  for (const name of unsettled) failed.add(name);
  return {
    stopped: owned.filter((name) => !failed.has(name)),
    failed: owned.filter((name) => failed.has(name)),
    complete,
  };
}

export function ownedHubCleanupDependencies(
  runOmp: (args: readonly string[], timeoutMs: number) => Promise<boolean>,
  root = ompRunDir(),
): OwnedHubCleanupDependencies {
  return {
    scan: (cwd) => scanHubProcessesFrom(root, cwd),
    expire: (ms) => {
      const fired = Promise.withResolvers<void>();
      const timer = setTimeout(fired.resolve, ms);
      return { fired: fired.promise, cancel: () => clearTimeout(timer) };
    },
    stop: (name, cwd, timeoutMs) => runOmp(["ps", "stop", "--dir", cwd, "--", name], timeoutMs),
    sleep: waitMs,
    now: () => Date.now(),
  };
}

export async function tailHubLogFrom(
  root: string,
  cwd: string,
  name: string,
): Promise<{ content: string; truncated: boolean }> {
  const { roots } = await findProjectDaemonRoots(root, cwd);
  for (const projectRoot of roots) {
    try {
      const buffer = await readFile(join(projectRoot, "daemons", name, "output.log"));
      const truncated = buffer.byteLength > MAX_LOG_BYTES;
      const slice = truncated ? buffer.subarray(buffer.byteLength - MAX_LOG_BYTES) : buffer;
      return { content: slice.toString("utf8"), truncated };
    } catch {
      // This root doesn't have that process (or its log vanished); try the next match.
    }
  }
  return { content: "", truncated: false };
}

export async function resolveTailHubLog({
  cwd,
  name,
}: RpcInput<typeof tailHubLog>): Promise<{ content: string; truncated: boolean }> {
  return tailHubLogFrom(ompRunDir(), cwd, name);
}
