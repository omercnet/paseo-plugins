# PR Radar

A Paseo plugin that turns pull requests linked to active workspaces into a viewer-aware delivery queue.

PR Radar combines Paseo workspace and agent state with pull request checks, review status, mergeability, and the current GitHub user's relationship to each pull request. It answers which deliverables need you, which are already being handled, and which are waiting elsewhere.

## Screenshots

Repository, pull request, workspace, and agent names in these screenshots are synthetic. The live
browser DOM was rewritten before capture so no private identifiers are published.

### Wide dashboard

![PR Radar wide dashboard](docs/images/pr-radar-github-inbox-wide.png)

### Compact dashboard

![PR Radar compact dashboard](docs/images/pr-radar-github-inbox-compact.png)

## What it shows

- Needs you: authored blockers and review requests whose checks have completed.
- Being handled: actionable work with an active Paseo agent.
- Waiting externally: running checks, pending reviews, repository requirements, and external-author work.
- Ready: authored pull requests that are mergeable with settled checks and reviews.
- Viewer labels: `YOURS`, `REVIEW`, and `EXTERNAL`.
- Contextual actions: ask an existing agent or start one in the linked workspace.

Paseo supplies normalized workspace pull request status. A daemon-side plugin handler uses the authenticated `gh` CLI to distinguish authored pull requests from review requests. If viewer lookup fails, PR Radar falls back conservatively and does not claim that a row needs the user.

## Install

Install from the plugin's monorepo directory on the Paseo daemon host:

```bash
paseo plugin add omercnet/paseo-plugins:pr-radar
```

The daemon must have plugins enabled and `gh` authenticated for GitHub viewer-aware triage.

## Develop

```bash
bun install
bun run check
bun test
bun run test:coverage
bun run typecheck
bunx paseo plugin install "$PWD"
bunx paseo plugin reload pr-radar
```

Release Please maintains the version, changelog, component tag, and GitHub release from
Conventional Commits in the monorepo.

The project targets Paseo `0.8.x`, including compatible `0.8` prereleases. Host-owned navigation opens linked agents and
workspaces without private routes or page reloads on web, desktop, iOS, and Android. React `19.1`
and React Native `0.81` match the versions supplied by the plugin host.
