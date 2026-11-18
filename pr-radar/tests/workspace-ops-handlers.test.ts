import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ghEnv,
  listLocalDirsHandler,
  prepareWorkspaceCwdHandler,
  type RoutingScriptLimits,
  resolveRoutingScript,
  runRoutingScriptHandler,
  waitForRoutingScriptIdleForTests,
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

afterEach(async () => {
  await waitForRoutingScriptIdleForTests();
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
  if (remoteUrl) {
    gitIn(dir, ["remote", "add", "origin", remoteUrl]);
    // The initial commit counts as published: a remote-tracking branch contains it.
    gitIn(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  }
}

function commitFile(dir: string, name: string): string {
  writeFileSync(join(dir, name), `${name}\n`);
  gitIn(dir, ["add", name]);
  gitIn(dir, ["commit", "-m", `add ${name}`]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

/**
 * A checkout whose `origin` is `git@github.com:owner/repo.git` (so the repository match works).
 * `git remote get-url` expands `insteadOf` rewrites, so fetches are served instead by a fake `ssh`
 * first on PATH (the plugin passes git no GIT_SSH_COMMAND) that runs upload-pack on a local bare
 * repository carrying `refs/pull/7/head`. `prFiles` are extra files in the PR commit.
 */
function makePullableRepo(
  root: string,
  prFiles: Record<string, { content: string; mode?: number }> = {},
): { repoDir: string; bareDir: string; prHead: string } {
  const repoDir = join(root, "repo");
  const bareDir = join(root, "bare.git");
  initRepo(repoDir, "git@github.com:owner/repo.git");
  mkdirSync(bareDir, { recursive: true });
  gitIn(bareDir, ["init", "--bare", "-b", "main"]);
  const sshDir = join(root, "fake-ssh-bin");
  mkdirSync(sshDir);
  const fakeSsh = join(sshDir, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\nexec git upload-pack '${bareDir}'\n`);
  chmodSync(fakeSsh, 0o755);
  vi.stubEnv("PATH", `${sshDir}:${process.env.PATH ?? ""}`);
  writeFileSync(join(repoDir, "pr.txt"), "pr one\n");
  gitIn(repoDir, ["add", "pr.txt"]);
  for (const [name, file] of Object.entries(prFiles)) {
    mkdirSync(dirname(join(repoDir, name)), { recursive: true });
    writeFileSync(join(repoDir, name), file.content);
    chmodSync(join(repoDir, name), file.mode ?? 0o644);
    gitIn(repoDir, ["add", name]);
  }
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
    await expect(prepare(request({ repository: "-flag/repo" }))).rejects.toThrow(
      "Invalid repository name: -flag/repo",
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
      warning: `CWD-BASE will switch ${repoDir} from main to pr-radar/issue-12.`,
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
      warning: `CWD-BASE will switch ${repoDir} from main to pr-radar/pr-7.`,
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

  test("refuses CWD-BASE from detached HEAD", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    gitIn(repoDir, ["checkout", "--detach"]);
    await expect(
      prepare(
        request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
      ),
    ).rejects.toThrow(`Base checkout ${repoDir} is in detached HEAD`);
  });

  test("refuses CWD-BASE with untracked files before switching", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    writeFileSync(join(repoDir, "scratch.txt"), "mine\n");
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      "has uncommitted or untracked changes",
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("clones through hardened token-free git when allowed and the directory is missing", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    initRepo(source, null);
    writeFileSync(join(source, ".gitattributes"), "*.evil filter=evil\n");
    writeFileSync(join(source, "payload.evil"), "payload\n");
    gitIn(source, ["add", ".gitattributes", "payload.evil"]);
    gitIn(source, ["commit", "-m", "add filtered file"]);
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const envLog = join(root, "clone-git-env.txt");
    const argsLog = join(root, "clone-git-args.txt");
    const gitScript = join(binDir, "git");
    writeFileSync(
      gitScript,
      [
        "#!/bin/sh",
        `env >> "${envLog}"`,
        `printf '%s\\n' "$*" >> "${argsLog}"`,
        `if [ "$1" = "-c" ] && echo "$*" | grep -q "clone --no-checkout -- https://github.com/owner/repo.git"; then`,
        `  target=""`,
        `  for arg do target="$arg"; done`,
        `  "${realGit}" clone -q "${source}" "$target" || exit 8`,
        `  "${realGit}" -C "$target" remote set-url origin "https://github.com/owner/repo.git"`,
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(gitScript, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("GH_TOKEN", "gh-token-value");
    vi.stubEnv("GITHUB_TOKEN", "github-token-value");

    const target = join(root, "nested", "clone");
    const marker = join(root, "clone-filter-ran");
    const filter = join(root, "clone-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const filterConfig = join(root, "filter-config.gitconfig");
    writeFileSync(
      filterConfig,
      `[filter "evil"]\n\tsmudge = ${filter}\n\tclean = ${filter}\n\trequired = true\n`,
    );
    const globalConfig = join(root, "global.gitconfig");
    writeFileSync(globalConfig, `[includeIf "gitdir:${target}/.git"]\n\tpath = ${filterConfig}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    const result = await prepare(
      request({
        itemKind: "issue",
        prNumber: 3,
        targetDir: target,
        allowClone: true,
        cwdMode: "CWD-BASE",
      }),
    );
    const cloneArgs = readFileSync(argsLog, "utf8");
    expect(cloneArgs).toContain(
      `clone --no-checkout -- https://github.com/owner/repo.git ${target}`,
    );
    const seen = readFileSync(envLog, "utf8");
    expect(seen).toContain("GIT_ALLOW_PROTOCOL=file:ssh:https:http");
    expect(seen).not.toContain("GH_TOKEN=gh-token-value");
    expect(seen).not.toContain("GITHUB_TOKEN=github-token-value");
    expect(result.cloned).toBe(true);
    expect(result.warning).toBe(`CWD-BASE will switch ${target} from main to pr-radar/issue-3.`);
    expect(result.cwd).toBe(target);
    expect(gitIn(target, ["rev-parse", "HEAD"])).toBe(gitIn(source, ["rev-parse", "HEAD"]));
    expect(gitIn(target, ["branch", "--show-current"])).toBe("pr-radar/issue-3");
    expect(existsSync(join(target, "payload.evil"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("gh environment", () => {
  test("hands gh its credentials but not the rest of the environment", () => {
    vi.stubEnv("GH_TOKEN", "gh-token-value");
    vi.stubEnv("PR_RADAR_TEST_SECRET", "leak-me");
    const env = ghEnv();
    expect(env.GH_TOKEN).toBe("gh-token-value");
    expect(env.PR_RADAR_TEST_SECRET).toBeUndefined();
  });
});

describe("source directory confinement", () => {
  test("refuses a derived base checkout that is a symlink to outside the source directory", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    initRepo(join(outside, "real"), "https://github.com/owner/repo.git");
    symlinkSync(join(outside, "real"), join(root, "repo"));
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, cwdMode: "CWD-BASE" })),
    ).rejects.toThrow(/Base checkout .* is outside the configured source directory/);
    expect(gitIn(join(outside, "real"), ["branch", "--show-current"])).toBe("main");
  });

  test("does not refresh or return an existing worktree outside the source directory", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const { repoDir, prHead } = makePullableRepo(root);
    const stray = join(outside, "stray-wt");
    const before = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["worktree", "add", "-b", "pr-radar/pr-7", stray, before]);
    await expect(prepare(request({ targetDir: repoDir }))).rejects.toThrow(
      /Existing worktree .* is outside the configured source directory/,
    );
    expect(gitIn(stray, ["rev-parse", "HEAD"])).toBe(before);
    expect(before).not.toBe(prHead);
  });
});

describe("ignored local files", () => {
  test("refuses a checkout that would overwrite an ignored file the PR tracks", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root, {
      ".env": { content: "from-pr\n" },
      "build/out.js": { content: "from-pr\n" },
    });
    appendFileSync(join(repoDir, ".git/info/exclude"), ".env\nbuild/\n");
    writeFileSync(join(repoDir, ".env"), "mine\n");
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /would overwrite an ignored local file/,
    );
    expect(readFileSync(join(repoDir, ".env"), "utf8")).toBe("mine\n");
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");

    // An ignored directory counts as well.
    rmSync(join(repoDir, ".env"));
    mkdirSync(join(repoDir, "build"));
    writeFileSync(join(repoDir, "build/out.js"), "mine\n");
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /PR #7 tracks (\.env|build\/out\.js), which would overwrite/,
    );
    expect(readFileSync(join(repoDir, "build/out.js"), "utf8")).toBe("mine\n");
  });

  test("refuses a PR that replaces an ignored directory with a tracked file", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root, {
      private: { content: "from-pr\n" },
    });
    appendFileSync(join(repoDir, ".git/info/exclude"), "private/\n");
    mkdirSync(join(repoDir, "private"));
    writeFileSync(join(repoDir, "private/secret.txt"), "mine\n");
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /would overwrite an ignored local file/,
    );
    expect(readFileSync(join(repoDir, "private/secret.txt"), "utf8")).toBe("mine\n");
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses an issue checkout that would overwrite ignored files", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "git@github.com:owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-12"]);
    writeFileSync(join(repoDir, ".env"), "from-issue\n");
    writeFileSync(join(repoDir, "private"), "from-issue\n");
    gitIn(repoDir, ["add", ".env", "private"]);
    gitIn(repoDir, ["commit", "-m", "issue adds env and private"]);
    gitIn(repoDir, ["checkout", "main"]);
    appendFileSync(join(repoDir, ".git/info/exclude"), ".env\nprivate/\n");
    writeFileSync(join(repoDir, ".env"), "mine\n");
    mkdirSync(join(repoDir, "private"));
    writeFileSync(join(repoDir, "private/secret.txt"), "mine\n");
    await expect(
      prepare(
        request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
      ),
    ).rejects.toThrow(/would overwrite an ignored local file/);
    expect(readFileSync(join(repoDir, ".env"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(repoDir, "private/secret.txt"), "utf8")).toBe("mine\n");
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("leaves unrelated ignored files alone", async () => {
    const root = makeRoot();
    const { repoDir, prHead } = makePullableRepo(root);
    appendFileSync(join(repoDir, ".git/info/exclude"), "node_modules/\n");
    mkdirSync(join(repoDir, "node_modules"));
    writeFileSync(join(repoDir, "node_modules/dep.js"), "x\n");
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["rev-parse", "HEAD"])).toBe(prHead);
    expect(existsSync(join(repoDir, "node_modules/dep.js"))).toBe(true);
  });
});

describe("git hardening", () => {
  test("a PR's own hook does not run when the plugin checks it out", async () => {
    const root = makeRoot();
    const marker = join(root, "hook-ran");
    const { repoDir } = makePullableRepo(root, {
      ".husky/post-checkout": { content: `#!/bin/sh\ntouch '${marker}'\n`, mode: 0o755 },
    });
    gitIn(repoDir, ["config", "core.hooksPath", ".husky"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(repoDir, ".husky/post-checkout"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("hands git transport settings but no GitHub tokens or daemon secrets", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const binDir = join(root, "git-bin");
    mkdirSync(binDir);
    const envLog = join(root, "git-env.txt");
    const argsLog = join(root, "git-args.txt");
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nenv >> '${envLog}'\nprintf '%s\\n' "$*" >> '${argsLog}'\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("GH_TOKEN", "gh-token-value");
    vi.stubEnv("GITHUB_TOKEN", "github-token-value");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-token-value");
    vi.stubEnv("PR_RADAR_TEST_SECRET", "leak-me");
    vi.stubEnv("GIT_SSH_COMMAND", "evil-ssh");
    vi.stubEnv("SSL_CERT_FILE", "/etc/ssl/test-ca.pem");
    await prepare(
      request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
    );
    const seen = readFileSync(envLog, "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).toContain("SSL_CERT_FILE=/etc/ssl/test-ca.pem");
    expect(seen).toContain("GIT_ALLOW_PROTOCOL=file:ssh:https:http");
    expect(seen).toContain("GIT_SSH_COMMAND=ssh -oBatchMode=yes");
    expect(seen).not.toContain("GH_TOKEN=gh-token-value");
    expect(seen).not.toContain("GITHUB_TOKEN=github-token-value");
    expect(seen).not.toContain("GH_ENTERPRISE_TOKEN=enterprise-token-value");
    expect(seen).not.toContain("PR_RADAR_TEST_SECRET");
    expect(seen).not.toContain("GIT_SSH_COMMAND=evil-ssh");
    const args = readFileSync(argsLog, "utf8");
    expect(args).toContain("protocol.ext.allow=never");
    expect(args).toContain("credential.helper=");
    expect(args).toContain("credential.https://github.com.helper=!gh auth git-credential");
    expect(args).toContain("core.sshCommand=ssh -oBatchMode=yes");
    expect(args).toContain("filter.lfs.process=");
  });

  test("repository core.sshCommand does not override the hardened git transport", async () => {
    const root = makeRoot();
    const marker = join(root, "ssh-command-ran");
    const { repoDir } = makePullableRepo(root);
    const evilSsh = join(root, "evil-ssh.sh");
    writeFileSync(evilSsh, `#!/bin/sh\ntouch '${marker}'\nexit 9\n`);
    chmodSync(evilSsh, 0o755);
    gitIn(repoDir, ["config", "core.sshCommand", evilSsh]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(marker)).toBe(false);
  });

  test("configured non-lfs filters do not run during checkout", async () => {
    const root = makeRoot();
    const marker = join(root, "filter-ran");
    const filter = join(root, "evil-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: "*.evil filter=evil\n" },
      "payload.evil": { content: "payload\n" },
    });
    gitIn(repoDir, ["config", "filter.evil.smudge", filter]);
    gitIn(repoDir, ["config", "filter.evil.clean", filter]);
    gitIn(repoDir, ["config", "filter.evil.required", "true"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(repoDir, "payload.evil"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("worktree-local includeIf filters do not run during worktree creation", async () => {
    const root = makeRoot();
    const marker = join(root, "worktree-filter-ran");
    const filter = join(root, "worktree-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: "*.evil filter=evil\n" },
      "payload.evil": { content: "payload\n" },
    });
    const filterConfig = join(root, "worktree-filter.gitconfig");
    writeFileSync(
      filterConfig,
      `[filter "evil"]\n\tsmudge = ${filter}\n\tclean = ${filter}\n\trequired = true\n`,
    );
    appendFileSync(
      join(repoDir, ".git", "config"),
      `\n[includeIf "gitdir:${repoDir}/.git/worktrees/"]\n\tpath = ${filterConfig}\n`,
    );
    const result = await prepare(request({ targetDir: repoDir }));
    expect(gitIn(result.cwd, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(result.cwd, "payload.evil"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("filter discovery failing stops the launch instead of running repo filters", async () => {
    const root = makeRoot();
    const marker = join(root, "overflow-filter-ran");
    const filter = join(root, "overflow-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: "*.evil filter=evil\n" },
      "payload.evil": { content: "payload\n" },
    });
    gitIn(repoDir, ["config", "filter.evil.smudge", filter]);
    gitIn(repoDir, ["config", "filter.evil.clean", filter]);
    gitIn(repoDir, ["config", "filter.evil.required", "true"]);

    // A git wrapper whose filter discovery outputs more than the 8 MiB cap, so the buffer overflows.
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const binDir = join(root, "overflow-bin");
    mkdirSync(binDir);
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `if echo "$*" | grep -q -- "--get-regexp"; then`,
        "  head -c 9000000 /dev/zero | tr '\\0' 'x'",
        "  exit 0",
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("equals-sign filter names cannot bypass neutralization", async () => {
    const root = makeRoot();
    const marker = join(root, "eq-filter-ran");
    const filter = join(root, "eq-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: "*.evil filter=evil=x\n" },
      "payload.evil": { content: "payload\n" },
    });
    gitIn(repoDir, ["config", "filter.evil=x.smudge", filter]);
    gitIn(repoDir, ["config", "filter.evil=x.clean", filter]);
    gitIn(repoDir, ["config", "filter.evil=x.required", "true"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(repoDir, "payload.evil"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("empty-name filters cannot bypass neutralization", async () => {
    const root = makeRoot();
    const marker = join(root, "empty-filter-ran");
    const filter = join(root, "empty-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: "*.evil filter=\n" },
      "payload.evil": { content: "payload\n" },
    });
    gitIn(repoDir, ["config", "filter..smudge", filter]);
    gitIn(repoDir, ["config", "filter..clean", filter]);
    gitIn(repoDir, ["config", "filter..required", "true"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(repoDir, "payload.evil"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("line-separator filter names cannot bypass neutralization", async () => {
    const root = makeRoot();
    const marker1 = join(root, "lsep-filter-ran");
    const marker2 = join(root, "psep-filter-ran");
    const filter1 = join(root, "lsep-filter.sh");
    const filter2 = join(root, "psep-filter.sh");
    writeFileSync(filter1, `#!/bin/sh\ntouch '${marker1}'\ncat\n`);
    writeFileSync(filter2, `#!/bin/sh\ntouch '${marker2}'\ncat\n`);
    chmodSync(filter1, 0o755);
    chmodSync(filter2, 0o755);
    const name1 = "evil\u2028x";
    const name2 = "evil\u2029x";
    const { repoDir } = makePullableRepo(root, {
      ".gitattributes": { content: `*.evil1 filter=${name1}\n*.evil2 filter=${name2}\n` },
      "payload.evil1": { content: "payload1\n" },
      "payload.evil2": { content: "payload2\n" },
    });
    gitIn(repoDir, ["config", `filter.${name1}.smudge`, filter1]);
    gitIn(repoDir, ["config", `filter.${name1}.clean`, filter1]);
    gitIn(repoDir, ["config", `filter.${name1}.required`, "true"]);
    gitIn(repoDir, ["config", `filter.${name2}.smudge`, filter2]);
    gitIn(repoDir, ["config", `filter.${name2}.clean`, filter2]);
    gitIn(repoDir, ["config", `filter.${name2}.required`, "true"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(join(repoDir, "payload.evil1"))).toBe(true);
    expect(existsSync(join(repoDir, "payload.evil2"))).toBe(true);
    expect(existsSync(marker1)).toBe(false);
    expect(existsSync(marker2)).toBe(false);
  });

  test("non-UTF-8 filter discovery output fails closed", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const binDir = join(root, "badutf-bin");
    mkdirSync(binDir);
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `if echo "$*" | grep -q -- "--get-regexp"; then`,
        "  printf 'filter.evil\\377x.smudge\\0'",
        "  exit 0",
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow();
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("config-based hooks do not run on checkout", async () => {
    const root = makeRoot();
    const marker = join(root, "config-hook-ran");
    const hook = join(root, "config-hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const { repoDir } = makePullableRepo(root);
    gitIn(repoDir, ["config", "hook.mine.command", hook]);
    gitIn(repoDir, ["config", "hook.mine.event", "post-checkout"]);
    await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses a PR that replaces a submodule with a regular file", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root, {
      submod: { content: "now a regular file\n" },
    });
    const gitlinkSha = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},submod`]);
    gitIn(repoDir, ["commit", "-m", "add gitlink"]);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /replaces the submodule under submod/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses a PR that replaces a submodule's ancestor directory with a file", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root, {
      nested: { content: "now a regular file\n" },
    });
    const gitlinkSha = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},nested/sub`]);
    gitIn(repoDir, ["commit", "-m", "add nested gitlink"]);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /replaces the submodule under nested/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("does not refuse an unchanged gitlink with ordinary siblings", async () => {
    const root = makeRoot();
    const { repoDir, bareDir } = makePullableRepo(root);
    const gitlinkSha = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},nested/sub`]);
    gitIn(repoDir, ["commit", "-m", "add nested gitlink"]);

    // Build a PR head that keeps the gitlink and adds an ordinary sibling under the same directory.
    const readmeFile = join(root, "readme");
    writeFileSync(readmeFile, "hello\n");
    const readmeBlob = gitIn(repoDir, ["hash-object", "-w", readmeFile]);
    const scratchIndex = join(root, "scratch-index");
    writeFileSync(scratchIndex, "");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    execFileSync("git", ["-C", repoDir, "read-tree", "HEAD"], { env: indexEnv });
    execFileSync(
      "git",
      ["-C", repoDir, "update-index", "--add", "--cacheinfo", `100644,${readmeBlob},nested/README`],
      { env: indexEnv },
    );
    const tree = execFileSync("git", ["-C", repoDir, "write-tree"], {
      env: indexEnv,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["-C", repoDir, "commit-tree", tree, "-m", "sibling"], {
      env: indexEnv,
      encoding: "utf8",
    }).trim();
    gitIn(repoDir, ["push", bareDir, `+${commit}:refs/pull/7/head`]);

    const result = await prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }));
    expect(result.cwd).toBe(repoDir);
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("pr-radar/pr-7");
  });

  test("refuses a PR that replaces a submodule's ancestor with a symlink", async () => {
    const root = makeRoot();
    const { repoDir, bareDir } = makePullableRepo(root);
    const gitlinkSha = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},nested/sub`]);
    gitIn(repoDir, ["commit", "-m", "add nested gitlink"]);

    // Build a PR head whose tree turns `nested` into a symlink, based on the pre-gitlink commit.
    const symlinkTarget = join(root, "symlink-target");
    writeFileSync(symlinkTarget, "nowhere\n");
    const blobSha = gitIn(repoDir, ["hash-object", "-w", symlinkTarget]);
    const scratchIndex = join(root, "scratch-index");
    writeFileSync(scratchIndex, "");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    execFileSync("git", ["-C", repoDir, "read-tree", "HEAD~1"], { env: indexEnv });
    execFileSync(
      "git",
      ["-C", repoDir, "update-index", "--add", "--cacheinfo", `120000,${blobSha},nested`],
      { env: indexEnv },
    );
    const tree = execFileSync("git", ["-C", repoDir, "write-tree"], {
      env: indexEnv,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync(
      "git",
      ["-C", repoDir, "commit-tree", tree, "-m", "symlink nested"],
      {
        env: indexEnv,
        encoding: "utf8",
      },
    ).trim();
    gitIn(repoDir, ["push", bareDir, `+${commit}:refs/pull/7/head`]);

    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /replaces the submodule under nested/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses an issue checkout that replaces a submodule with a file", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "git@github.com:owner/repo.git");
    const gitlinkSha = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},submod`]);
    gitIn(repoDir, ["commit", "-m", "add gitlink"]);
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-12"]);
    gitIn(repoDir, ["rm", "--cached", "submod"]);
    writeFileSync(join(repoDir, "submod"), "now a file\n");
    gitIn(repoDir, ["add", "submod"]);
    gitIn(repoDir, ["commit", "-m", "issue replaces submod"]);
    gitIn(repoDir, ["checkout", "main"]);
    await expect(
      prepare(
        request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
      ),
    ).rejects.toThrow(/replaces the submodule under submod/);
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("re-materializes a partially checked out issue worktree", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "git@github.com:owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-12"]);
    writeFileSync(join(repoDir, "work.txt"), "issue work\n");
    gitIn(repoDir, ["add", "work.txt"]);
    gitIn(repoDir, ["commit", "-m", "issue work"]);
    gitIn(repoDir, ["checkout", "main"]);
    const wt = join(root, "issue-wt");
    gitIn(repoDir, ["worktree", "add", "--no-checkout", wt, "pr-radar/issue-12"]);
    expect(existsSync(join(wt, "work.txt"))).toBe(false);
    const result = await prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir }));
    expect(result.cwd).toBe(wt);
    expect(existsSync(join(wt, "work.txt"))).toBe(true);
  });

  test("refuses a partial issue worktree that has local data", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "git@github.com:owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-12"]);
    writeFileSync(join(repoDir, "work.txt"), "issue work\n");
    gitIn(repoDir, ["add", "work.txt"]);
    gitIn(repoDir, ["commit", "-m", "issue work"]);
    gitIn(repoDir, ["checkout", "main"]);
    const wt = join(root, "issue-wt");
    gitIn(repoDir, ["worktree", "add", "--no-checkout", wt, "pr-radar/issue-12"]);
    writeFileSync(join(wt, "extra.txt"), "user data\n");
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir })),
    ).rejects.toThrow(/contains local data/);
    expect(readFileSync(join(wt, "extra.txt"), "utf8")).toBe("user data\n");
  });

  test("refuses a partial issue worktree with a colliding tracked-path file", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "git@github.com:owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "pr-radar/issue-12"]);
    writeFileSync(join(repoDir, "work.txt"), "issue work\n");
    gitIn(repoDir, ["add", "work.txt"]);
    gitIn(repoDir, ["commit", "-m", "issue work"]);
    gitIn(repoDir, ["checkout", "main"]);
    const wt = join(root, "issue-wt");
    gitIn(repoDir, ["worktree", "add", "--no-checkout", wt, "pr-radar/issue-12"]);
    // Ignore `work.txt` so `git status` would miss it; the filesystem check must still catch it.
    const exclude = join(repoDir, gitIn(repoDir, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(exclude, "work.txt\n");
    writeFileSync(join(wt, "work.txt"), "local secret\n");
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir })),
    ).rejects.toThrow(/contains local data/);
    expect(readFileSync(join(wt, "work.txt"), "utf8")).toBe("local secret\n");
  });

  test("submodule filters do not run during the dirty check", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const marker = join(root, "submodule-filter-ran");
    const filter = join(root, "sub-filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    const subRepo = join(root, "sub-repo");
    initRepo(subRepo, null);
    gitIn(repoDir, ["-c", "protocol.file.allow=always", "submodule", "add", subRepo, "sub"]);
    const sub = join(repoDir, "sub");
    gitIn(sub, ["config", "user.email", "test@example.com"]);
    gitIn(sub, ["config", "user.name", "Test"]);
    // Configure the filter before committing the filtered file: `git add` below runs it, and
    // the parent's recursive status would too without --ignore-submodules=all.
    gitIn(sub, ["config", "filter.evil.clean", filter]);
    gitIn(sub, ["config", "filter.evil.smudge", filter]);
    writeFileSync(join(sub, ".gitattributes"), "*.evil filter=evil\n");
    writeFileSync(join(sub, "p.evil"), "payload\n");
    gitIn(sub, ["add", ".gitattributes", "p.evil"]);
    gitIn(sub, ["commit", "-m", "add filtered"]);
    rmSync(marker, { force: true });

    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      "uncommitted or untracked changes",
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("disallows custom git remote helpers even when their URL parses as GitHub", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "custom://github.com/owner/repo");
    const binDir = join(root, "remote-helper-bin");
    mkdirSync(binDir);
    const marker = join(root, "custom-helper-ran");
    const helper = join(binDir, "git-remote-custom");
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 9\n`);
    chmodSync(helper, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses a checkout whose repo config redirects the fetch", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    gitIn(repoDir, ["config", "http.https://github.com.proxy", "http://evil-proxy:8080"]);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /configures transport keys/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses core.alternateRefsCommand in repo config", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const marker = join(root, "alternate-refs-ran");
    gitIn(repoDir, ["config", "core.alternateRefsCommand", `touch '${marker}'`]);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /configures transport keys/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses transport config pulled in by an include", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    const includeFile = join(root, "included.gitconfig");
    writeFileSync(includeFile, '[http "https://github.com"]\n\tproxy = http://evil-proxy:8080\n');
    appendFileSync(join(repoDir, ".git", "config"), `\n[include]\n\tpath = ${includeFile}\n`);
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /configures transport keys/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
  });

  test("refuses transport config from the worktree config file", async () => {
    const root = makeRoot();
    const { repoDir } = makePullableRepo(root);
    gitIn(repoDir, ["config", "extensions.worktreeConfig", "true"]);
    writeFileSync(
      join(repoDir, ".git", "config.worktree"),
      "[http]\n\tproxy = http://evil-proxy:8080\n",
    );
    await expect(prepare(request({ targetDir: repoDir, cwdMode: "CWD-BASE" }))).rejects.toThrow(
      /configures transport keys/,
    );
    expect(gitIn(repoDir, ["branch", "--show-current"])).toBe("main");
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

describe("issue start point without a remote default", () => {
  test("refuses a detached HEAD on unpublished PR code", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    commitFile(repoDir, "unmerged-pr.txt");
    gitIn(repoDir, ["checkout", "--detach"]);
    await expect(
      prepare(
        request({ itemKind: "issue", prNumber: 12, targetDir: repoDir, cwdMode: "CWD-BASE" }),
      ),
    ).rejects.toThrow(/is in detached HEAD/);
    expect(gitIn(repoDir, ["branch", "--list", "pr-radar/issue-12"])).toBe("");
  });

  test("refuses a branch named like the PR that no remote branch contains", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    gitIn(repoDir, ["checkout", "-b", "fix-the-thing"]);
    commitFile(repoDir, "unmerged-pr.txt");
    await expect(
      prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir })),
    ).rejects.toThrow(/HEAD is not on any origin branch/);
  });

  test("accepts a detached HEAD that a remote branch contains when creating a worktree", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const published = gitIn(repoDir, ["rev-parse", "HEAD"]);
    gitIn(repoDir, ["checkout", "--detach"]);
    const result = await prepare(request({ itemKind: "issue", prNumber: 12, targetDir: repoDir }));
    expect(gitIn(result.cwd, ["rev-parse", "HEAD"])).toBe(published);
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

  test("refuses a script owned by another user", async () => {
    // Stands in for a script a different user created: the checking user is not the owner.
    if (process.getuid?.() === 0) return;
    const script = writeScript(makeRoot(), "owned.sh", "echo {}");
    const otherUid = (process.getuid?.() ?? 0) + 1000;
    await expect(resolveRoutingScript(script, otherUid)).rejects.toThrow(
      /is owned by another user; run chown/,
    );
    await expect(resolveRoutingScript(script)).resolves.toBe(script);
  });

  test("refuses a script under a directory that group or others can write", async () => {
    const root = makeRoot();
    const shared = join(root, "shared");
    mkdirSync(shared);
    const script = writeScript(shared, "route.sh", "echo {}");
    chmodSync(shared, 0o775);
    await expect(route(script)).rejects.toThrow(
      `Routing script directory ${shared} must not be writable by group or others; run chmod go-w`,
    );
    // A writable ancestor further up counts too.
    const nested = join(shared, "nested");
    mkdirSync(nested);
    const deep = writeScript(nested, "deep.sh", "echo {}");
    await expect(route(deep)).rejects.toThrow(/must not be writable by group or others/);
  });

  test("allows a directory that is writable but sticky, like /tmp", async () => {
    const root = makeRoot();
    const shared = join(root, "sticky");
    mkdirSync(shared);
    const script = writeScript(shared, "route.sh", "echo '{}'");
    chmodSync(shared, 0o1777);
    await expect(route(script)).resolves.toEqual({});
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

  test("kills a descendant that would outlive the script when it times out", async () => {
    const root = makeRoot();
    const pidFile = join(root, "child-pid.txt");
    const script = writeScript(root, "spawner.sh", `sleep 60 &\necho $! > "${pidFile}"\nwait`);
    await expect(
      route(script, {}, { timeoutMs: 400, outputBytes: 1024, killGraceMs: 200 }),
    ).rejects.toThrow("Routing script timed out after 400ms.");
    const descendant = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(
      () => {
        expect(() => process.kill(descendant, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  test("arms one kill timer however many chunks pass the byte cap", async () => {
    const root = makeRoot();
    const script = writeScript(
      root,
      "flood2.sh",
      'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
    );
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        route(script, {}, { timeoutMs: 5_000, outputBytes: 1024, killGraceMs: 777 }),
      ).rejects.toThrow(/exceeded 1024 bytes/);
      await vi.waitFor(() => expect(spy.mock.calls.filter(([, ms]) => ms === 777).length).toBe(1));
      await new Promise((done) => setTimeout(done, 100));
      expect(spy.mock.calls.filter(([, ms]) => ms === 777)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("keeps the one-at-a-time guard until the stubborn script has been killed", async () => {
    const root = makeRoot();
    const stubborn = writeScript(
      root,
      "stubborn2.sh",
      `trap '' TERM\nwhile :; do sleep 0.05; done`,
    );
    const limits = { timeoutMs: 300, outputBytes: 1024, killGraceMs: 400 };
    await expect(route(stubborn, {}, limits)).rejects.toThrow(/timed out/);
    // The call failed, but the script ignoring SIGTERM is still alive until SIGKILL goes out.
    await expect(route(stubborn, {}, limits)).rejects.toThrow(/already running/);
    const quick = writeScript(root, "quick.sh", "echo '{}'");
    await vi.waitFor(async () => expect(await route(quick, {}, limits)).toEqual({}), {
      timeout: 3_000,
      interval: 100,
    });
  });

  test("runs one script at a time", async () => {
    const root = makeRoot();
    const started = join(root, "started");
    const slow = writeScript(root, "slow.sh", `touch "${started}"\nsleep 0.5\necho '{}'`);
    const first = route(slow, {}, FAST_LIMITS);
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    await expect(route(slow, {}, FAST_LIMITS)).rejects.toThrow(/already running/);
    await expect(first).resolves.toEqual({});
    rmSync(started);
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
