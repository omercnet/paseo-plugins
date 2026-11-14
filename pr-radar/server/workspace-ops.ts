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

async function runGit(cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

async function gitRemoteMatches(dir: string, repository: string): Promise<boolean> {
  if (!repository) return false;
  try {
    const remote = await runGit(dir, ["remote", "get-url", "origin"], 3_000);
    return remote.toLowerCase().includes(repository.toLowerCase());
  } catch {
    return false;
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

export async function prepareWorkspaceCwdHandler(
  input: z.output<typeof prepareWorkspaceCwd.input>,
): Promise<z.output<typeof prepareWorkspaceCwd.output>> {
  const expandedSourceDir = expandUserPath(input.sourceCodeDir);
  let baseRoot = input.targetDir ? expandUserPath(input.targetDir) : "";
  let cloned = false;

  if (!baseRoot) {
    baseRoot = await resolveSuggestedClonePath(expandedSourceDir, input.repository);
  }

  if (!(await exists(baseRoot))) {
    await mkdir(dirname(baseRoot), { recursive: true });
    await runGh(["repo", "clone", input.repository, baseRoot], CLONE_TIMEOUT_MS);
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
  }

  if (input.cwdMode === "CWD-BASE") {
    if (input.itemKind === "pr") {
      const branchName = input.headRefName || `pr-${input.prNumber}`;
      await runGit(baseRoot, [
        "fetch",
        "origin",
        `pull/${input.prNumber}/head:${branchName}`,
      ]).catch(() => runGit(baseRoot, ["fetch", "origin", `pull/${input.prNumber}/head`]));
      const currentBranch = await runGit(baseRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(
        () => "",
      );
      if (currentBranch !== branchName) {
        await runGit(baseRoot, ["checkout", branchName]).catch(() => undefined);
      }
    }
    return {
      cwd: baseRoot,
      baseRoot,
      cwdTag: "CWD-BASE",
      cloned,
      worktreeCreated: false,
    };
  }

  // CWD-WORKTREE: reuse existing worktree for this PR/issue branch if present.
  const existingWorktrees = await listWorktrees(baseRoot);
  const branchName =
    input.itemKind === "issue"
      ? `issue-${input.prNumber}${slugifyBranch(input.headRefName) ? `-${slugifyBranch(input.headRefName)}` : ""}`
      : input.headRefName || `pr-${input.prNumber}`;

  if (branchName) {
    const existing = existingWorktrees.find((wt) => wt.branch === branchName);
    if (existing) {
      return {
        cwd: existing.path,
        baseRoot,
        cwdTag: "CWD-WORKTREE",
        cloned,
        worktreeCreated: false,
      };
    }
  }

  const worktreeFolder =
    input.worktreeName?.trim() ||
    defaultWorktreeName(input.repository, input.prNumber, input.headRefName, input.itemKind);
  const worktreePath = join(dirname(baseRoot), worktreeFolder);

  if (await exists(worktreePath)) {
    return {
      cwd: worktreePath,
      baseRoot,
      cwdTag: "CWD-WORKTREE",
      cloned,
      worktreeCreated: false,
    };
  }

  if (input.itemKind === "issue") {
    try {
      await runGit(baseRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    } catch {
      await runGit(baseRoot, ["worktree", "add", worktreePath, branchName]);
    }
  } else {
    await runGit(baseRoot, ["fetch", "origin", `pull/${input.prNumber}/head:${branchName}`]).catch(
      async () => {
        await runGit(baseRoot, ["fetch", "origin", `pull/${input.prNumber}/head`]);
      },
    );

    try {
      await runGit(baseRoot, ["worktree", "add", worktreePath, branchName]);
    } catch {
      await runGit(baseRoot, ["worktree", "add", "--detach", worktreePath, "FETCH_HEAD"]);
    }
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
  const scriptPath = expandUserPath(input.scriptPath);
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
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
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
    child.stdin.end(`${JSON.stringify(input.payload)}\n`);
  });

  if (!stdout) return {};
  const parsed = JSON.parse(stdout) as unknown;
  return RoutingScriptResultSchema.parse(parsed);
}
