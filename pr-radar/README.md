# PR Radar

A Paseo plugin that turns pull requests linked to active workspaces into a viewer-aware delivery queue.

PR Radar combines Paseo workspace and agent state with pull request checks, review status, mergeability, and the current GitHub user's relationship to each pull request. It answers which deliverables need you, which are already being handled, and which are waiting elsewhere.

## Demo

https://github.com/user-attachments/assets/ce0b4d61-59ce-49cf-881e-132db58d3038

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
- Linked workspaces and agents include those in background workspaces.

Paseo supplies normalized workspace pull request status. A daemon-side plugin handler uses the authenticated `gh` CLI to distinguish authored pull requests from review requests. If viewer lookup fails, PR Radar falls back conservatively and does not claim that a row needs the user.

## Sorting

The Sort row applies after the current filters and search. **Needs attention first** is the default:
bucket order, then oldest activity first. **Mergeable first** puts Ready rows first, newest activity
first, then the remaining buckets. **Recently updated** and **Oldest first** order by activity, not
creation time. **Repository** orders by repository name, then PR number.

Activity ties use ascending titles; fully tied rows keep their input order. Missing or invalid
activity times count as the epoch, so they sort first in oldest-first orders and last in newest-first
orders. Sort selection stays local to the open screen and resets on reload, like search and the
time window.

On web, Tab enters the group at the selected option and Tab or Shift+Tab leaves it. Space selects
the focused option. Arrow keys select and focus the next or previous option, wrapping at either end.

## Sidebar row

The sidebar row shows a "needs you" count; pressing the count opens a popover of those pull requests. Pressing one opens PR Radar focused on it (`param.pr`), and the needs-you link filters the queue (`param.filter`), so both survive reload and can be linked. A trailing `+` marks a count that may be incomplete: viewer lookup failed, a pagination or inbox cap was hit, or workspace status was unavailable.

## Install

Install the published package on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-pr-radar
```

Update an npm installation to the latest published release:

```bash
paseo plugin update pr-radar
```

The npm install and update flow requires Paseo `^0.12.0 || ^0.13.0 || ^0.14.0` with npm available on the daemon host.


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

The manifest supports Paseo `^0.12.0 || ^0.13.0 || ^0.14.0`. Development uses the 0.14 CLI, client, plugin SDK,
and protocol packages together from the workspace catalog. Host-owned navigation opens linked agents and workspaces without private routes or
page reloads on web, desktop, iOS, and Android. React `19.1` and React Native `0.81` match the versions supplied by
the plugin host.
