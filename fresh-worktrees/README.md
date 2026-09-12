# Fresh Worktrees

A Paseo plugin that fast-forwards the source checkout's clean local base branch before creating a
branch-off workspace.

The plugin runs the refresh inside the Paseo daemon and adds a workspace-header indicator when an
active worktree falls behind the source checkout's remote base.

## Behavior

Before Paseo creates a branch-off worktree, the plugin:

1. Resolves the source repository from the request path or Paseo project.
2. Fetches and prunes the relevant Git remote without interactive prompts.
3. For an implicit or local base such as `main`, verifies that branch is checked out and the source
   checkout is clean, then fast-forwards it to its remote-tracking branch.
4. Leaves the workspace request unchanged, so Paseo forks from the local branch.
5. Rechecks active worktrees every five minutes and shows `Behind · N` in the workspace header when
   their `HEAD` is behind the source branch's remote-tracking ref. Select the indicator to recheck it.

Explicit checkout and change-request workspaces are unchanged. Explicit remote bases are fetched
but do not mutate a local branch. Repositories without remotes are unchanged. A dirty source
checkout emits a warning and skips the local branch update, allowing workspace creation to continue
from the existing local base. Failed fetches and non-fast-forward updates still stop creation.
Concurrent requests for the same target share one refresh, and updates are serialized per repository.

## Install

Paseo plugins are trusted, unsandboxed code. Review the source before installing it on the daemon
host.

```bash
paseo plugin add omercnet/paseo-plugins:fresh-worktrees
```

The plugin requires Paseo `>=0.8.0`.

## Develop

```bash
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
```
