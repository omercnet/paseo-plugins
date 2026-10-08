Fresh Worktrees updates the local base branch before Paseo creates a branch-off worktree, so new work starts from the latest remote code instead of a stale `main`.

Before the worktree is created, the plugin runs `git fetch --prune` against the repository's remote, then fast-forwards the local base branch with `git merge --ff-only`. It does this only when that branch is checked out in the source checkout and the checkout has no uncommitted changes. If the checkout is dirty, the fetch fails, or the update is not a fast-forward, it warns and the workspace is created from the existing local base. Explicit remote bases are fetched but no local branch is changed, and repositories without a remote are left alone.

It also shows `Behind · N` in the workspace header when a worktree is behind its source branch's remote. On Paseo 0.11 and later, a sidebar footer lists behind workspaces and offers **Refresh all**, which fast-forwards each clean source checkout and skips dirty or diverged ones. It never modifies worktree branches.

Setup: `git` on the daemon host. The plugin runs `git` there with the daemon's environment and contacts the repository's remote on each fetch. Requires Paseo ^0.9.0, ^0.10.0 or ^0.11.0.
