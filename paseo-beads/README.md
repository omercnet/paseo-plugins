# Paseo Beads

A dependency-aware Beads work queue for every Paseo workspace. Paseo Beads turns active issues into
a read-only delivery view that makes the ready frontier, work in progress, and blockers immediately
visible.

It adds a workspace-scoped **Beads** Explorer panel and an **Open Beads** Command Center item. It also adds a **Ready beads** sidebar row and a linkable bead screen.

## Demo

https://github.com/user-attachments/assets/f85e3c94-fbc1-49b6-9439-25bb7f66e9d7

## Screenshots

Issue IDs, titles, assignees, labels, and details come from a temporary synthetic Beads project.
Both PNGs were captured from an isolated Paseo daemon at 2× pixel density after browser DevTools
verified the rendered page contained no private organization names.

### Wide

![Paseo Beads wide work queue](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/paseo-beads/docs/images/paseo-beads-wide.png)

### Compact

![Paseo Beads compact work queue](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/paseo-beads/docs/images/paseo-beads-compact.png)

## What it shows

- Active issues grouped into **Ready frontier**, **In progress**, **Blocked**, and **Other** lanes.
- Priority, issue ID, title, type, assignee, labels, and relationship and comment counts on each row.
- Lane totals, text search over ID, title, assignee, and labels, and **All**, **P0–P1**, and
  **Assigned** filters.
- A detail view with status, readiness, priority, type, assignee, parent, labels, description,
  acceptance criteria, design, notes, dependencies, dependents, and update time.
- A side-by-side list and detail view when space permits, with list/detail navigation in compact
  layouts.
- A virtualized issue list, descriptive accessibility labels, and focus restoration when navigating
  between the compact list and detail view.
- A **Ready beads** sidebar row with the number of ready beads across the
  host's workspaces. Pressing it opens a popover (a bottom sheet in compact layouts) with the top 10
  ready beads grouped by workspace. Pressing a bead opens its detail view as a screen whose URL
  carries the workspace and bead IDs, so it can be linked and survives a reload.

Within each lane, issues are ordered by priority, most recent update, then ID. In-progress and hooked
issues enter **In progress** first; remaining blocked issues enter **Blocked**; ready issues enter
**Ready frontier**; all remaining active issues enter **Other**.

## How it works

The panel calls workspace-scoped Paseo plugin RPC handlers. On the daemon host, each handler resolves
the workspace directory through Paseo and executes the `bd` CLI with `--readonly` and `-C`:

- The list handler runs `bd list --json --sort priority`, then runs one authoritative
  `bd list --ready --json --limit 0` query and intersects its IDs with the displayed issues. It also
  runs `bd where --json` and returns a digest of the database location as an opaque `databaseId`,
  so workspaces that share one database, such as git worktrees, can be recognized. This is best
  effort: when `bd` cannot say, the snapshot is the same without it.
- Selecting an issue runs `bd show <issue-id> --json --include-dependents` plus the same authoritative
  readiness query.

The server validates and normalizes the CLI JSON before returning bounded data to the panel. The
plugin never reads or writes `.beads` storage directly and exposes no issue mutation controls.

The list and selected detail poll every 10 seconds. **Refresh** requests the list immediately. A
failed background refresh keeps the previous data visible with an inline error; initial and detail
failures provide a retry action.

The **Ready beads** row lists the host's workspaces through the Paseo SDK and calls the same list
handler for them, one workspace at a time, every 2 minutes while the app is in the foreground and
whenever its popover opens. A snapshot an open panel read in the last 10 seconds is reused instead
of rerunning `bd`. Workspaces that share a database, such as git worktrees, report the same
`databaseId`, so an issue counts once however many workspaces read it and is listed under the first
workspace that reported it. The first scan reads every workspace to learn which ones share a
database. Later scans read each database once and skip its other workspaces. A workspace is skipped
only while a successful read in the last 10 minutes vouches that it reads a database the scan has
already read, so a failed or older read puts it back in the scan. Workspaces without Beads count as
zero and are rechecked every 5 minutes. When `bd` is unavailable, or a workspace cannot be read,
the popover says so instead of reporting an empty host, and a failed refresh is shown next to the
last result. Once nothing shows the count, for example when the host disconnects, a scan that is
still running starts no further workspace reads.

## Limits

- Paseo `^0.11.0` with plugins enabled is required.
- Beads `bd` 1.0 or newer must be available on the Paseo daemon's `PATH`.
- A Beads project must be initialized in the workspace for issue data to appear.
- CLI calls time out after 10 seconds and accept at most 8 MiB of output. Unexpected CLI details stay
  in Paseo plugin logs; the panel receives a stable, sanitized error message.
- At most 500 issues are displayed. When more exist, the panel warns that lane counts and local
  search results may be incomplete.
- The server rejects oversized IDs, titles, body fields, labels, relationships, comments, and
  readiness sets rather than transferring unbounded data to the client.
- Search and filters operate only on the displayed snapshot.
- The panel distinguishes an unavailable `bd` binary, an uninitialized Beads project, an empty
  project, request failures, and missing issue details.
- This plugin is read-only and workspace-scoped. It uses the `bd` CLI exclusively and does not
  create, edit, close, or assign issues.
- The **Ready beads** row and the bead screen use the Paseo 0.11 screen and sidebar APIs.
- The **Ready beads** count covers the first 200 workspaces the host lists and, like the panel, the
  first 500 issues of each workspace. It refreshes about every two minutes while the app is in the
  foreground, plus the time a scan takes, and when the popover opens, so it can be older after the
  app was in the background. A workspace that moves to another database is noticed within 10
  minutes.
- A `bd` that cannot report its database (`bd where --json`) leaves every workspace counted on its
  own, so git worktrees of one project are counted separately.

## Install

Paseo plugins are trusted, unsandboxed code. Review the source before installing it on the daemon
host.

From npm:

```bash
paseo plugin install npm:@omercnet/paseo-beads
```

Update the installed npm package with:

```bash
paseo plugin update paseo-beads
```

Paseo shows the installed and proposed revisions and asks for approval before applying an ordinary
update. Review the source changes before approving them.

Open a workspace, choose **New tab** in Explorer, then select **Beads**. You can also run **Open
Beads** from the Command Center while viewing a workspace or one of its agents. Press **Ready beads** in the sidebar for ready work across every workspace on the host.

## Develop

```bash
bun install
bun run check
bun run test
bun run test:coverage
bun run typecheck
```

The package is `@omercnet/paseo-beads` at version `0.1.0`. Release Please maintains versions,
changelog entries, component tags, and GitHub releases from Conventional Commits in the monorepo.
