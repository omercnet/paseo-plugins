import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function listDirNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function findProjectDaemonRoots(root: string, cwd: string): Promise<string[]> {
  const hashes = await listDirNames(root);
  const matches: string[] = [];
  await Promise.all(
    hashes.map(async (hash) => {
      const scope = ScopeFileSchema.safeParse(await readJsonFile(join(root, hash, "scope.json")));
      if (scope.success && scope.data.projectDir === cwd) matches.push(join(root, hash));
    }),
  );
  return matches;
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

export async function listHubProcessesFrom(root: string, cwd: string): Promise<HubProcess[]> {
  const roots = await findProjectDaemonRoots(root, cwd);
  const processes: HubProcess[] = [];
  await Promise.all(
    roots.map(async (projectRoot) => {
      const names = await listDirNames(join(projectRoot, "daemons"));
      await Promise.all(
        names.map(async (name) => {
          const dir = join(projectRoot, "daemons", name);
          const [meta, spec] = await Promise.all([
            readJsonFile(join(dir, "meta.json")),
            readJsonFile(join(dir, "spec.json")),
          ]);
          const process = toHubProcess(name, meta, spec);
          if (process) processes.push(process);
        }),
      );
    }),
  );
  processes.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return processes;
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
const HUB_CLEANUP_VERIFY_MS = 3_000;
const HUB_CLEANUP_POLL_MS = 100;

// omp's broker rejects any other service name; anything else read from disk is not ours to stop,
// and the leading-alphanumeric rule keeps a name from ever being parsed as a CLI flag.
const HUB_SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

export interface OwnedHubCleanupDependencies {
  list(cwd: string): Promise<HubProcess[]>;
  /** Asks omp's broker to stop one service; resolves true only when the command succeeded. */
  stop(name: string, cwd: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OwnedHubCleanupResult {
  stopped: string[];
  failed: string[];
}

function ownedPersistentServices(
  processes: readonly HubProcess[],
  owners: ReadonlySet<string>,
  states: Readonly<Record<string, true>>,
): string[] {
  return processes
    .filter(
      (process) =>
        HUB_SERVICE_NAME.test(process.name) &&
        process.owner !== null &&
        owners.has(process.owner) &&
        process.persist &&
        !process.detached &&
        states[process.state] === true,
    )
    .map((process) => process.name);
}

export async function stopOwnedHubProcesses(
  cwd: string,
  owners: ReadonlySet<string>,
  dependencies: OwnedHubCleanupDependencies,
): Promise<OwnedHubCleanupResult> {
  if (owners.size === 0) return { stopped: [], failed: [] };
  const owned = ownedPersistentServices(await dependencies.list(cwd), owners, LIVE_HUB_STATES);
  if (owned.length === 0) return { stopped: [], failed: [] };
  const failed = new Set<string>();
  for (const name of owned) {
    if (!(await dependencies.stop(name, cwd).catch(() => false))) failed.add(name);
  }
  // Report success only for services omp's own state confirms have settled.
  const deadline = dependencies.now() + HUB_CLEANUP_VERIFY_MS;
  let unsettled: ReadonlySet<string>;
  while (true) {
    const current = ownedPersistentServices(
      await dependencies.list(cwd),
      owners,
      UNSETTLED_HUB_STATES,
    );
    unsettled = new Set(current.filter((name) => owned.includes(name)));
    if (unsettled.size === 0 || dependencies.now() >= deadline) break;
    await dependencies.sleep(HUB_CLEANUP_POLL_MS);
  }
  for (const name of unsettled) failed.add(name);
  return {
    stopped: owned.filter((name) => !failed.has(name)),
    failed: owned.filter((name) => failed.has(name)),
  };
}

export function ownedHubCleanupDependencies(
  runOmp: (args: readonly string[]) => Promise<boolean>,
  root = ompRunDir(),
): OwnedHubCleanupDependencies {
  return {
    list: (cwd) => listHubProcessesFrom(root, cwd),
    stop: (name, cwd) => runOmp(["ps", "stop", name, "--dir", cwd]),
    sleep: waitMs,
    now: () => Date.now(),
  };
}

export async function tailHubLogFrom(
  root: string,
  cwd: string,
  name: string,
): Promise<{ content: string; truncated: boolean }> {
  const roots = await findProjectDaemonRoots(root, cwd);
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
