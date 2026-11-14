import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  listLocalDirsHandler,
  prepareWorkspaceCwdHandler,
  type RoutingScriptLimits,
  runRoutingScriptHandler,
} from "../server/workspace-ops";
import { listLocalDirs, prepareWorkspaceCwd, runRoutingScript } from "../shared/viewer-scope";

const tempDirs: string[] = [];

// The handlers read the source directory and routing script from server-side settings. A test's
// first makeRoot() directory becomes the source directory.
const NO_SOURCE_DIR = "/nonexistent-source-dir";
let sourceDir = NO_SOURCE_DIR;
let routingScript = "";

const readSettings = async () => ({ sourceCodeDir: sourceDir, routingScriptPath: routingScript });
const prepare = (input: Parameters<typeof prepareWorkspaceCwdHandler>[0]) =>
  prepareWorkspaceCwdHandler(input, readSettings);
const listDirs = (input: Parameters<typeof listLocalDirsHandler>[0]) =>
  listLocalDirsHandler(input, readSettings);

// Hermetic git: no global or system config (url rewrites, commit signing, credential helpers), only
// the file and ssh transports (so nothing can reach the network over https), and no repository
// discovery above the temp root.
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file:ssh");
  vi.stubEnv("GIT_CEILING_DIRECTORIES", realpathSync(tmpdir()));
  vi.stubEnv("GIT_OBJECT_DIRECTORY", undefined);
  vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", undefined);
  sourceDir = NO_SOURCE_DIR;
  routingScript = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-handlers-")));
  tempDirs.push(root);
  if (sourceDir === NO_SOURCE_DIR) sourceDir = root;
  return root;
}

function gitIn(dir: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env })
    .toString()
    .trim();
}

function initRepo(dir: string, remoteUrl: string | null): void {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-b", "main"]);
  gitIn(dir, ["config", "user.email", "test@example.com"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  gitIn(dir, ["add", "README.md"]);
  gitIn(dir, ["commit", "-m", "init"]);
  if (remoteUrl) gitIn(dir, ["remote", "add", "origin", remoteUrl]);
}

/**
 * A checkout whose `origin` is `git@github.com:owner/repo.git` (so the repository match works).
 * `git remote get-url` expands `insteadOf` rewrites, so fetches are served instead by a fake ssh
 * (GIT_SSH_COMMAND) that runs upload-pack on a local bare repository carrying `refs/pull/7/head`.
 */
function makePullableRepo(root: string): { repoDir: string; bareDir: string; prHead: string } {
  const repoDir = join(root, "repo");
  const bareDir = join(root, "bare.git");
  initRepo(repoDir, "git@github.com:owner/repo.git");
  mkdirSync(bareDir, { recursive: true });
  gitIn(bareDir, ["init", "--bare", "-b", "main"]);
  const fakeSsh = join(root, "fake-ssh");
  writeFileSync(fakeSsh, '#!/bin/sh\nexec git upload-pack "$FAKE_BARE_REPO"\n');
  chmodSync(fakeSsh, 0o755);
  vi.stubEnv("GIT_SSH_COMMAND", fakeSsh);
  vi.stubEnv("FAKE_BARE_REPO", bareDir);
  writeFileSync(join(repoDir, "pr.txt"), "pr one\n");
  gitIn(repoDir, ["add", "pr.txt"]);
  gitIn(repoDir, ["commit", "-m", "pr head"]);
  const prHead = gitIn(repoDir, ["rev-parse", "HEAD"]);
  gitIn(repoDir, ["push", bareDir, "HEAD:refs/pull/7/head"]);
  gitIn(repoDir, ["reset", "--hard", "HEAD~1"]);
  return { repoDir, bareDir, prHead };
}

type PrepareInput = Parameters<typeof prepareWorkspaceCwdHandler>[0];

function request(overrides: Partial<PrepareInput>): PrepareInput {
  return {
    itemKind: "pr",
    repository: "owner/repo",
    prNumber: 7,
    headRefName: "feat/x",
    baseRefName: "main",
    targetDir: null,
    allowClone: false,
    cwdMode: "CWD-WORKTREE",
    worktreeName: null,
    ...overrides,
  };
}

describe("prepareWorkspaceCwdHandler validation", () => {
  test("rejects an invalid repository slug before touching the disk", async () => {
    await expect(prepare(request({ repository: "bad/../repo" }))).rejects.toThrow(
      "Invalid repository name: bad/../repo",
    );
  });

  test("rejects a relative target directory", async () => {
    await expect(prepare(request({ targetDir: "relative/dir" }))).rejects.toThrow(
      "Target directory must be an absolute or ~/ path: relative/dir",
    );
  });

  test("rejects a target that is a file", async () => {
    const root = makeRoot();
    const file = join(root, "afile");
    writeFileSync(file, "x");
    await expect(prepare(request({ targetDir: file }))).rejects.toThrow(
      `Target path is not a directory: ${file}`,
    );
  });

  test("rejects a directory that is not a git repository", async () => {
    const root = makeRoot();
    const dir = join(root, "plain");
    mkdirSync(dir);
    await expect(prepare(request({ targetDir: dir }))).rejects.toThrow(
      `Target directory is not a git repository: ${dir}`,
    );
  });

  test("rejects an invalid worktree folder name", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    await expect(
      prepare(request({ targetDir: repoDir, worktreeName: "../escape" })),
    ).rejects.toThrow("Invalid worktree folder name: ../escape");
  });

  test("derives the base checkout from the source directory when no target is given", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const result = await prepare(
      request({
        itemKind: "issue",
        prNumber: 12,
        cwdMode: "CWD-BASE",
      }),
    );
    expect(result).toEqual({
      cwd: repoDir,
      baseRoot: repoDir,
      cwdTag: "CWD-BASE",
      cloned: false,
      worktreeCreated: false,
    });
  });
});

describe("prepareWorkspaceCwdHandler CWD-BASE", () => {
  test("checks out the fetched PR head on a pr-radar branch", async () => {
    const root = makeRoot();
    const { repoDir, prHead } = makePullableRepo(root);
    const result = await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(result).toEqual({
      cwd: repoDir,
      baseRoot: repoDir,
      cwdTag: "CWD-BASE",
      cloned: false,
      worktreeCreated: false,
    });
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(gitIn(repoDir, ["rev-parse", "HEAD"])).toBe(prHead);
  });

  test("creates an issue branch from the current HEAD without fetching", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const head = gitIn(repoDir, ["rev-parse", "HEAD"]);
    await prepare(
      request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/issue-12");
    expect(gitIn(repoDir, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("clones through gh when allowed and the directory is missing", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    initRepo(source, null);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const ghLog = join(root, "gh-args.txt");
    // gh repo clone -- OWNER/REPO TARGET
    const ghScript = join(binDir, "gh");
    writeFileSync(
      ghScript,
      [
        "#!/bin/sh",
        '[ "$1 $2 $3" = "repo clone --" ] || exit 9',
        "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1",
        `echo "$*" > "${ghLog}"`,
        `git clone -q "${source}" "$5" || exit 8`,
        'git -C "$5" remote set-url origin "https://github.com/$4.git"',
        "",
      ].join("\n"),
    );
    chmodSync(ghScript, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

    const target = join(root, "nested", "clone");
    const result = await prepare(
      request({
        itemKind: "issue",
        prNumber: 3,
        targetDir: target,
        allowClone: true,
        cwdMode: "CWD-BASE",
      }),
    );
    // The fake gh ran with exactly these arguments (a real gh would not write the log).
    expect(readFileSync(ghLog, "utf8").trim()).toBe(`repo clone -- owner/repo ${target}`);
    expect(result.cloned).toBe(true);
    expect(result.cwd).toBe(target);
    expect(gitIn(target, ["rev-parse", "HEAD"])).toBe(gitIn(source, ["rev-parse", "HEAD"]));
    expect(gitIn(target, ["branch", "--show-current"])).toBe("pr-radar/issue-3");
  });
});

describe("gh environment", () => {
  test("hands gh its credentials but not the rest of the environment", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    initRepo(source, null);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const envLog = join(root, "gh-env.txt");
    const ghScript = join(binDir, "gh");
    writeFileSync(
      ghScript,
      [
        "#!/bin/sh",
        "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1",
        `env > "${envLog}"`,
        `git clone -q "${source}" "$5" || exit 8`,
        'git -C "$5" remote set-url origin "https://github.com/$4.git"',
        "",
      ].join("\n"),
    );
    chmodSync(ghScript, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("GH_TOKEN", "gh-token-value");
    vi.stubEnv("PR_RADAR_TEST_SECRET", "leak-me");
    await prepare(
      request({
        itemKind: "issue",
        prNumber: 3,
        targetDir: join(root, "clone"),
        allowClone: true,
        cwdMode: "CWD-BASE",
      }),
    );
    const seen = readFileSync(envLog, "utf8");
    expect(seen).toContain("GH_TOKEN=gh-token-value");
    expect(seen).not.toContain("PR_RADAR_TEST_SECRET");
  });
});

describe("prepareWorkspaceCwdHandler CWD-WORKTREE", () => {
  test("creates, reuses and refreshes a PR worktree", async () => {
    const root = makeRoot();
    const { repoDir, bareDir, prHead } = makePullableRepo(root);
    const worktreePath = join(root, "repo-pr-7-feat-x");

    const created = await prepare(request({ targetDir: repoDir }));
    expect(created).toEqual({
      cwd: worktreePath,
      baseRoot: repoDir,
      cwdTag: "CWD-WORKTREE",
      cloned: false,
      worktreeCreated: true,
    });
    expect(gitIn(worktreePath, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(gitIn(worktreePath, ["rev-parse", "HEAD"])).toBe(prHead);

    // The PR gets a new commit upstream: the next call reuses the worktree and fast-forwards it.
    writeFileSync(join(worktreePath, "scratch.txt"), "untracked files do not block a refresh\n");
    writeFileSync(join(worktreePath, "pr2.txt"), "pr two\n");
    gitIn(worktreePath, ["add", "pr2.txt"]);
    gitIn(worktreePath, ["commit", "-m", "pr head 2"]);
    const newHead = gitIn(worktreePath, ["rev-parse", "HEAD"]);
    gitIn(worktreePath, ["push", bareDir, "HEAD:refs/pull/7/head"]);
    gitIn(worktreePath, ["reset", "--hard", prHead]);
    expect(newHead).not.toBe(prHead);

    const reused = await prepare(request({ targetDir: repoDir }));
    expect(reused).toEqual({
      cwd: worktreePath,
      baseRoot: repoDir,
      cwdTag: "CWD-WORKTREE",
      cloned: false,
      worktreeCreated: false,
    });
    expect(gitIn(worktreePath, ["rev-parse", "HEAD"])).toBe(newHead);
  });

  test("refuses to refresh a PR worktree with uncommitted tracked changes", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const worktreePath = join(root, "repo-pr-7-feat-x");
    await prepare(request({ targetDir: repoDir }));
    writeFileSync(join(worktreePath, "pr.txt"), "dirty\n");
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      `Existing worktree ${worktreePath} has uncommitted changes; commit or stash them before updating PR #7.`,
    );
  });

  test("refuses a same-repository worktree on another branch at the default folder", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const folder = join(root, "repo-pr-7-feat-x");
    gitIn(repoDir, ["worktree", "add", "-b", "other-task", folder]);
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      `Existing folder ${folder} is not a worktree of owner/repo on branch pr-radar/pr-7.`,
    );
    // The other task's worktree was neither switched nor fetched into.
    expect(gitIn(folder, ["branch", "--show-current"])).toBe("other-task");
  });

  test("refuses another repository's checkout that sits on the expected branch", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const stranger = join(root, "repo-issue-12-feat-x");
    initRepo(stranger, "https://github.com/someone/else.git");
    gitIn(stranger, ["checkout", "-b", "pr-radar/issue-12"]);
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir })),
    ).rejects.toThrow(
      `Existing folder ${stranger} is not a worktree of owner/repo on branch pr-radar/issue-12.`,
    );
  });

  test("honours a custom worktree name and creates an issue worktree from HEAD", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const head = gitIn(repoDir, ["rev-parse", "HEAD"]);
    const issueInput = request({
      itemKind: "issue",
      prNumber: 12,
      targetDir: repoDir,
      worktreeName: "my-issue-tree",
    });
    const created = await prepare(issueInput);
    const worktreePath = join(root, "my-issue-tree");
    expect(created).toEqual({
      cwd: worktreePath,
      baseRoot: repoDir,
      cwdTag: "CWD-WORKTREE",
      cloned: false,
      worktreeCreated: true,
    });
    expect(gitIn(worktreePath, ["branch", "--show-current"])).toBe("pr-radar/issue-12");
    expect(gitIn(worktreePath, ["rev-parse", "HEAD"])).toBe(head);

    // Issues never fetch: the second call just reuses the worktree.
    const reused = await prepare(issueInput);
    expect(reused.cwd).toBe(worktreePath);
    expect(reused.worktreeCreated).toBe(false);
  });
});

describe("prepareWorkspaceCwdHandler branch safety", () => {
  function commitFile(dir: string, name: string): string {
    writeFileSync(join(dir, name), `${name}\n`);
    gitIn(dir, ["add", name]);
    gitIn(dir, ["commit", "-m", `add ${name}`]);
    return gitIn(dir, ["rev-parse", "HEAD"]);
  }

  test("fetches the PR head into a dedicated ref instead of relying on FETCH_HEAD", async () => {
    const root = makeRoot();
    const { repoDir, prHead } = makePullableRepo(root);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["rev-parse", "refs/pr-radar/pull/7"])).toBe(prHead);
  });

  test("refuses to reset a reused PR worktree that holds local commits", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const worktreePath = join(root, "repo-pr-7-feat-x");
    await prepare(request({ targetDir: repoDir }));
    const local = commitFile(worktreePath, "agent-work.txt");
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      /Branch pr-radar\/pr-7 has local commits/,
    );
    expect(gitIn(worktreePath, ["rev-parse", "HEAD"])).toBe(local);
  });

  test("refuses to reset an existing PR branch with local commits in the base checkout", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    gitIn(repoDir, ["checkout", "-b", "pr-radar/pr-7"]);
    const local = commitFile(repoDir, "mine.txt");
    gitIn(repoDir, ["checkout", "main"]);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /Branch pr-radar\/pr-7 has local commits/,
    );
    expect(gitIn(repoDir, ["rev-parse", "pr-radar/pr-7"])).toBe(local);
  });

  test("refuses to reset a leftover PR branch with local commits when creating a worktree", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    gitIn(repoDir, ["checkout", "-b", "pr-radar/pr-7"]);
    const local = commitFile(repoDir, "mine.txt");
    gitIn(repoDir, ["checkout", "main"]);
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      /Branch pr-radar\/pr-7 has local commits/,
    );
    expect(gitIn(repoDir, ["rev-parse", "pr-radar/pr-7"])).toBe(local);
  });

  test("fast-forwards a leftover PR branch that is behind the PR head", async () => {
    const root = makeRoot();
    const { repoDir, prHead } = makePullableRepo(root);
    gitIn(repoDir, ["branch", "pr-radar/pr-7", "main"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["rev-parse", "pr-radar/pr-7"])).toBe(prHead);
  });

  test("checks out an existing issue branch unchanged in the base checkout", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-9"]);
    const local = commitFile(repoDir, "issue-work.txt");
    gitIn(repoDir, ["checkout", "main"]);
    await prepare(
      request({ itemKind: "issue", prNumber: 9, targetDir: repoDir, cwdMode: "CWD-BASE" }),
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/issue-9");
    expect(gitIn(repoDir, ["rev-parse", "HEAD"])).toBe(local);
  });

  test("creates an issue worktree on an existing branch without resetting it", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-9"]);
    const local = commitFile(repoDir, "issue-work.txt");
    gitIn(repoDir, ["checkout", "main"]);
    const result = await prepare(request({ itemKind: "issue", prNumber: 9, targetDir: repoDir }));
    expect(result.worktreeCreated).toBe(true);
    expect(gitIn(result.cwd, ["rev-parse", "HEAD"])).toBe(local);
  });

  test("starts a new issue branch from the remote default branch, not the current HEAD", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const defaultTip = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-ref", "refs/remotes/origin/main", defaultTip]);
    gitIn(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    gitIn(repoDir, ["checkout", "-b", "pr-radar/pr-7"]);
    commitFile(repoDir, "unmerged-pr.txt");
    await prepare(
      request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/issue-12");
    expect(gitIn(repoDir, ["rev-parse", "HEAD"])).toBe(defaultTip);
  });

  test("refuses a new issue branch while the base checkout sits on a PR branch with no remote default", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/pr-7"]);
    await expect(
      prepare(
        request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
      ),
    ).rejects.toThrow(/is on pr-radar\/pr-7/);
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir })),
    ).rejects.toThrow(/is on pr-radar\/pr-7/);
  });
});

describe("listLocalDirsHandler", () => {
  test("lists repos, worktrees and nested owner/repo directories with matches first", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    // Hidden folders are not scanned, so only the worktree listing finds this one.
    const treesDir = join(root, ".wt");
    gitIn(repoDir, ["worktree", "add", "-b", "side", join(treesDir, "side-tree")]);
    const otherDir = join(root, "other");
    initRepo(otherDir, "https://github.com/someone/other.git");
    mkdirSync(join(root, "plain", "nested"), { recursive: true });
    initRepo(join(root, "owner", "inner"), "https://github.com/owner/inner.git");
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "not a directory\n");

    const result = await listDirs({
      query: "",
      repository: "owner/repo",
    });
    expect(result.expandedSourceDir).toBe(root);
    const byLabel = new Map(result.entries.map((entry) => [entry.label, entry]));
    expect(byLabel.get("repo")).toMatchObject({ kind: "repo", isMatch: true, path: repoDir });
    expect(byLabel.get("repo · side-tree")).toMatchObject({
      kind: "worktree",
      branch: "side",
      isMatch: true,
      path: join(treesDir, "side-tree"),
    });
    expect(byLabel.get("other")).toMatchObject({ kind: "repo", isMatch: false });
    expect(byLabel.get("plain")).toMatchObject({ kind: "dir" });
    expect(byLabel.get("plain/nested")).toMatchObject({ kind: "dir", isMatch: false });
    expect(byLabel.get("owner/inner")).toMatchObject({ kind: "repo", isMatch: false });
    expect(byLabel.has(".hidden")).toBe(false);
    expect(byLabel.has("file.txt")).toBe(false);
    // Matches sort first, then worktrees before repos before plain directories.
    const labels = result.entries.map((entry) => entry.label);
    expect(labels.slice(0, 2)).toEqual(["repo · side-tree", "repo"]);
    expect(result.suggestedClonePath).toBe(repoDir);
  });

  test("filters by query on path, label and branch", async () => {
    const root = makeRoot();
    const repoDir = join(root, "alpha");
    initRepo(repoDir, "https://github.com/owner/alpha.git");
    gitIn(repoDir, ["worktree", "add", "-b", "feature-zq7k", join(root, ".wt", "tree-one")]);
    initRepo(join(root, "bq9x-repo"), "https://github.com/owner/bq9x-repo.git");

    // The repository matches, so its worktrees are listed; only the branch contains the query.
    const byBranch = await listDirs({
      query: "ZQ7K",
      repository: "owner/alpha",
    });
    expect(byBranch.entries.map((entry) => entry.label)).toEqual(["alpha · tree-one"]);

    const byLabel = await listDirs({
      query: "bq9x",
      repository: "",
    });
    expect(byLabel.entries.map((entry) => entry.label)).toEqual(["bq9x-repo"]);

    const byPath = await listDirs({
      query: join(root, "alpha").toLowerCase(),
      repository: "",
    });
    // A path query matches the repository entry; its worktree sits elsewhere and is not listed
    // because the repository neither matches nor has a name containing the query.
    expect(byPath.entries.map((entry) => entry.label)).toEqual(["alpha"]);
  });

  test("returns no entries for a missing source directory and suggests a flat clone path", async () => {
    const root = makeRoot();
    const missing = join(root, "missing");
    sourceDir = missing;
    const result = await listDirs({
      query: "",
      repository: "owner/repo",
    });
    expect(result.entries).toEqual([]);
    expect(result.suggestedClonePath).toBe(join(missing, "repo"));
  });

  test("suggests an owner-scoped clone path when the flat name belongs to another repository", async () => {
    const root = makeRoot();
    initRepo(join(root, "repo"), "https://github.com/someone-else/repo.git");
    const result = await listDirs({
      query: "",
      repository: "owner/repo",
    });
    expect(result.suggestedClonePath).toBe(join(root, "owner", "repo"));
  });

  test("falls back to a generic folder name without a repository", async () => {
    const root = makeRoot();
    const result = await listDirs({ query: "", repository: "" });
    expect(result.suggestedClonePath).toBe(join(root, "repo"));
  });
});

describe("runRoutingScriptHandler", () => {
  function writeScript(root: string, name: string, body: string, mode = 0o755): string {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, mode);
    return path;
  }

  function route(
    script: string,
    payload: Record<string, unknown> = {},
    limits?: RoutingScriptLimits,
  ) {
    routingScript = script;
    return runRoutingScriptHandler({ payload }, readSettings, limits);
  }

  const FAST_LIMITS: RoutingScriptLimits = {
    timeoutMs: 5_000,
    outputBytes: 1024,
    killGraceMs: 200,
  };

  test("requires a script configured in the server-side settings", async () => {
    await expect(route("")).rejects.toThrow("No routing script is configured");
  });

  test("rejects a relative script path and a missing script", async () => {
    await expect(route("bin/route.sh")).rejects.toThrow(
      "Routing script path must be an absolute or ~/ path: bin/route.sh",
    );
    const missing = join(makeRoot(), "nope.sh");
    await expect(route(missing)).rejects.toThrow(`Routing script not found: ${missing}`);
  });

  test("takes no script path from the request", () => {
    expect(runRoutingScript.input.shape).not.toHaveProperty("scriptPath");
    expect(listLocalDirs.input.shape).not.toHaveProperty("sourceCodeDir");
    expect(prepareWorkspaceCwd.input.shape).not.toHaveProperty("sourceCodeDir");
  });

  test("feeds the payload on stdin and parses the JSON result", async () => {
    const root = makeRoot();
    const captured = join(root, "stdin.json");
    const script = writeScript(
      root,
      "route.sh",
      `cat > "${captured}"\nprintf '{"profile":"fast","provider":"codex","options":{"a":1},"reason":"cheap"}'`,
    );
    const result = await route(script, { pr: 7 });
    expect(result).toEqual({
      profile: "fast",
      provider: "codex",
      options: { a: 1 },
      reason: "cheap",
    });
    expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ pr: 7 });
  });

  test("treats empty output as no routing decision", async () => {
    const script = writeScript(makeRoot(), "empty.sh", "cat > /dev/null");
    await expect(route(script)).resolves.toEqual({});
  });

  test("reports stderr, or the exit code, when the script fails", async () => {
    const root = makeRoot();
    await expect(route(writeScript(root, "noisy.sh", "echo boom >&2\nexit 3"))).rejects.toThrow(
      "boom",
    );
    await expect(route(writeScript(root, "quiet.sh", "exit 4"))).rejects.toThrow(
      "Routing script exited with code 4.",
    );
  });

  test("rejects output that is not JSON or does not match the schema", async () => {
    const root = makeRoot();
    await expect(route(writeScript(root, "notjson.sh", "echo 'not json'"))).rejects.toThrow(
      SyntaxError,
    );
    await expect(route(writeScript(root, "shape.sh", `echo '{"provider": 5}'`))).rejects.toThrow(
      /provider/,
    );
  });

  test("refuses a script that is not executable", async () => {
    const script = writeScript(makeRoot(), "plain.sh", "echo {}", 0o644);
    await expect(route(script)).rejects.toThrow(/is not executable/);
  });

  test("refuses a script that group or others can write", async () => {
    const root = makeRoot();
    const grouped = writeScript(root, "group.sh", "echo {}", 0o775);
    await expect(route(grouped)).rejects.toThrow(/must not be writable by group or others/);
    const open = writeScript(root, "open.sh", "echo {}", 0o757);
    await expect(route(open)).rejects.toThrow(/must not be writable by group or others/);
  });

  test("refuses a path that is not a regular file", async () => {
    const root = makeRoot();
    const dir = join(root, "adir");
    mkdirSync(dir);
    await expect(route(dir)).rejects.toThrow(/is not a regular file/);
  });

  test("checks the symlink target, not the link", async () => {
    const root = makeRoot();
    const target = writeScript(root, "real.sh", "echo {}", 0o775);
    const link = join(root, "link.sh");
    symlinkSync(target, link);
    await expect(route(link)).rejects.toThrow(/must not be writable by group or others/);
  });

  test("runs the script with an allow-listed environment", async () => {
    const root = makeRoot();
    const envFile = join(root, "env.txt");
    vi.stubEnv("PR_RADAR_TEST_SECRET", "leak-me");
    vi.stubEnv("GITHUB_TOKEN", "token-for-gh-only");
    vi.stubEnv("LC_ALL", "C");
    const script = writeScript(root, "env.sh", `env > "${envFile}"\necho '{}'`);
    await route(script);
    const seen = readFileSync(envFile, "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).toContain("LC_ALL=C");
    expect(seen).not.toContain("PR_RADAR_TEST_SECRET");
    expect(seen).not.toContain("GITHUB_TOKEN");
  });

  test("kills the script and fails once its output passes the byte cap", async () => {
    const root = makeRoot();
    const script = writeScript(
      root,
      "flood.sh",
      'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
    );
    await expect(route(script, {}, FAST_LIMITS)).rejects.toThrow(
      "Routing script output exceeded 1024 bytes.",
    );
  });

  test("counts bytes, not characters, against the cap", async () => {
    const root = makeRoot();
    // 600 two-byte characters are 600 characters but 1200 bytes.
    const script = writeScript(
      root,
      "wide.sh",
      `i=0\nwhile [ $i -lt 600 ]; do printf '\\303\\251'; i=$((i+1)); done`,
    );
    await expect(route(script, {}, FAST_LIMITS)).rejects.toThrow(/exceeded 1024 bytes/);
  });

  test("sends SIGTERM on timeout, then SIGKILL after the grace period", async () => {
    const root = makeRoot();
    const pidFile = join(root, "pid.txt");
    const script = writeScript(
      root,
      "stubborn.sh",
      `echo $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do sleep 0.05; done`,
    );
    await expect(
      route(script, {}, { timeoutMs: 400, outputBytes: 1024, killGraceMs: 200 }),
    ).rejects.toThrow("Routing script timed out after 400ms.");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  test("runs one script at a time", async () => {
    const root = makeRoot();
    const slow = writeScript(root, "slow.sh", "sleep 0.5\necho '{}'");
    const first = route(slow, {}, FAST_LIMITS);
    await vi.waitFor(async () => {
      await expect(route(slow, {}, FAST_LIMITS)).rejects.toThrow(/already running/);
    });
    await expect(first).resolves.toEqual({});
    await expect(route(slow, {}, FAST_LIMITS)).resolves.toEqual({});
  });

  test("reports an unsupported platform on Windows", async () => {
    const script = writeScript(makeRoot(), "any.sh", "echo {}");
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(route(script)).rejects.toThrow("Routing scripts are not supported on Windows.");
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
});

describe("source directory boundary", () => {
  test("refuses a target outside the configured source directory", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const repoDir = join(outside, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      `Target directory ${repoDir} is outside the configured source directory.`,
    );
    expect(root).not.toBe(outside);
  });

  test("refuses a symlink inside the source directory that points outside", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    initRepo(join(outside, "repo"), "https://github.com/owner/repo.git");
    const link = join(root, "linked");
    symlinkSync(join(outside, "repo"), link);
    await expect(prepare(request({ targetDir: link }))).rejects.toThrow(
      /is outside the configured source directory/,
    );
  });

  test("lists only worktrees inside the source directory", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const elsewhere = makeRoot();
    gitIn(repoDir, ["worktree", "add", "-b", "outside", join(elsewhere, "out-tree")]);
    const result = await listDirs({ query: "", repository: "owner/repo" });
    expect(result.entries.map((entry) => entry.label)).toEqual(["repo"]);
  });
});
