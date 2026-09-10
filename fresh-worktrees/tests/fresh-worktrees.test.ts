import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemoteRefreshCoordinator,
  refreshWorkspaceRequest,
  type WorkspaceCreateRequest,
} from "../server/fresh-worktrees";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("worktree refresh", () => {
  test("fetches the remote and bases a new worktree on its current default branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-worktrees-"));
    temporaryDirectories.push(root);
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    const publisher = join(root, "publisher");
    const worktree = join(root, "worktree");

    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "clone", remote, source);
    git(source, "config", "user.name", "Fresh Worktrees Test");
    git(source, "config", "user.email", "fresh-worktrees@example.test");
    await writeFile(join(source, "version.txt"), "one\n");
    git(source, "add", "version.txt");
    git(source, "commit", "-m", "initial");
    git(source, "push", "--set-upstream", "origin", "main");
    const staleLocalHead = git(source, "rev-parse", "main");

    git(root, "clone", remote, publisher);
    git(publisher, "config", "user.name", "Fresh Worktrees Test");
    git(publisher, "config", "user.email", "fresh-worktrees@example.test");
    await writeFile(join(publisher, "version.txt"), "two\n");
    git(publisher, "add", "version.txt");
    git(publisher, "commit", "-m", "advance remote");
    git(publisher, "push", "origin", "main");
    const currentRemoteHead = git(publisher, "rev-parse", "HEAD");

    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        projectId: "project-1",
        action: "branch-off",
        branchName: "feature/fresh",
      },
    };
    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => [
        {
          projectId: "project-1",
          projectRootPath: source,
          projectKind: "git",
        },
      ],
      refreshRemote: createRemoteRefreshCoordinator(),
    });

    expect(refreshed.source).toMatchObject({ refName: "origin/main" });
    if (refreshed.source.kind !== "worktree" || !refreshed.source.refName) {
      throw new Error("Expected a remote-backed worktree request");
    }

    git(
      source,
      "worktree",
      "add",
      "-b",
      refreshed.source.branchName ?? "feature/fresh",
      worktree,
      refreshed.source.refName,
    );
    expect(git(worktree, "rev-parse", "HEAD")).toBe(currentRemoteHead);
    expect(git(source, "rev-parse", "main")).toBe(staleLocalHead);
  });

  test("leaves explicit checkout requests alone", async () => {
    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        cwd: "/unused",
        action: "checkout",
        refName: "feature/existing",
      },
    };

    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => {
        throw new Error("Project lookup must not run");
      },
      refreshRemote: async () => {
        throw new Error("Fetch must not run");
      },
      runGit: async () => {
        throw new Error("Git inspection must not run");
      },
    });

    expect(refreshed).toBe(request);
  });
});
