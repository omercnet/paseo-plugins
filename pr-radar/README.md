# PR Radar

A Paseo plugin that turns pull requests linked to active workspaces into a viewer-aware delivery queue.

PR Radar combines Paseo workspace and agent state with pull request checks, review status, mergeability, and the current GitHub user's relationship to each pull request. It answers which deliverables need you, which are already being handled, and which are waiting elsewhere.

## Screenshots

Repository, pull request, workspace, and agent names are rewritten to synthetic values in browser
DevTools before capture. Both PNGs come from an isolated Paseo test daemon at 2× pixel density.

### Wide dashboard

![PR Radar wide dashboard](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/pr-radar/docs/images/pr-radar-github-inbox-wide.png)

### Compact dashboard

![PR Radar compact dashboard](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/pr-radar/docs/images/pr-radar-github-inbox-compact.png)

## What it shows

- Needs you: authored blockers and review requests whose checks have completed.
- Being handled: actionable work with an active Paseo agent.
- Waiting externally: running checks, pending reviews, repository requirements, and external-author work.
- Ready: authored pull requests that are mergeable with settled checks and reviews.
- Viewer labels: `YOURS`, `REVIEW`, and `EXTERNAL`.
- Contextual actions: ask an existing agent or start one in the linked workspace.

Paseo supplies normalized workspace pull request status. A daemon-side plugin handler uses the authenticated `gh` CLI to distinguish authored pull requests from review requests. If viewer lookup fails, PR Radar falls back conservatively and does not claim that a row needs the user.

## Install

### Paseo 0.9

Paseo 0.9 supports npm plugin sources. Install the published package on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-pr-radar
```

Update an npm installation to the latest published release:

```bash
paseo plugin update pr-radar
```

The npm install and update flow requires Paseo 0.9.


The daemon must have plugins enabled and `gh` authenticated for GitHub viewer-aware triage.

## Develop

```bash
bun install
bun run check
bun run test
bun run test:coverage
bun run typecheck
```

Release Please maintains the version, changelog, component tag, and GitHub release from
Conventional Commits in the monorepo.

The manifest requires Paseo `^0.9.0`. Development uses the `0.9.0` CLI, client, plugin SDK, and
protocol packages together. Host-owned navigation opens linked agents and workspaces without private
routes or page reloads on web, desktop, iOS, and Android. React `19.1` and React Native `0.81`
match the versions supplied by the plugin host.
