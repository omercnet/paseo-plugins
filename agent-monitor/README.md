# agent-monitor

One roster for every agent on a daemon: an `Agent monitor` screen in the sidebar plus a global
Command Center item (`Open agent monitor`). The sidebar row also counts the agents
that need attention.

Answers "which of my 38 agents needs me right now" without walking the workspace tree.

## Demo

https://github.com/user-attachments/assets/3c841799-ed98-4ec4-86a0-a7917e3894fc

## Screenshots

Agent, project, and workspace names come from an isolated synthetic workspace. The roster and
settings PNGs were captured at 2× pixel density after browser DevTools replaced the local host
label and verified that no private organization names remained in the rendered page. The graph
screenshot uses the same synthetic project and agent names.

### Project-first roster

![Agent Monitor project-first roster](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/agent-monitor/docs/images/agent-monitor-roster.png)

### Graph view

![Agent Monitor graph view](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/agent-monitor/docs/images/agent-graph.png)

### Monitor settings

![Agent Monitor settings sheet](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/agent-monitor/docs/images/agent-monitor-settings.png)

## What it shows

- Counts and filters by triage bucket: Attention, Running, Idle, Closed. Attention covers
  `requiresAttention`, `status === "error"`, and pending permission requests.
- Default layout groups agents by **project**, then by workspace under each project. Open the
  gear beside Refresh for the host-native Monitor settings screen, which can switch to workspace
  groups or a flat compact list.
- Settings also control float-pinned sorting, agent sort (triage / recently updated / title),
  collapse of matching workspace headers, density, default bucket, whether Closed stays out of
  All, and display toggles for diffs, pin markers, model, wait age, subagent counts, last error, and
  compact placement. Preferences are a typed, host-scoped document shared by connected clients.
- Workspace headers show up to two workspace labels and current `+additions −deletions`
  (additions in the success color, deletions in danger when color diffs are on).
- Per row: a status dot that separates errors (danger) from agents waiting on you (warning) and
  running agents (success), state and wait age on a right-aligned rail (`attentionTimestamp`,
  falling back to `updatedAt`), model, and `lastError` inline.
- Parent rows show their subagent count; child rows use a left indent guide.
- Agents delegated from another host (`paseo.parent-server-id` names a different host) are listed as top-level rows with a "Delegated from `<host>`" hint. They are never counted under, or indented below, a local agent that happens to share the parent id.
- Text filter over title, agent id, provider, model, cwd, project, and workspace.
- **Graph view**: switch the header between Roster and Graph. Agents sit in compact
  project/workspace panels; provider-native subagents appear as dashed nodes. Edges encode parent
  hand-offs, timeline message provenance, and subagent dispatches, with thickness scaled by message
  count. Drag cards, pan the canvas, zoom with the wheel or a trackpad pinch, filter by project,
  workspace, provider, subagents, or connected-only, and select a card or edge to focus its
  neighbourhood and dim the rest.
- Select an agent row to open that agent, or select a workspace header (or its folder button when
  collapsed) to open its workspace through Paseo's cross-platform navigation API.
- Archive one agent, or sweep every closed agent (two taps).
- On Paseo 0.14 and later, eligible idle resumable agents are released after about an hour and appear in
  Closed (active work, descendants, pending finish notifications and provider safety checks keep a
  runtime resident). They keep their record and resume on the next prompt, so **Archive N closed** archives
  them too. Set `agents.idleRuntimeCleanup: false` in the host config to disable the release.

## Sidebar row

- The row's badge counts the Attention bucket, using the same rule as the roster. It shows no
  number while the roster loads or after a refresh fails, and `N+` once the agent list reaches the
  2,000-agent page limit.
- Press the badge for a popover of those agents, longest waiting first (up to eight), with
  **Open monitor**, which opens the roster filtered to Attention.
- The monitor screen accepts a `bucket` param (`attention`, `running`, `idle`, `closed`, or `all`)
  as its initial filter, so a link such as `…/surface/monitor?param.bucket=attention` opens
  filtered and keeps that filter on reload. Chips then filter in place without changing the URL.

## How it reads state

`usePaseo().agents.list()` pages the daemon agent directory, `usePaseo().workspaces.list()` reads
workspace pin state, project id, and diff stats (200 per page, up to 10 pages each), and
`usePaseo().projects.list()` supplies registered project names, including custom renames, so an
agent whose workspace is beyond the paged workspace list still lands under its real project. Rows
refresh from agent, workspace, and project subscription deltas, debounced 750ms, with a 30s
backstop refetch. The screen, the sidebar row, and its popover share that query, subscription set,
and backstop; on web and desktop, refreshes pause while the window is hidden and catch up when it returns. The plugin
borrows the selected host's connection; it opens no socket of its own. Agents and workspaces in
background workspaces are included.

The graph reads timeline tails (200 entries, up to 60 agents, four at a time) to derive message
and subagent edges. It refreshes every 30 seconds while open in the foreground and when Refresh
is pressed. Readable closed timelines can contribute interactions; unreadable timelines are
counted in the graph toolbar. Filters only change the visible graph and do not start new scans.
The graph uses the selected host's existing connection. Graph filters, selection, and positions
are temporary; the existing host-scoped monitor settings are unchanged.

## Limits

Interrupting a turn is not part of `PaseoApi`, so archive is the only lifecycle action here.

The sidebar popover lists agents but cannot open them: Paseo gives popovers no navigation.
Open the monitor and select the agent there.

## Install

Requires Paseo `^0.13.0 || ^0.14.0`, whose background workspaces the monitor lists. Development uses the 0.14 SDK line from the workspace catalog.

Install the published package on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-agent-monitor
paseo plugin update agent-monitor
```

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

The project supports Paseo `^0.13.0 || ^0.14.0` and pins `@getpaseo/plugin`, `@getpaseo/client`,
`@getpaseo/protocol`, and `@getpaseo/cli` to the 0.14 SDK line through the workspace catalog. Renovate groups `@getpaseo/*`
updates so the SDKs move together.

React `19.1` and React Native `0.81` intentionally match the versions supplied by Paseo.
