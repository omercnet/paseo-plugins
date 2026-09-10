# Fresh Worktrees

A headless Paseo plugin that keeps branch-off workspaces based on current remote refs without
mutating the source checkout.

Fresh Worktrees has no client entry or visual surface, so there is no UI screenshot. It runs only
inside the Paseo daemon during worktree creation.

## Behavior

Before Paseo creates a branch-off worktree, the plugin:

1. Resolves the source repository from the request path or Paseo project.
2. Fetches and prunes the relevant Git remote without interactive prompts.
3. Replaces an implicit or local base such as `main` with its current remote-tracking ref, such as
   `origin/main`.
4. Leaves the source checkout and its local branch untouched.

Explicit checkout and change-request workspaces are unchanged. Repositories without remotes are
unchanged. A failed fetch stops worktree creation rather than silently using stale history.
Concurrent requests for the same repository and remote share one fetch.

## Install

Paseo plugins are trusted, unsandboxed code. Review the source before installing it on the daemon
host.

```bash
paseo plugin add omercnet/paseo-plugins:fresh-worktrees
```

The plugin requires Paseo `>=0.8.0`.

## Develop

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
paseo plugin install "$PWD"
```
