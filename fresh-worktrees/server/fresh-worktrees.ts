import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

export type WorkspaceCreateRequest = PluginBeforeRequests["workspace.create"];
type WorktreeSource = Extract<WorkspaceCreateRequest["source"], { kind: "worktree" }>;

export interface ProjectDescriptor {
  projectId: string;
  projectRootPath: string;
  projectKind: "git" | "non_git" | "directory";
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>;

export type RemoteRefresh = (cwd: string, remote: string, signal: AbortSignal) => Promise<void>;

export interface RefreshDependencies {
  signal: AbortSignal;
  listProjects(): Promise<readonly ProjectDescriptor[]>;
  refreshRemote: RemoteRefresh;
  runGit?: GitRunner;
  log?(message: string): void;
}

const execFileAsync = promisify(execFile);

export async function executeGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024,
      signal,
    });
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`, { cause: error });
  }
}

export function createRemoteRefreshCoordinator(runGit: GitRunner = executeGit): RemoteRefresh {
  const inFlight = new Map<string, Promise<void>>();

  return async (cwd, remote, signal) => {
    const key = `${cwd}\0${remote}`;
    let refresh = inFlight.get(key);
    if (!refresh) {
      refresh = runGit(cwd, ["fetch", "--prune", "--quiet", remote], signal).then(() => {});
      inFlight.set(key, refresh);
    }

    try {
      await refresh;
    } finally {
      if (inFlight.get(key) === refresh) {
        inFlight.delete(key);
      }
    }
  };
}

function remoteForRef(ref: string | null, remotes: readonly string[]): string | null {
  if (!ref) return null;
  const shortRef = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
  return (
    [...remotes]
      .sort((left, right) => right.length - left.length)
      .find((remote) => shortRef.startsWith(`${remote}/`)) ?? null
  );
}

async function optionalGit(
  runGit: GitRunner,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(cwd, args, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function localBranchDetails(
  runGit: GitRunner,
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ branch: string; upstream: string | null } | null> {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const exists = await optionalGit(
    runGit,
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    signal,
  );
  if (exists === null) return null;

  const upstream = await optionalGit(
    runGit,
    cwd,
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    signal,
  );
  return { branch, upstream: upstream || null };
}

async function remoteRefExists(
  runGit: GitRunner,
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<boolean> {
  const fullRef = ref.startsWith("refs/remotes/") ? ref : `refs/remotes/${ref}`;
  return (
    (await optionalGit(runGit, cwd, ["show-ref", "--verify", "--quiet", fullRef], signal)) !==
    null
  );
}

async function resolveProjectRoot(
  source: WorktreeSource,
  listProjects: RefreshDependencies["listProjects"],
): Promise<string | null> {
  if (source.cwd) return source.cwd;
  if (!source.projectId) return null;

  const project = (await listProjects()).find(({ projectId }) => projectId === source.projectId);
  return project?.projectKind === "git" ? project.projectRootPath : null;
}

export async function refreshWorkspaceRequest(
  request: WorkspaceCreateRequest,
  dependencies: RefreshDependencies,
): Promise<WorkspaceCreateRequest> {
  const source = request.source;
  if (
    source.kind !== "worktree" ||
    source.action === "checkout" ||
    source.checkoutSource !== undefined ||
    source.githubPrNumber !== undefined
  ) {
    return request;
  }

  const cwd = await resolveProjectRoot(source, dependencies.listProjects);
  if (!cwd) {
    dependencies.log?.("Skipped refresh because the source project path could not be resolved");
    return request;
  }

  const runGit = dependencies.runGit ?? executeGit;
  const remotes = (await runGit(cwd, ["remote"], dependencies.signal))
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);
  if (remotes.length === 0) return request;

  const requestedRef = source.refName?.trim() || null;
  let localBranch = requestedRef
    ? await localBranchDetails(runGit, cwd, requestedRef, dependencies.signal)
    : null;

  if (!requestedRef) {
    const currentBranch = await optionalGit(
      runGit,
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      dependencies.signal,
    );
    if (currentBranch) {
      localBranch = await localBranchDetails(
        runGit,
        cwd,
        currentBranch,
        dependencies.signal,
      );
    }
  }

  const remote =
    remoteForRef(requestedRef, remotes) ??
    remoteForRef(localBranch?.upstream ?? null, remotes) ??
    (remotes.includes("origin") ? "origin" : remotes[0]);

  await dependencies.refreshRemote(cwd, remote, dependencies.signal);

  let freshBase: string | null = null;
  if (requestedRef && remoteForRef(requestedRef, remotes)) {
    freshBase = requestedRef;
  } else if (localBranch) {
    if (
      localBranch.upstream &&
      (await remoteRefExists(runGit, cwd, localBranch.upstream, dependencies.signal))
    ) {
      freshBase = localBranch.upstream;
    } else {
      const matchingRemoteBranch = `${remote}/${localBranch.branch}`;
      if (await remoteRefExists(runGit, cwd, matchingRemoteBranch, dependencies.signal)) {
        freshBase = matchingRemoteBranch;
      }
    }
  } else if (!requestedRef) {
    const remoteHead = await optionalGit(
      runGit,
      cwd,
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      dependencies.signal,
    );
    if (remoteHead && (await remoteRefExists(runGit, cwd, remoteHead, dependencies.signal))) {
      freshBase = remoteHead;
    }
  }

  dependencies.log?.(
    freshBase
      ? `Fetched ${remote} for ${cwd}; basing the worktree on ${freshBase}`
      : `Fetched ${remote} for ${cwd}; preserving the requested base`,
  );

  if (!freshBase || freshBase === source.refName) return request;
  return { ...request, source: { ...source, refName: freshBase } };
}
