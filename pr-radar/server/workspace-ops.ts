import { execFile, spawn } from "node:child_process";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import {
  type LocalDirEntry,
  type listLocalDirs,
  type prepareWorkspaceCwd,
  RoutingScriptResultSchema,
  type runRoutingScript,
} from "../shared/viewer-scope";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function expandUserPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  return exists(join(dir, ".git"));
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

async function runGit(cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
    env: cleanGitEnv(),
  });
  return stdout.trim();
}

async function runGh(args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function repoParts(repository: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repository.split("/");
  return { owner, name };
}

export function slugifyBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function defaultWorktreeName(
  repository: string,
  prNumber: number,
  headRefName: string,
  itemKind: "pr" | "issue" = "pr",
): string {
  const { name } = repoParts(repository);
  const slug = slugifyBranch(headRefName);
  const base = name || "repo";
  const kindPrefix = itemKind === "issue" ? "issue" : "pr";
  return slug ? `${base}-${kindPrefix}-${prNumber}-${slug}` : `${base}-${kindPrefix}-${prNumber}`;
}

export function isAbsoluteOrHomePath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("/");
}

export function isValidRepositorySlug(repository: string): boolean {
  const trimmed = repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return false;
  const [owner, name] = trimmed.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

export function isValidWorktreeName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (trimmed.startsWith(".") || trimmed.startsWith("-")) return false;
  return !/[\\/\0]/.test(trimmed);
}

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!trimmed) return null;
  const scpMatch = trimmed.match(/^[^@/\s]+@([^:/\s]+):([^/\s]+\/[^/\s]+)$/);
  if (scpMatch) {
    if (scpMatch[1].toLowerCase() !== "github.com") return null;
    return scpMatch[2].toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 2) {
      return `${parts[0]}/${parts[1]}`.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

async function findMatchingRemote(dir: string, repository: string): Promise<string | null> {
  if (!repository) return null;
  const target = repository.trim().toLowerCase();
  try {
    const remotesOut = await runGit(dir, ["remote"], 3_000);
    const remotes = remotesOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ordered = [
      ...remotes.filter((name) => name === "upstream"),
      ...remotes.filter((name) => name === "origin"),
      ...remotes.filter((name) => name !== "upstream" && name !== "origin"),
    ];
    for (const remoteName of ordered) {
      const remoteUrl = await runGit(dir, ["remote", "get-url", remoteName], 3_000).catch(() => "");
      if (parseGitHubRepoFromRemote(remoteUrl) === target) {
        return remoteName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function gitRemoteMatches(dir: string, repository: string): Promise<boolean> {
  return Boolean(await findMatchingRemote(dir, repository));
}

async function resolveGitCommonDir(dir: string): Promise<string | null> {
  try {
    return await runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 3_000);
  } catch {
    return null;
  }
}

async function listWorktrees(
  repoDir: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  try {
    const output = await runGit(repoDir, ["worktree", "list", "--porcelain"], 5_000);
    const items: Array<{ path: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        if (currentPath) items.push({ path: currentPath, branch: currentBranch });
        currentPath = line.slice("worktree ".length).trim();
        currentBranch = null;
      } else if (line.startsWith("branch ")) {
        currentBranch = line
          .slice("branch ".length)
          .replace(/^refs\/heads\//, "")
          .trim();
      }
    }
    if (currentPath) items.push({ path: currentPath, branch: currentBranch });
    return items;
  } catch {
    return [];
  }
}

async function resolveSuggestedClonePath(sourceDir: string, repository: string): Promise<string> {
  const { owner, name } = repoParts(repository);
  if (!name) return join(sourceDir, "repo");
  const flatPath = join(sourceDir, name);
  if (!(await exists(flatPath)) || (await gitRemoteMatches(flatPath, repository))) {
    return flatPath;
  }
  return owner ? join(sourceDir, owner, name) : flatPath;
}

export async function listLocalDirsHandler(
  input: z.output<typeof listLocalDirs.input>,
): Promise<z.output<typeof listLocalDirs.output>> {
  const expandedSourceDir = expandUserPath(input.sourceCodeDir);
  const query = input.query.trim().toLowerCase();
  const { name: repoName } = repoParts(input.repository);
  const entries: LocalDirEntry[] = [];
  const seen = new Set<string>();

  if (await exists(expandedSourceDir)) {
    const topItems = await readdir(expandedSourceDir, { withFileTypes: true }).catch(() => []);
    for (const item of topItems) {
      if (!item.isDirectory() || item.name.startsWith(".")) continue;
      const fullPath = join(expandedSourceDir, item.name);
      const isRepo = await isGitRepo(fullPath);
      const isMatch =
        Boolean(input.repository) &&
        (item.name.toLowerCase() === repoName.toLowerCase() ||
          (isRepo && (await gitRemoteMatches(fullPath, input.repository))));

      if (!seen.has(fullPath)) {
        seen.add(fullPath);
        entries.push({
          path: fullPath,
          label: item.name,
          kind: isRepo ? "repo" : "dir",
          branch: null,
          isMatch,
        });
      }

      if (isRepo && (isMatch || !query || item.name.toLowerCase().includes(query))) {
        const worktrees = await listWorktrees(fullPath);
        for (const wt of worktrees) {
          if (seen.has(wt.path)) continue;
          seen.add(wt.path);
          entries.push({
            path: wt.path,
            label: `${item.name} · ${basename(wt.path)}`,
            kind: "worktree",
            branch: wt.branch,
            isMatch,
          });
        }
      } else if (!isRepo) {
        // Scan one level deeper for <owner>/<repo> layouts.
        const subItems = await readdir(fullPath, { withFileTypes: true }).catch(() => []);
        for (const sub of subItems) {
          if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
          const subPath = join(fullPath, sub.name);
          const subIsRepo = await isGitRepo(subPath);
          const subMatch =
            Boolean(input.repository) &&
            (sub.name.toLowerCase() === repoName.toLowerCase() ||
              (subIsRepo && (await gitRemoteMatches(subPath, input.repository))));
          if (!seen.has(subPath)) {
            seen.add(subPath);
            entries.push({
              path: subPath,
              label: `${item.name}/${sub.name}`,
              kind: subIsRepo ? "repo" : "dir",
              branch: null,
              isMatch: subMatch,
            });
          }
        }
      }
    }
  }

  const filtered = entries
    .filter((entry) => {
      if (!query) return true;
      return (
        entry.path.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        (entry.branch?.toLowerCase().includes(query) ?? false)
      );
    })
    .sort((a, b) => {
      if (a.isMatch !== b.isMatch) return a.isMatch ? -1 : 1;
      const rank = { worktree: 0, repo: 1, dir: 2 };
      if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
      return a.label.localeCompare(b.label);
    })
    .slice(0, 40);

  const suggestedClonePath = await resolveSuggestedClonePath(expandedSourceDir, input.repository);
  return { expandedSourceDir, entries: filtered, suggestedClonePath };
}

async function refreshPrWorktree(
  baseRoot: string,
  worktreePath: string,
  matchingRemote: string,
  prNumber: number,
  localBranchName: string,
): Promise<void> {
  const dirty = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error(
      `Existing worktree ${worktreePath} has uncommitted changes; commit or stash them before updating PR #${prNumber}.`,
    );
  }
  await runGit(baseRoot, ["fetch", "--end-of-options", matchingRemote, `pull/${prNumber}/head`]);
  const fetchHead = await runGit(baseRoot, ["rev-parse", "FETCH_HEAD"]);
  await runGit(worktreePath, ["checkout", "-B", localBranchName, fetchHead]);
  const wtHead = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (wtHead !== fetchHead) {
    throw new Error(`Worktree verification failed for PR #${prNumber}.`);
  }
}

export async function prepareWorkspaceCwdHandler(
  input: z.output<typeof prepareWorkspaceCwd.input>,
): Promise<z.output<typeof prepareWorkspaceCwd.output>> {
  if (!isValidRepositorySlug(input.repository)) {
    throw new Error(`Invalid repository name: ${input.repository}`);
  }
  if (input.targetDir && !isAbsoluteOrHomePath(input.targetDir)) {
    throw new Error(`Target directory must be an absolute or ~/ path: ${input.targetDir}`);
  }

  const expandedSourceDir = expandUserPath(input.sourceCodeDir);
  let baseRoot = input.targetDir ? expandUserPath(input.targetDir) : "";
  let cloned = false;

  if (!baseRoot) {
    baseRoot = await resolveSuggestedClonePath(expandedSourceDir, input.repository);
  }

  let matchingRemote = "origin";
  if (!(await exists(baseRoot))) {
    if (!input.allowClone) {
      throw new Error(
        `Directory does not exist: ${baseRoot}. Select "Clone ${input.repository}" to clone it.`,
      );
    }
    await mkdir(dirname(baseRoot), { recursive: true });
    await runGh(["repo", "clone", "--", input.repository, baseRoot], CLONE_TIMEOUT_MS);
    cloned = true;
  } else {
    const info = await stat(baseRoot);
    if (!info.isDirectory()) {
      throw new Error(`Target path is not a directory: ${baseRoot}`);
    }
    if (!(await isGitRepo(baseRoot))) {
      // If a worktree was picked, resolve its main git root if possible, otherwise require a git repo.
      const commonDir = await runGit(baseRoot, ["rev-parse", "--git-common-dir"]).catch(() => "");
      if (!commonDir) {
        throw new Error(`Target directory is not a git repository: ${baseRoot}`);
      }
    }
    const matched = await findMatchingRemote(baseRoot, input.repository);
    if (!matched) {
      throw new Error(
        `Target directory ${baseRoot} does not match repository ${input.repository}.`,
      );
    }
    matchingRemote = matched;
  }

  const localBranchName =
    input.itemKind === "issue"
      ? `pr-radar/issue-${input.prNumber}`
      : `pr-radar/pr-${input.prNumber}`;

  if (input.cwdMode === "CWD-BASE") {
    const dirty = await runGit(baseRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) {
      throw new Error(
        `Base checkout ${baseRoot} has uncommitted changes; commit or stash them, or use CWD-WORKTREE.`,
      );
    }
    if (input.itemKind === "pr") {
      await runGit(baseRoot, [
        "fetch",
        "--end-of-options",
        matchingRemote,
        `pull/${input.prNumber}/head`,
      ]);
      const fetchHead = await runGit(baseRoot, ["rev-parse", "FETCH_HEAD"]);
      await runGit(baseRoot, ["checkout", "-B", localBranchName, fetchHead]);
      const headSha = await runGit(baseRoot, ["rev-parse", "HEAD"]);
      if (headSha !== fetchHead) {
        throw new Error(`Checkout verification failed for PR #${input.prNumber}.`);
      }
    } else {
      await runGit(baseRoot, ["checkout", "-B", localBranchName]);
    }
    return {
      cwd: baseRoot,
      baseRoot,
      cwdTag: "CWD-BASE",
      cloned,
      worktreeCreated: false,
    };
  }

  // CWD-WORKTREE: reuse existing worktree for this PR/issue branch if present (never reuse baseRoot).
  const resolvedBaseRoot = resolve(baseRoot);
  const existingWorktrees = await listWorktrees(baseRoot);
  const existing = existingWorktrees.find(
    (wt) => wt.branch === localBranchName && resolve(wt.path) !== resolvedBaseRoot,
  );
  if (existing) {
    if (input.itemKind === "pr") {
      await refreshPrWorktree(
        baseRoot,
        existing.path,
        matchingRemote,
        input.prNumber,
        localBranchName,
      );
    }
    return {
      cwd: existing.path,
      baseRoot,
      cwdTag: "CWD-WORKTREE",
      cloned,
      worktreeCreated: false,
    };
  }

  const worktreeFolder =
    input.worktreeName?.trim() ||
    defaultWorktreeName(input.repository, input.prNumber, input.headRefName, input.itemKind);
  if (!isValidWorktreeName(worktreeFolder)) {
    throw new Error(`Invalid worktree folder name: ${worktreeFolder}`);
  }
  const worktreePath = join(dirname(baseRoot), worktreeFolder);

  if (await exists(worktreePath)) {
    const [baseCommonDir, wtCommonDir, wtBranch] = await Promise.all([
      resolveGitCommonDir(baseRoot),
      resolveGitCommonDir(worktreePath),
      runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], 3_000).catch(() => ""),
    ]);
    if (!baseCommonDir || wtCommonDir !== baseCommonDir || wtBranch !== localBranchName) {
      throw new Error(
        `Existing folder ${worktreePath} is not a worktree of ${input.repository} on branch ${localBranchName}. Choose a different worktree name.`,
      );
    }
    if (input.itemKind === "pr") {
      await refreshPrWorktree(
        baseRoot,
        worktreePath,
        matchingRemote,
        input.prNumber,
        localBranchName,
      );
    }
    return {
      cwd: worktreePath,
      baseRoot,
      cwdTag: "CWD-WORKTREE",
      cloned,
      worktreeCreated: false,
    };
  }

  if (input.itemKind === "issue") {
    await runGit(baseRoot, ["worktree", "add", "-B", localBranchName, "--", worktreePath, "HEAD"]);
  } else {
    await runGit(baseRoot, [
      "fetch",
      "--end-of-options",
      matchingRemote,
      `pull/${input.prNumber}/head`,
    ]);
    const fetchHead = await runGit(baseRoot, ["rev-parse", "FETCH_HEAD"]);
    await runGit(baseRoot, [
      "worktree",
      "add",
      "-B",
      localBranchName,
      "--",
      worktreePath,
      fetchHead,
    ]);
  }

  return {
    cwd: worktreePath,
    baseRoot,
    cwdTag: "CWD-WORKTREE",
    cloned,
    worktreeCreated: true,
  };
}

export async function runRoutingScriptHandler(
  input: z.output<typeof runRoutingScript.input>,
): Promise<z.output<typeof runRoutingScript.output>> {
  const rawScript = input.scriptPath.trim();
  if (!isAbsoluteOrHomePath(rawScript)) {
    throw new Error(`Routing script path must be an absolute or ~/ path: ${rawScript}`);
  }
  const scriptPath = expandUserPath(rawScript);
  if (!(await exists(scriptPath))) {
    throw new Error(`Routing script not found: ${scriptPath}`);
  }

  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(scriptPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Routing script timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < MAX_BUFFER_BYTES) {
        out += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < MAX_BUFFER_BYTES) {
        err += chunk.toString("utf8");
      }
    });
    child.on("error", (spawnError) => {
      clearTimeout(timer);
      rejectPromise(spawnError);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(err.trim() || `Routing script exited with code ${code}.`));
        return;
      }
      resolvePromise(out.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(input.payload)}\n`);
  });

  if (!stdout) return {};
  const parsed = JSON.parse(stdout) as unknown;
  return RoutingScriptResultSchema.parse(parsed);
}
