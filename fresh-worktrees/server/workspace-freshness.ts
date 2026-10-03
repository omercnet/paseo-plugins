import type { RpcOutput } from "@getpaseo/plugin";
import type {
  refreshSourceBranch as refreshSourceBranchContract,
  workspaceFreshness,
} from "../shared/workspace-freshness";
import type { GitRunner, RepositoryRefresh } from "./fresh-worktrees";
import { executeGit } from "./fresh-worktrees";

export interface WorkspaceFreshnessDependencies {
  signal: AbortSignal;
  refreshRepository: RepositoryRefresh;
  runGit?: GitRunner;
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

export async function inspectWorkspaceFreshness(
  projectRootPath: string,
  workspaceDirectory: string,
  dependencies: WorkspaceFreshnessDependencies,
): Promise<RpcOutput<typeof workspaceFreshness>> {
  const runGit = dependencies.runGit ?? executeGit;
  const branch = await optionalGit(
    runGit,
    projectRootPath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    dependencies.signal,
  );
  if (!branch) return { kind: "unavailable" };

  const remote = await optionalGit(
    runGit,
    projectRootPath,
    ["config", "--get", `branch.${branch}.remote`],
    dependencies.signal,
  );
  const mergeRef = await optionalGit(
    runGit,
    projectRootPath,
    ["config", "--get", `branch.${branch}.merge`],
    dependencies.signal,
  );
  if (!remote || remote === "." || !mergeRef?.startsWith("refs/heads/")) {
    return { kind: "unavailable" };
  }

  try {
    await dependencies.refreshRepository(projectRootPath, remote, null, null, dependencies.signal);
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return { kind: "unavailable" };
  }
  const remoteRef = `${remote}/${mergeRef.slice("refs/heads/".length)}`;
  const behindByText = await optionalGit(
    runGit,
    workspaceDirectory,
    ["rev-list", "--count", `HEAD..refs/remotes/${remoteRef}`],
    dependencies.signal,
  );
  if (behindByText === null) return { kind: "unavailable" };

  const behindBy = Number.parseInt(behindByText, 10);
  if (!Number.isSafeInteger(behindBy) || behindBy <= 0) {
    return { kind: "current", remoteRef };
  }
  return { kind: "behind", remoteRef, behindBy };
}

export async function refreshSourceBranch(
  projectRootPath: string,
  dependencies: WorkspaceFreshnessDependencies,
): Promise<RpcOutput<typeof refreshSourceBranchContract>> {
  const runGit = dependencies.runGit ?? executeGit;
  const { signal } = dependencies;
  const branch = await optionalGit(
    runGit,
    projectRootPath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    signal,
  );
  if (!branch) return { kind: "unavailable" };
  const remote = await optionalGit(
    runGit,
    projectRootPath,
    ["config", "--get", `branch.${branch}.remote`],
    signal,
  );
  const mergeRef = await optionalGit(
    runGit,
    projectRootPath,
    ["config", "--get", `branch.${branch}.merge`],
    signal,
  );
  if (!remote || remote === "." || !mergeRef?.startsWith("refs/heads/")) {
    return { kind: "unavailable" };
  }
  const headBefore = await optionalGit(runGit, projectRootPath, ["rev-parse", "HEAD"], signal);
  try {
    const result = await dependencies.refreshRepository(
      projectRootPath,
      remote,
      branch,
      `${remote}/${mergeRef.slice("refs/heads/".length)}`,
      signal,
    );
    if (result.kind !== "updated") return { kind: result.kind };
    const headAfter = await optionalGit(runGit, projectRootPath, ["rev-parse", "HEAD"], signal);
    return { kind: headAfter === headBefore ? "unchanged" : "updated" };
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "unavailable" };
  }
}
