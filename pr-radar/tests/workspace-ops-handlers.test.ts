import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  listLocalDirsHandler,
  prepareWorkspaceCwdHandler,
  runRoutingScriptHandler,
} from "../server/workspace-ops";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-handlers-")));
  tempDirs.push(root);
  return root;
}

function gitIn(dir: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
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
 * A checkout whose `origin` URL is a github.com URL (so the repository match works) but whose
 * fetches are redirected to a local bare repository carrying `refs/pull/7/head`.
 */
function makePullableRepo(root: string): { repoDir: string; bareDir: string; prHead: string } {
  const repoDir = join(root, "repo");
  const bareDir = join(root, "bare.git");
  initRepo(repoDir, "https://github.com/owner/repo.git");
  mkdirSync(bareDir, { recursive: true });
  gitIn(bareDir, ["init", "--bare", "-b", "main"]);
  gitIn(repoDir, ["config", `url.${bareDir}.insteadOf`, "https://github.com/owner/repo.git"]);
  writeFileSync(join(repoDir, "pr.txt"), "pr one\n");
  gitIn(repoDir, ["add", "pr.txt"]);
  gitIn(repoDir, ["commit", "-m", "pr head"]);
  const prHead = gitIn(repoDir, ["rev-parse", "HEAD"]);
  gitIn(repoDir, ["push", bareDir, "HEAD:refs/pull/7/head"]);
  gitIn(repoDir, ["reset", "--hard", "HEAD~1"]);
  return { repoDir, bareDir, prHead };
}

function request(overrides: Record<string, unknown>) {
  return {
    itemKind: "pr" as const,
    repository: "owner/repo",
    prNumber: 7,
    headRefName: "feat/x",
    baseRefName: "main",
    sourceCodeDir: "/nonexistent-source-dir",
    targetDir: null as string | null,
    allowClone: false,
    cwdMode: "CWD-WORKTREE" as const,
    worktreeName: null as string | null,
    ...overrides,
  };
}

describe("prepareWorkspaceCwdHandler validation", () => {
  test("rejects an invalid repository slug before touching the disk", async () => {
    await expect(
      prepareWorkspaceCwdHandler(request({ repository: "bad/../repo" })),
    ).rejects.toThrow("Invalid repository name: bad/../repo");
  });

  test("rejects a relative target directory", async () => {
    await expect(
      prepareWorkspaceCwdHandler(request({ targetDir: "relative/dir" })),
    ).rejects.toThrow("Target directory must be an absolute or ~/ path: relative/dir");
  });

  test("rejects a target that is a file", async () => {
    const root = makeRoot();
    const file = join(root, "afile");
    writeFileSync(file, "x");
    await expect(prepareWorkspaceCwdHandler(request({ targetDir: file }))).rejects.toThrow(
      `Target path is not a directory: ${file}`,
    );
  });

  test("rejects a directory that is not a git repository", async () => {
    const root = makeRoot();
    const dir = join(root, "plain");
    mkdirSync(dir);
    await expect(prepareWorkspaceCwdHandler(request({ targetDir: dir }))).rejects.toThrow(
      `Target directory is not a git repository: ${dir}`,
    );
  });

  test("rejects an invalid worktree folder name", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    await expect(
      prepareWorkspaceCwdHandler(request({ targetDir: repoDir, worktreeName: "../escape" })),
    ).rejects.toThrow("Invalid worktree folder name: ../escape");
  });

  test("derives the base checkout from the source directory when no target is given", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const result = await prepareWorkspaceCwdHandler(
      request({
        itemKind: "issue",
        prNumber: 12,
        sourceCodeDir: root,
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
    const result = await prepareWorkspaceCwdHandler(
      request({ targetDir: repoDir, cwdMode: "CWD-BASE" }),
    );
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
    await prepareWorkspaceCwdHandler(
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
    // gh repo clone -- OWNER/REPO TARGET
    const ghScript = join(binDir, "gh");
    writeFileSync(
      ghScript,
      [
        "#!/bin/sh",
        '[ "$1 $2 $3" = "repo clone --" ] || exit 9',
        'git clone -q "$FAKE_GH_SOURCE" "$5" || exit 8',
        'git -C "$5" remote set-url origin "https://github.com/$4.git"',
        "",
      ].join("\n"),
    );
    chmodSync(ghScript, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_GH_SOURCE", source);

    const target = join(root, "nested", "clone");
    const result = await prepareWorkspaceCwdHandler(
      request({
        itemKind: "issue",
        prNumber: 3,
        targetDir: target,
        allowClone: true,
        cwdMode: "CWD-BASE",
      }),
    );
    expect(result.cloned).toBe(true);
    expect(result.cwd).toBe(target);
    expect(gitIn(target, ["branch", "--show-current"])).toBe("pr-radar/issue-3");
  });
});

describe("prepareWorkspaceCwdHandler CWD-WORKTREE", () => {
  test("creates, reuses and refreshes a PR worktree", async () => {
    const root = makeRoot();
    const { repoDir, bareDir, prHead } = makePullableRepo(root);
    const worktreePath = join(root, "repo-pr-7-feat-x");

    const created = await prepareWorkspaceCwdHandler(request({ targetDir: repoDir }));
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

    const reused = await prepareWorkspaceCwdHandler(request({ targetDir: repoDir }));
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
    await prepareWorkspaceCwdHandler(request({ targetDir: repoDir }));
    writeFileSync(join(worktreePath, "pr.txt"), "dirty\n");
    await expect(prepareWorkspaceCwdHandler(request({ targetDir: repoDir }))).rejects.toThrow(
      `Existing worktree ${worktreePath} has uncommitted changes; commit or stash them before updating PR #7.`,
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
    const created = await prepareWorkspaceCwdHandler(issueInput);
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
    const reused = await prepareWorkspaceCwdHandler(issueInput);
    expect(reused.cwd).toBe(worktreePath);
    expect(reused.worktreeCreated).toBe(false);
  });
});

describe("listLocalDirsHandler", () => {
  test("lists repos, worktrees and nested owner/repo directories with matches first", async () => {
    const root = makeRoot();
    const repoDir = join(root, "repo");
    initRepo(repoDir, "https://github.com/owner/repo.git");
    const elsewhere = makeRoot();
    gitIn(repoDir, ["worktree", "add", "-b", "side", join(elsewhere, "side-tree")]);
    const otherDir = join(root, "other");
    initRepo(otherDir, "https://github.com/someone/other.git");
    mkdirSync(join(root, "plain", "nested"), { recursive: true });
    initRepo(join(root, "owner", "inner"), "https://github.com/owner/inner.git");
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "not a directory\n");

    const result = await listLocalDirsHandler({
      sourceCodeDir: root,
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
      path: join(elsewhere, "side-tree"),
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
    const elsewhere = makeRoot();
    gitIn(repoDir, ["worktree", "add", "-b", "feature-zeta", join(elsewhere, "tree-one")]);
    initRepo(join(root, "beta"), "https://github.com/owner/beta.git");

    // The repository matches, so its worktrees are listed; only the branch contains the query.
    const byBranch = await listLocalDirsHandler({
      sourceCodeDir: root,
      query: "ZETA",
      repository: "owner/alpha",
    });
    expect(byBranch.entries.map((entry) => entry.label)).toEqual(["alpha · tree-one"]);

    const byLabel = await listLocalDirsHandler({
      sourceCodeDir: root,
      query: "beta",
      repository: "",
    });
    expect(byLabel.entries.map((entry) => entry.label)).toEqual(["beta"]);

    const byPath = await listLocalDirsHandler({
      sourceCodeDir: root,
      query: join(root, "alpha").toLowerCase(),
      repository: "",
    });
    expect(byPath.entries.map((entry) => entry.label)).toEqual(["alpha", "alpha · tree-one"]);
  });

  test("returns no entries for a missing source directory and suggests a flat clone path", async () => {
    const root = makeRoot();
    const missing = join(root, "missing");
    const result = await listLocalDirsHandler({
      sourceCodeDir: missing,
      query: "",
      repository: "owner/repo",
    });
    expect(result.entries).toEqual([]);
    expect(result.suggestedClonePath).toBe(join(missing, "repo"));
  });

  test("suggests an owner-scoped clone path when the flat name belongs to another repository", async () => {
    const root = makeRoot();
    initRepo(join(root, "repo"), "https://github.com/someone-else/repo.git");
    const result = await listLocalDirsHandler({
      sourceCodeDir: root,
      query: "",
      repository: "owner/repo",
    });
    expect(result.suggestedClonePath).toBe(join(root, "owner", "repo"));
  });

  test("falls back to a generic folder name without a repository", async () => {
    const root = makeRoot();
    const result = await listLocalDirsHandler({ sourceCodeDir: root, query: "", repository: "" });
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

  test("rejects a relative script path and a missing script", async () => {
    await expect(
      runRoutingScriptHandler({ scriptPath: "bin/route.sh", payload: {} }),
    ).rejects.toThrow("Routing script path must be an absolute or ~/ path: bin/route.sh");
    const missing = join(makeRoot(), "nope.sh");
    await expect(runRoutingScriptHandler({ scriptPath: missing, payload: {} })).rejects.toThrow(
      `Routing script not found: ${missing}`,
    );
  });

  test("feeds the payload on stdin and parses the JSON result", async () => {
    const root = makeRoot();
    const captured = join(root, "stdin.json");
    const script = writeScript(
      root,
      "route.sh",
      `cat > "${captured}"\nprintf '{"profile":"fast","provider":"codex","options":{"a":1},"reason":"cheap"}'`,
    );
    const result = await runRoutingScriptHandler({ scriptPath: script, payload: { pr: 7 } });
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
    await expect(runRoutingScriptHandler({ scriptPath: script, payload: {} })).resolves.toEqual({});
  });

  test("reports stderr, or the exit code, when the script fails", async () => {
    const root = makeRoot();
    const noisy = writeScript(root, "noisy.sh", "echo boom >&2\nexit 3");
    await expect(runRoutingScriptHandler({ scriptPath: noisy, payload: {} })).rejects.toThrow(
      "boom",
    );
    const quiet = writeScript(root, "quiet.sh", "exit 4");
    await expect(runRoutingScriptHandler({ scriptPath: quiet, payload: {} })).rejects.toThrow(
      "Routing script exited with code 4.",
    );
  });

  test("rejects output that is not JSON or does not match the schema", async () => {
    const root = makeRoot();
    const notJson = writeScript(root, "notjson.sh", "echo 'not json'");
    await expect(runRoutingScriptHandler({ scriptPath: notJson, payload: {} })).rejects.toThrow(
      SyntaxError,
    );
    const wrongShape = writeScript(root, "shape.sh", `echo '{"provider": 5}'`);
    await expect(runRoutingScriptHandler({ scriptPath: wrongShape, payload: {} })).rejects.toThrow(
      /provider/,
    );
  });

  test("surfaces a spawn error for a script that is not executable", async () => {
    const script = writeScript(makeRoot(), "plain.sh", "echo {}", 0o644);
    await expect(runRoutingScriptHandler({ scriptPath: script, payload: {} })).rejects.toThrow(
      /EACCES/,
    );
  });
});
