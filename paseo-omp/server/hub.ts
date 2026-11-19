import type { Dirent } from "node:fs";
import { access, open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { HubProcess, listHubProcesses, tailHubLog } from "../shared/hub";
import { ompDaemonDir } from "./paths";
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

/** omp 19's per-user daemon directory; see {@link ompDaemonDir}. */
function ompDaemonRunDir(): string {
  return process.env.PASEO_OMP_DAEMON_DIR || ompDaemonDir();
}

type Read<T> = { value: T } | { missing: true } | { unreadable: true };

export function readFailure(error: unknown): { missing: true } | { unreadable: true } {
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
  const [hashes, projectDir] = await Promise.all([readDirEntries(root), canonicalProjectDir(cwd)]);
  if ("unreadable" in hashes) return { roots: [], complete: false };
  if (!("value" in hashes)) return { roots: [], complete: true };
  const roots: string[] = [];
  let complete = true;
  await Promise.all(
    hashes.value.map(async (entry) => {
      // Only directories can be broker scopes; a stray file (`.DS_Store`) is not one.
      if (!entry.isDirectory()) return;
      const hash = entry.name;
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

export interface ScannedHubProcess extends HubProcess {
  /**
   * omp 19's unit id. `omp ps stop` resolves a bare name machine-wide (exact id first, then any
   * single unit with that key in any project), so a daemon service is stopped by its id.
   */
  unitId?: string;
}

export interface HubProcessScan {
  processes: ScannedHubProcess[];
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

async function scanBrokerProcessesFrom(root: string, cwd: string): Promise<HubProcessScan> {
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
  return scan;
}

/*
 * omp 19 replaced the per-project brokers with one per-user daemon. It keeps every unit in a
 * sqlite store, `<daemonDir>/daemon.db` (table `units`, one JSON `snapshot` per unit), and a
 * unit's output in `<daemonDir>/units/<id>/output.log`. A named service is a `proc` unit in its
 * session's project scope (`scope_key` `project:<canonical dir>`), keyed by the service name.
 * Like the broker layout above this is unversioned, so every read degrades instead of throwing.
 */
const DAEMON_SERVICE_KIND = "proc";
// A service runs as omp re-entering itself with this selector, its shell command last
// (pi-utils `SHELL_PROCESS_SELECTOR`); `omp ps` shows such a launch as just that command.
const SHELL_PROCESS_SELECTOR = "__omp_worker_shell_process";
const DaemonRowSchema = z.object({
  id: z.string(),
  key: z.string(),
  snapshot: z.string(),
  proc: z.string().nullable(),
});
const DaemonUnitSchema = z.object({
  state: z.string(),
  pids: z.array(z.number()).optional(),
  owner: z.string().optional(),
  restartCount: z.number().optional(),
  policy: z.object({ hold: z.string().optional() }).optional(),
  createdAt: z.number().optional(),
  startedAt: z.number().optional(),
  readyAt: z.number().optional(),
  exitedAt: z.number().optional(),
  exitCode: z.number().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
});

interface DaemonService {
  process: ScannedHubProcess;
  log: string;
}

interface DaemonServiceScan {
  services: DaemonService[];
  unreadable: string[];
  complete: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function launchCommand(
  spec: z.infer<typeof SpecSchema> | undefined,
  command: string | undefined,
): { application: string; args: string[] } {
  if (!spec) return { application: command ?? "", args: [] };
  const args = spec.args ?? [];
  if (args.includes(SHELL_PROCESS_SELECTOR)) return { application: args.at(-1) ?? "", args: [] };
  return { application: spec.application, args };
}

function toDaemonService(
  daemonDir: string,
  row: z.infer<typeof DaemonRowSchema>,
): DaemonService | undefined {
  let snapshot: unknown;
  let proc: unknown;
  try {
    snapshot = JSON.parse(row.snapshot);
    proc = row.proc === null ? undefined : JSON.parse(row.proc);
  } catch {
    return undefined;
  }
  const parsed = DaemonUnitSchema.safeParse(snapshot);
  if (!parsed.success) return undefined;
  const unit = parsed.data;
  const spec = SpecSchema.safeParse(proc).data;
  // The store keeps a unit's last persisted state, and a daemon that died took its services down
  // with it (omp's own offline `ps` reports them exited), so a running state whose main process
  // is gone is stale. Transitional states are left alone: a live daemon may be restarting the
  // service or still ending its tree.
  const mainPid = unit.pids?.[0];
  const stale =
    (unit.state === "running" || unit.state === "ready") &&
    mainPid !== undefined &&
    // kill(0)/kill(-n) would probe a process group, not this service.
    mainPid > 0 &&
    !processAlive(mainPid);
  return {
    log: join(daemonDir, "units", row.id, "output.log"),
    process: {
      name: row.key,
      ...launchCommand(spec, unit.command),
      cwd: spec?.cwd ?? unit.cwd ?? "",
      state: stale ? "exited" : unit.state,
      owner: unit.owner ?? null,
      restartCount: unit.restartCount ?? 0,
      persist: unit.policy?.hold === "persist",
      detached: unit.policy?.hold === "detached",
      createdAt: unit.createdAt ?? null,
      startedAt: unit.startedAt ?? null,
      readyAt: unit.readyAt ?? null,
      exitedAt: unit.exitedAt ?? null,
      exitCode: unit.exitCode ?? null,
      unitId: row.id,
    },
  };
}

async function scanDaemonServicesFrom(daemonDir: string, cwd: string): Promise<DaemonServiceScan> {
  const scan: DaemonServiceScan = { services: [], unreadable: [], complete: true };
  const path = join(daemonDir, "daemon.db");
  try {
    await access(path);
  } catch (error) {
    // No store: omp 19 never ran here (or omp is older), so it owns no services.
    return "missing" in readFailure(error) ? scan : { ...scan, complete: false };
  }
  // omp keys the scope by the same canonical directory (`daemon/paths.ts` canonicalProjectDir).
  const projectDir = await canonicalProjectDir(cwd);
  let rows: unknown[];
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      rows = database
        .prepare("SELECT id, key, snapshot, proc FROM units WHERE kind = ? AND scope_key = ?")
        .all(DAEMON_SERVICE_KIND, `project:${projectDir}`);
    } finally {
      database.close();
    }
  } catch {
    return { ...scan, complete: false };
  }
  for (const value of rows) {
    const row = DaemonRowSchema.safeParse(value);
    if (!row.success) {
      scan.complete = false;
      continue;
    }
    const service = toDaemonService(daemonDir, row.data);
    if (service) scan.services.push(service);
    else scan.unreadable.push(row.data.key);
  }
  return scan;
}

/**
 * Every hub process of `cwd`'s project: the 18.x per-project brokers under `root` and, when
 * `daemonDir` is given, omp 19's per-user daemon. Both can hold services at once on a machine
 * that upgraded, since omp 19 does not adopt the brokers' services.
 */
export async function scanHubProcessesFrom(
  root: string,
  cwd: string,
  daemonDir?: string,
): Promise<HubProcessScan> {
  const [brokers, daemon] = await Promise.all([
    scanBrokerProcessesFrom(root, cwd),
    daemonDir === undefined ? undefined : scanDaemonServicesFrom(daemonDir, cwd),
  ]);
  const scan: HubProcessScan = daemon
    ? {
        processes: [...brokers.processes, ...daemon.services.map((service) => service.process)],
        unreadable: [...brokers.unreadable, ...daemon.unreadable],
        strays: brokers.strays,
        complete: brokers.complete && daemon.complete,
      }
    : brokers;
  scan.processes.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return scan;
}

export async function listHubProcessesFrom(
  root: string,
  cwd: string,
  daemonDir?: string,
): Promise<HubProcess[]> {
  const { processes } = await scanHubProcessesFrom(root, cwd, daemonDir);
  return processes.map(({ unitId: _unitId, ...process }) => process);
}

export async function resolveListHubProcesses({
  cwd,
}: RpcInput<typeof listHubProcesses>): Promise<{ processes: HubProcess[] }> {
  return { processes: await listHubProcessesFrom(ompRunDir(), cwd, ompDaemonRunDir()) };
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
   * Asks omp to stop one service, named by its omp 19 unit id or its 18.x broker name, within
   * `timeoutMs`; resolves true only when the command succeeded.
   */
  stop(target: string, cwd: string, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OwnedHubCleanupResult {
  stopped: string[];
  failed: string[];
  /** False when omp's records could not all be read, so an owned service may have been missed. */
  complete: boolean;
  /** Set when the launcher wraps OMP's environment, so the broker could not be located. */
  unsupportedLauncher?: true;
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
  processes: readonly ScannedHubProcess[],
  owners: HubServiceOwners,
  states: Readonly<Record<string, true>>,
): ScannedHubProcess[] {
  return processes.filter(
    (process) =>
      HUB_SERVICE_NAME.test(process.name) &&
      process.owner !== null &&
      startedWhileOwned(process, owners.get(process.owner)) &&
      process.persist &&
      !process.detached &&
      states[process.state] === true,
  );
}

/** What `omp ps stop` is given: an omp 19 unit by its id, an 18.x broker service by its name. */
function stopTarget(process: ScannedHubProcess): string {
  return process.unitId ?? process.name;
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
  const failed = new Set<ScannedHubProcess>();
  const queue = [...owned];
  const stopDeadline = deadline - HUB_CLEANUP_VERIFY_RESERVE_MS;
  const stopNext = async (): Promise<void> => {
    for (let service = queue.shift(); service !== undefined; service = queue.shift()) {
      const remaining = stopDeadline - dependencies.now();
      const stopped =
        remaining > 0 &&
        (await dependencies.stop(stopTarget(service), cwd, remaining).catch(() => false));
      if (!stopped) failed.add(service);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HUB_CLEANUP_STOP_CONCURRENCY, owned.length) }, stopNext),
  );
  // Report success only for services omp's own state confirms have settled. A record that cannot
  // be read is unknown, not stopped.
  let unsettled: ScannedHubProcess[];
  while (true) {
    const current = await boundedScan(dependencies, cwd, deadline - dependencies.now());
    if (current?.complete) {
      const live = new Set(
        ownedPersistentServices(current.processes, owners, UNSETTLED_HUB_STATES).map(stopTarget),
      );
      const unknown = new Set([...current.unreadable, ...current.strays]);
      unsettled = owned.filter(
        (service) => live.has(stopTarget(service)) || unknown.has(service.name),
      );
    } else {
      unsettled = owned;
    }
    if (unsettled.length === 0 || dependencies.now() >= deadline) break;
    await dependencies.sleep(HUB_CLEANUP_POLL_MS);
    // Keep the last observation rather than scan with no time left.
    if (dependencies.now() >= deadline) break;
  }
  for (const service of unsettled) failed.add(service);
  return {
    stopped: owned.filter((service) => !failed.has(service)).map((service) => service.name),
    failed: owned.filter((service) => failed.has(service)).map((service) => service.name),
    complete,
  };
}

export function ownedHubCleanupDependencies(
  runOmp: (args: readonly string[], timeoutMs: number) => Promise<boolean>,
  root = ompRunDir(),
  daemonDir = ompDaemonRunDir(),
): OwnedHubCleanupDependencies {
  return {
    scan: (cwd) => scanHubProcessesFrom(root, cwd, daemonDir),
    expire: (ms) => {
      const fired = Promise.withResolvers<void>();
      const timer = setTimeout(fired.resolve, ms);
      return { fired: fired.promise, cancel: () => clearTimeout(timer) };
    },
    stop: (target, cwd, timeoutMs) => runOmp(["ps", "stop", "--dir", cwd, "--", target], timeoutMs),
    sleep: waitMs,
    now: () => Date.now(),
  };
}

// omp 19 lets a unit's log grow to 25 MiB before rotating it, so read only the tail.
async function readLogTail(path: string): Promise<{ content: string; truncated: boolean }> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const truncated = size > MAX_LOG_BYTES;
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), truncated };
  } finally {
    await file.close();
  }
}

export async function tailHubLogFrom(
  root: string,
  cwd: string,
  name: string,
  daemonDir?: string,
): Promise<{ content: string; truncated: boolean }> {
  if (daemonDir !== undefined) {
    // omp 19's daemon runs every current service, so its newest record of the name wins.
    const { services } = await scanDaemonServicesFrom(daemonDir, cwd);
    const newest = services
      .filter((service) => service.process.name === name)
      .sort((a, b) => (b.process.startedAt ?? 0) - (a.process.startedAt ?? 0))[0];
    if (newest) {
      // A unit that has not written output yet (or whose log was pruned) has no log to show.
      return readLogTail(newest.log).catch(() => ({ content: "", truncated: false }));
    }
  }
  const { roots } = await findProjectDaemonRoots(root, cwd);
  for (const projectRoot of roots) {
    try {
      return await readLogTail(join(projectRoot, "daemons", name, "output.log"));
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
  return tailHubLogFrom(ompRunDir(), cwd, name, ompDaemonRunDir());
}
