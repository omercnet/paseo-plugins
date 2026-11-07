# Paseo Context Mode

A Paseo sidebar and provider integration for [Context Mode](https://github.com/mksglu/context-mode). It bundles a pinned Context Mode runtime, shows health and savings, and activates Context Mode for supported Paseo agents without replacing existing provider-native integrations.

## Demo

https://github.com/user-attachments/assets/43065ede-3fbd-4a9c-b1bb-79d327d90d9b

## Screenshots

These previews were captured from an isolated Paseo test daemon with Context Mode installed on a disposable home. The browser opened the real plugin surface on the daemon's Tailscale address, and both PNGs are 2× captures of the live data-backed UI.

### Wide surface

![Context Mode wide surface](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/context-mode/screenshot.png)

### Compact surface

![Context Mode compact surface](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/context-mode/screenshot-compact.png)

## Current scope

- Bundles Context Mode 2.1.4 and runs it by default. To bring your own, set an absolute path to a Context Mode 2.x executable (or its `cli.mjs`) under Runtime in the plugin settings; clearing it returns to the bundled runtime. `PATH` is not searched.
- Settings saved by earlier versions migrate automatically: an explicitly configured binary path is kept, and everything else returns to the bundled runtime.
- Shows Context Mode version, structured diagnostics, provider activation, lifetime savings, activity, per-agent and per-project breakdowns, categories, and indexed sources. The Diagnostics tab runs `ctx_doctor` against a plugin-owned probe store (`<PASEO_HOME>/plugin-data/context-mode/probe`) so it never writes into your real project databases.
- Reads Context Mode 2 `context.db` files (`<data dir>/projects/<key>/context.db`, schema `user_version` 6) in query-only mode, honors active WAL state, isolates corrupt or locked databases, and reports partial coverage instead of mutating schemas. The data directory is `CONTEXT_MODE_DATA_DIR`, else `~/.context-mode`.
- Injects the bundled stdio MCP server (`context-mode server --agent <id>`, with the data directory pinned to the one the dashboard reads) into new Claude, Codex, Copilot, and OpenCode agents through Paseo's `agent.create` hook. Cursor, Pi, and OMP are shown as disabled: Context Mode 2 dropped Cursor and OMP, and runs inside Pi only as its own in-process extension (`pi install npm:context-mode`).
- Preserves existing MCP servers and explicit environment overrides.
- Prefers detected native provider integrations to avoid duplicate `ctx_*` tools.
- Context Mode 2 keeps one database per project, shared by every agent, so storage is no longer isolated per provider.
- Provides project-scoped knowledge search (worktree or project scope, relevance or timeline order, with a More results button that follows upstream's page cursor), local-path indexing, URL indexing, indexed-source visibility with per-source forget, and a Recent sessions list on the dashboard. A session row can show Context Mode's `ctx_resume` state block (the last task, changed files and open errors an agent gets after a compact or restart) or forget that session. Index labels are chosen by Context Mode (the project-relative path or the final URL), so only content indexed by an agent carries a custom label. The agent selected in Knowledge only labels the Context Mode process; the project path decides which database is used. Plugin-initiated calls share one fixed `paseo-context-mode` session, which the sessions list leaves out.
- Requires an explicit provider, project path, scope review, and second confirmation before forgetting a project, session, or source. Deletion remains delegated to Context Mode's own `ctx_purge` contract.
- Registers the `context-mode` screen with URL-persisted `section`, `agentId`, and `workspaceId` params. Composer pills open Knowledge using the selected host's agent provider and working directory. URL params never carry paths or queries.
- Providers that Context Mode does not support, and missing agents or mismatched workspaces, require explicit scope selection.
- Adds a live Healthy/Failing sidebar footer row, reusing the screen's health data.

Upgrading from 3.x: Context Mode 2 is a rewrite with a new storage layout. The plugin only reads 2.x databases; existing 1.x data under provider directories is left untouched and is not shown. Agents created by an older plugin version keep a saved MCP entry that points at the removed 1.x entry file, so recreate them to pick up the new server. Run Context Mode's own `context-mode setup` if you also use it natively.

## Prerequisites

Node.js 24.15 or later is required by this plugin and by Context Mode 2. The bundled Context Mode runtime is installed with the plugin. Native provider integrations remain recommended because generic MCP injection provides tools but cannot add provider-native lifecycle hooks.

The plugin depends on the upstream `context-mode` npm package under the Elastic License 2.0. See [NOTICE](NOTICE).
## Install

Install the published npm package on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-context-mode
```

Update an npm installation to the latest published release:

```bash
paseo plugin update context-mode
```

The npm install and update flow requires Paseo `^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0` with npm available on the daemon host.


## Commands and limits

The daemon launches Context Mode directly with an argv array and no shell. MCP calls cover diagnostics, search, resume, indexing (path or URL), and explicitly confirmed purge. Each subprocess has a 192 KiB combined output cap and a per-tool timeout: 20 seconds for search and resume, 30 for doctor, and 120 for indexing and purge. The version and tool-list handshake has a 12-second timeout. Status is cached for 10 seconds; the provider coverage check reads config files only and starts no process.

With the bundled runtime, Context Mode updates arrive with plugin updates. The doctor therefore never suggests `ctx_upgrade` or `context-mode setup`: an outdated bundled runtime is a warning whose fix is to update the plugin, and the host-config (D3) and hook (D5) checks, which fail for every agent Paseo injects, are shown as warnings without a fix. A configured binary that is missing, not executable, or older than 2.x is reported as unavailable; the plugin never silently falls back to the bundled one. Missing executables, launch failures, timeouts, protocol errors, output limits, unsupported database schemas, locked databases, and partial database scans are surfaced as typed states or warnings.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run check
```

## Licensing and attribution

The plugin is MIT licensed. Context Mode is a separate project by Mert Koseoglu and contributors, distributed under the Elastic License 2.0. See [NOTICE](NOTICE).
