import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { HubProcess, listHubProcesses, tailHubLog } from "../shared/hub";

const MAX_LOG_BYTES = 64 * 1024;

const ScopeFileSchema = z.object({ projectDir: z.string() });
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
  spec: z.object({
    application: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
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

function toHubProcess(name: string, value: unknown): HubProcess | undefined {
  const parsed = MetaFileSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { daemon, spec } = parsed.data;
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
          const meta = await readJsonFile(join(projectRoot, "daemons", name, "meta.json"));
          const process = toHubProcess(name, meta);
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
