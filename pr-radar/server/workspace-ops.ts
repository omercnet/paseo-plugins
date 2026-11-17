import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { z } from "zod";
import type { PrRadarSettings } from "../shared/settings";
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

/** The server-side settings the handlers trust; RPC input never supplies these paths. */
export type WorkspaceOpsSettings = Pick<PrRadarSettings, "sourceCodeDir" | "routingScriptPath">;
export type ReadWorkspaceSettings = () => Promise<WorkspaceOpsSettings>;

export interface RoutingScriptLimits {
  timeoutMs: number;
  outputBytes: number;
  killGraceMs: number;
}

const DEFAULT_ROUTING_LIMITS: RoutingScriptLimits = {
  timeoutMs: COMMAND_TIMEOUT_MS,
  outputBytes: 1024 * 1024,
  killGraceMs: 2_000,
};

// Environment handed to child processes. Everything else in the daemon's environment (API keys,
// cloud credentials, tokens for other tools) stays behind. A routing script gets only what a
// script needs to find its interpreter and locale. gh additionally needs its own credentials and
// config location (GH_TOKEN, GITHUB_TOKEN, GH_HOST, GH_CONFIG_DIR, XDG_CONFIG_HOME), the agent
// socket for ssh remotes, and proxy settings.
const BASE_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
]);
const GH_ENV_KEYS: ReadonlySet<string> = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

// git gets only transport and configuration-location variables. GitHub tokens stay gh-only:
// repository config, credential helpers or transport helpers must not inherit them from the daemon.
const GIT_ENV_KEYS: ReadonlySet<string> = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

function allowListedEnv(extraKeys: ReadonlySet<string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BASE_ENV_KEYS.has(key) || key.startsWith("LC_") || extraKeys.has(key)) env[key] = value;
  }
  return env;
}

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

// Hooks and transport helpers can come from repository config, and a checked-out PR is untrusted:
// every git call switches off hooks/fsmonitor and neutralizes command-running config that can spawn
// helper processes during fetch, checkout, diff/status or credential lookup.
const GIT_SAFETY_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=ssh -oBatchMode=yes",
  "-c",
  "core.askPass=/bin/false",
  "-c",
  "credential.helper=",
  "-c",
  "credential.https://github.com.helper=!gh auth git-credential",
  "-c",
  "core.gitProxy=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...allowListedEnv(GIT_ENV_KEYS),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file:ssh:https:http",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function configuredFilterSafetyArgs(cwd: string): Promise<string[]> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "git",
      [...GIT_SAFETY_ARGS, "-C", cwd, "config", "--name-only", "--get-regexp", "^filter\\."],
      { timeout: 3_000, maxBuffer: MAX_BUFFER_BYTES, env: gitEnv() },
    );
    stdout = result.stdout;
  } catch (err) {
    // `git config --get-regexp` exits 1 when nothing matches; only that counts as "no filters".
    // A timeout, buffer overflow or other failure must fail closed, not let repo filters run.
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== 1) {
      throw new Error(
        `Could not enumerate repository filter configuration in ${cwd}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const args: string[] = [];
  for (const rawKey of stdout.split("\n")) {
    const key = rawKey.trim();
    if (!/^filter\..+\.(clean|smudge|process|required)$/.test(key)) continue;
    args.push("-c", key.endsWith(".required") ? `${key}=false` : `${key}=`);
  }
  return args;
}

async function runGit(cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const filterArgs = await configuredFilterSafetyArgs(cwd);
  const { stdout } = await execFileAsync(
    "git",
    [...GIT_SAFETY_ARGS, ...filterArgs, "-C", cwd, ...args],
    {
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
      env: gitEnv(),
    },
  );
  return stdout.trim();
}

/** The environment gh runs with; the viewer queries use it too. */
export function ghEnv(): NodeJS.ProcessEnv {
  return { ...allowListedEnv(GH_ENV_KEYS), GIT_TERMINAL_PROMPT: "0" };
}

async function cloneGitHubRepo(repository: string, targetDir: string): Promise<void> {
  const cloneUrl = `https://github.com/${repository}.git`;
  await runGit(
    dirname(targetDir),
    ["clone", "--no-checkout", "--", cloneUrl, targetDir],
    CLONE_TIMEOUT_MS,
  );
  await runGit(targetDir, ["checkout", "--force"], CLONE_TIMEOUT_MS);
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** realpath of the nearest existing ancestor plus the not-yet-existing remainder. */
async function realpathLoose(target: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function assertInsideSourceDir(
  realSourceDir: string,
  target: string,
  label: string,
): Promise<void> {
  if (!isInside(realSourceDir, await realpathLoose(target))) {
    throw new Error(`${label} ${target} is outside the configured source directory.`);
  }
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
  return [owner, name].every((part) => part !== "." && part !== ".." && !part.startsWith("-"));
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
  readSettings: ReadWorkspaceSettings,
): Promise<z.output<typeof listLocalDirs.output>> {
  const settings = await readSettings();
  const expandedSourceDir = expandUserPath(settings.sourceCodeDir);
  const realSourceDir = await realpathLoose(expandedSourceDir);
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
          if (!isInside(realSourceDir, await realpathLoose(wt.path))) continue;
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

function prRef(prNumber: number): string {
  return `refs/pr-radar/pull/${prNumber}`;
}

/**
 * Fetches the PR head into a dedicated ref and resolves that ref, never FETCH_HEAD, which a
 * concurrent fetch in the same checkout can overwrite between the fetch and the lookup.
 */
async function fetchPrHead(baseRoot: string, remote: string, prNumber: number): Promise<string> {
  const ref = prRef(prNumber);
  await runGit(baseRoot, ["fetch", "--end-of-options", remote, `+pull/${prNumber}/head:${ref}`]);
  return runGit(baseRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await runGit(
      repoDir,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      3_000,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resetting an existing branch to `target` is only safe when it moves forward: commits that are
 * not contained in the target would otherwise fall off the branch.
 */
async function assertBranchFastForwards(
  repoDir: string,
  branch: string,
  target: string,
  targetLabel: string,
): Promise<void> {
  if (!(await branchExists(repoDir, branch))) return;
  try {
    await runGit(repoDir, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, target], 3_000);
  } catch {
    throw new Error(
      `Branch ${branch} has local commits that are not in ${targetLabel}, so it was left unchanged. Push or rename the branch, or delete it, then try again.`,
    );
  }
}

/**
 * `checkout -B` replaces a git-ignored local file (a `.env`, say) without a word when the PR tracks
 * the same path, and the dirty check does not see ignored files. Refuse before that happens.
 */
async function assertNoIgnoredFileOverwrite(
  dir: string,
  target: string,
  prNumber: number,
): Promise<void> {
  const ignored = (
    await runGit(dir, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (ignored.length === 0) return;
  const incoming = (
    await runGit(dir, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      target,
      "--",
      ...ignored.map((path) => `:(literal)${path}`),
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (incoming.length > 0) {
    throw new Error(
      `PR #${prNumber} tracks ${incoming[0]}, which would overwrite an ignored local file in ${dir}; move that file aside, or use CWD-WORKTREE.`,
    );
  }
}

async function currentBranch(repoDir: string): Promise<string | null> {
  const name = await runGit(repoDir, ["branch", "--show-current"], 3_000).catch(() => "");
  return name || null;
}

/**
 * New issue branches start from the remote default branch. Without a recorded remote default the
 * current HEAD is used, but only when a remote-tracking branch already contains it: a PR branch, a
 * detached PR checkout or a local-only commit would carry unmerged, possibly untrusted code.
 */
async function resolveIssueStartPoint(baseRoot: string, remote: string): Promise<string> {
  const remoteHead = await runGit(
    baseRoot,
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
    3_000,
  ).catch(() => "");
  if (remoteHead) {
    const resolved = await runGit(
      baseRoot,
      ["rev-parse", "--verify", "--quiet", `${remoteHead}^{commit}`],
      3_000,
    ).catch(() => "");
    if (resolved) return resolved;
  }
  const branch = await currentBranch(baseRoot);
  if (branch?.startsWith("pr-radar/")) {
    throw new Error(
      `Base checkout ${baseRoot} is on ${branch} and has no recorded default branch for ${remote}; check out the default branch there, or use another directory.`,
    );
  }
  const published = await runGit(
    baseRoot,
    [
      "for-each-ref",
      "--count=1",
      "--contains",
      "HEAD",
      "--format=%(refname)",
      `refs/remotes/${remote}`,
    ],
    3_000,
  ).catch(() => "");
  if (!published) {
    throw new Error(
      `Base checkout ${baseRoot} has no recorded default branch for ${remote} and its HEAD is not on any ${remote} branch, so it may carry unmerged code; run git remote set-head ${remote} --auto there, or check out the default branch.`,
    );
  }
  return runGit(baseRoot, ["rev-parse", "HEAD"], 3_000);
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
  const prHead = await fetchPrHead(baseRoot, matchingRemote, prNumber);
  await assertBranchFastForwards(baseRoot, localBranchName, prHead, `the head of PR #${prNumber}`);
  await assertNoIgnoredFileOverwrite(worktreePath, prHead, prNumber);
  await runGit(worktreePath, ["checkout", "-B", localBranchName, prHead]);
  const wtHead = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (wtHead !== prHead) {
    throw new Error(`Worktree verification failed for PR #${prNumber}.`);
  }
}

export async function prepareWorkspaceCwdHandler(
  input: z.output<typeof prepareWorkspaceCwd.input>,
  readSettings: ReadWorkspaceSettings,
): Promise<z.output<typeof prepareWorkspaceCwd.output>> {
  if (!isValidRepositorySlug(input.repository)) {
    throw new Error(`Invalid repository name: ${input.repository}`);
  }
  if (input.targetDir && !isAbsoluteOrHomePath(input.targetDir)) {
    throw new Error(`Target directory must be an absolute or ~/ path: ${input.targetDir}`);
  }

  const settings = await readSettings();
  const expandedSourceDir = expandUserPath(settings.sourceCodeDir);
  const realSourceDir = await realpathLoose(expandedSourceDir);
  let baseRoot = input.targetDir ? expandUserPath(input.targetDir) : "";
  if (input.targetDir) {
    await assertInsideSourceDir(realSourceDir, baseRoot, "Target directory");
  }
  let cloned = false;

  if (!baseRoot) {
    baseRoot = await resolveSuggestedClonePath(expandedSourceDir, input.repository);
    // A symlink in the source directory can point at a checkout elsewhere.
    await assertInsideSourceDir(realSourceDir, baseRoot, "Base checkout");
  }

  let matchingRemote = "origin";
  if (!(await exists(baseRoot))) {
    if (!input.allowClone) {
      throw new Error(
        `Directory does not exist: ${baseRoot}. Select "Clone ${input.repository}" to clone it.`,
      );
    }
    await mkdir(dirname(baseRoot), { recursive: true });
    await cloneGitHubRepo(input.repository, baseRoot);
    cloned = true;
  } else {
    const info = await stat(baseRoot);
    if (!info.isDirectory()) {
      throw new Error(`Target path is not a directory: ${baseRoot}`);
    }
    if (!(await isGitRepo(baseRoot))) {
      // If a worktree subdirectory was picked, let git discovery find it, otherwise require a git repo.
      const commonDir = await runGit(baseRoot, ["rev-parse", "--git-common-dir"]).catch(() => "");
      if (!commonDir) {
        throw new Error(`Target directory is not a git repository: ${baseRoot}`);
      }
    }
    const worktreeRoot = await runGit(baseRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ]).catch(() => "");
    if (!worktreeRoot) {
      throw new Error(`Target directory is not a git worktree: ${baseRoot}`);
    }
    baseRoot = worktreeRoot;
    await assertInsideSourceDir(realSourceDir, baseRoot, "Git worktree root");
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
    const branchBeforeSwitch = await currentBranch(baseRoot);
    if (!branchBeforeSwitch) {
      throw new Error(
        `Base checkout ${baseRoot} is in detached HEAD; check out a branch or use CWD-WORKTREE.`,
      );
    }
    const dirty = await runGit(baseRoot, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) {
      throw new Error(
        `Base checkout ${baseRoot} has uncommitted or untracked changes; commit, stash or remove them, or use CWD-WORKTREE.`,
      );
    }
    const warning = `CWD-BASE will switch ${baseRoot} from ${branchBeforeSwitch} to ${localBranchName}.`;
    if (input.itemKind === "pr") {
      const prHead = await fetchPrHead(baseRoot, matchingRemote, input.prNumber);
      await assertBranchFastForwards(
        baseRoot,
        localBranchName,
        prHead,
        `the head of PR #${input.prNumber}`,
      );
      await assertNoIgnoredFileOverwrite(baseRoot, prHead, input.prNumber);
      await runGit(baseRoot, ["checkout", "-B", localBranchName, prHead]);
      const headSha = await runGit(baseRoot, ["rev-parse", "HEAD"]);
      if (headSha !== prHead) {
        throw new Error(`Checkout verification failed for PR #${input.prNumber}.`);
      }
    } else if (await branchExists(baseRoot, localBranchName)) {
      await runGit(baseRoot, ["checkout", localBranchName]);
    } else {
      const startPoint = await resolveIssueStartPoint(baseRoot, matchingRemote);
      await runGit(baseRoot, ["checkout", "-b", localBranchName, startPoint]);
    }
    return {
      cwd: baseRoot,
      baseRoot,
      cwdTag: "CWD-BASE",
      cloned,
      worktreeCreated: false,
      warning,
    };
  }

  // CWD-WORKTREE: reuse existing worktree for this PR/issue branch if present (never reuse baseRoot).
  const resolvedBaseRoot = resolve(baseRoot);
  const existingWorktrees = await listWorktrees(baseRoot);
  const existing = existingWorktrees.find(
    (wt) => wt.branch === localBranchName && resolve(wt.path) !== resolvedBaseRoot,
  );
  if (existing) {
    // `git worktree list` can name a worktree anywhere on disk.
    await assertInsideSourceDir(realSourceDir, existing.path, "Existing worktree");
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
  await assertInsideSourceDir(realSourceDir, worktreePath, "Worktree folder");

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
    if (await branchExists(baseRoot, localBranchName)) {
      await runGit(baseRoot, [
        "worktree",
        "add",
        "--no-checkout",
        "--",
        worktreePath,
        localBranchName,
      ]);
    } else {
      const startPoint = await resolveIssueStartPoint(baseRoot, matchingRemote);
      await runGit(baseRoot, [
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        localBranchName,
        "--",
        worktreePath,
        startPoint,
      ]);
    }
    await runGit(worktreePath, ["checkout", "--force"], CLONE_TIMEOUT_MS);
  } else {
    const prHead = await fetchPrHead(baseRoot, matchingRemote, input.prNumber);
    await assertBranchFastForwards(
      baseRoot,
      localBranchName,
      prHead,
      `the head of PR #${input.prNumber}`,
    );
    await runGit(baseRoot, [
      "worktree",
      "add",
      "--no-checkout",
      "-B",
      localBranchName,
      "--",
      worktreePath,
      prHead,
    ]);
    await runGit(worktreePath, ["checkout", "--force"], CLONE_TIMEOUT_MS);
  }

  return {
    cwd: worktreePath,
    baseRoot,
    cwdTag: "CWD-WORKTREE",
    cloned,
    worktreeCreated: true,
  };
}

const STICKY_BIT = 0o1000;

/**
 * Resolves the configured script to a real path and refuses anything but a regular, executable
 * file that only this user (or root) can modify: the file must be owned by the user or root, and so
 * must every directory above it, none of them writable by group or others unless sticky (like
 * /tmp). Otherwise another local user could create the script or swap a path component for their
 * own, and it would run as this user. `uid` is a parameter so tests can stand in for another user.
 */
export async function resolveRoutingScript(
  rawPath: string,
  uid: number | undefined = process.getuid?.(),
): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("No routing script is configured in the PR Radar settings.");
  }
  if (!isAbsoluteOrHomePath(trimmed)) {
    throw new Error(`Routing script path must be an absolute or ~/ path: ${trimmed}`);
  }
  const expanded = expandUserPath(trimmed);
  if (!(await exists(expanded))) {
    throw new Error(`Routing script not found: ${expanded}`);
  }
  const scriptPath = await realpath(expanded);
  const info = await stat(scriptPath);
  if (!info.isFile()) {
    throw new Error(`Routing script is not a regular file: ${scriptPath}`);
  }
  const trustedOwner = (owner: number) => uid === undefined || owner === uid || owner === 0;
  if (!trustedOwner(info.uid)) {
    throw new Error(
      `Routing script ${scriptPath} is owned by another user; run chown on it, or use a script you own.`,
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(
      `Routing script ${scriptPath} must not be writable by group or others; run chmod go-w on it.`,
    );
  }
  for (let dir = dirname(scriptPath); ; dir = dirname(dir)) {
    const dirInfo = await stat(dir);
    if (!trustedOwner(dirInfo.uid)) {
      throw new Error(
        `Routing script directory ${dir} is owned by another user; move the script somewhere you own, or run chown on it.`,
      );
    }
    if ((dirInfo.mode & 0o022) !== 0 && (dirInfo.mode & STICKY_BIT) === 0) {
      throw new Error(
        `Routing script directory ${dir} must not be writable by group or others; run chmod go-w on it.`,
      );
    }
    if (dirname(dir) === dir) break;
  }
  try {
    await access(scriptPath, constants.X_OK);
  } catch {
    throw new Error(`Routing script is not executable: ${scriptPath}`);
  }
  return scriptPath;
}

interface ScriptRun {
  /** Settles with the script's stdout, or rejects on failure, timeout or the output cap. */
  result: Promise<string>;
  /** Resolves once the script's process group has exited or has been sent SIGKILL. */
  finished: Promise<void>;
}

function startScriptCapped(
  scriptPath: string,
  payload: unknown,
  limits: RoutingScriptLimits,
): ScriptRun {
  const finishedGate = Promise.withResolvers<void>();
  const result = new Promise<string>((resolvePromise, rejectPromise) => {
    // Its own process group, so a timeout reaches the script's descendants too.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(scriptPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: allowListedEnv(new Set()),
        detached: true,
      });
    } catch (spawnError) {
      finishedGate.resolve();
      rejectPromise(spawnError);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;

    function signalGroup(signal: NodeJS.Signals): void {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    }
    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A surviving descendant could otherwise keep feeding buffers nobody reads any more.
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }
    function terminate(): void {
      if (terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finishedGate.resolve();
      }, limits.killGraceMs);
    }
    function overCap(): void {
      terminate();
      settle(() =>
        rejectPromise(new Error(`Routing script output exceeded ${limits.outputBytes} bytes.`)),
      );
    }

    const timer = setTimeout(() => {
      terminate();
      settle(() =>
        rejectPromise(new Error(`Routing script timed out after ${limits.timeoutMs}ms.`)),
      );
    }, limits.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outBytes += chunk.length;
      if (outBytes > limits.outputBytes) return overCap();
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      errBytes += chunk.length;
      if (errBytes > limits.outputBytes) return overCap();
      err.push(chunk);
    });
    child.on("error", (spawnError) => {
      settle(() => rejectPromise(spawnError));
      finishedGate.resolve();
    });
    child.on("close", (code) => {
      // Having asked it to stop, make sure no descendant outlives the script.
      if (terminating) signalGroup("SIGKILL");
      clearTimeout(killTimer);
      finishedGate.resolve();
      settle(() => {
        if (code !== 0) {
          const message = Buffer.concat(err).toString("utf8").trim();
          rejectPromise(new Error(message || `Routing script exited with code ${code}.`));
          return;
        }
        resolvePromise(Buffer.concat(out).toString("utf8").trim());
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
  return { result, finished: finishedGate.promise };
}

let routingScriptRunning = false;
let routingScriptFinished: Promise<void> | null = null;

export async function waitForRoutingScriptIdleForTests(): Promise<void> {
  await routingScriptFinished;
}

export async function runRoutingScriptHandler(
  input: z.output<typeof runRoutingScript.input>,
  readSettings: ReadWorkspaceSettings,
  limits: RoutingScriptLimits = DEFAULT_ROUTING_LIMITS,
): Promise<z.output<typeof runRoutingScript.output>> {
  if (process.platform === "win32") {
    throw new Error("Routing scripts are not supported on Windows.");
  }
  const settings = await readSettings();
  const scriptPath = await resolveRoutingScript(settings.routingScriptPath);
  if (routingScriptRunning) {
    throw new Error("A routing script is already running; try again when it has finished.");
  }
  routingScriptRunning = true;
  // The guard is held until the script's process group is gone or has been sent SIGKILL, which can
  // be after the call itself has failed on a timeout.
  const run = startScriptCapped(scriptPath, input.payload, limits);
  routingScriptFinished = run.finished.then(() => {
    routingScriptRunning = false;
    routingScriptFinished = null;
  });
  void routingScriptFinished;
  const stdout = await run.result;

  if (!stdout) return {};
  const parsed = JSON.parse(stdout) as unknown;
  return RoutingScriptResultSchema.parse(parsed);
}
