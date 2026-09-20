# Paseo Context Mode

A Paseo sidebar and provider integration for [Context Mode](https://github.com/mksglu/context-mode). It bundles a pinned Context Mode runtime, shows health and savings, and activates Context Mode for supported Paseo agents without replacing existing provider-native integrations.

## Screenshots

These previews were captured from an isolated Paseo test daemon with Context Mode installed on a disposable home. The browser opened the real plugin surface on the daemon's Tailscale address, and both PNGs are 2× captures of the live data-backed UI.

### Wide surface

![Context Mode wide surface](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/context-mode/screenshot.png)

### Compact surface

![Context Mode compact surface](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/context-mode/screenshot-compact.png)

## Current scope

- Bundles Context Mode as a runtime dependency; a separately installed global executable remains optional.
- Resolves a configured absolute executable first, then the daemon's `PATH`, then the bundled runtime.
- Shows Context Mode version, structured diagnostics, provider activation, storage roots, lifetime savings, activity, categories, and indexed sources.
- Reads Context Mode 1.0.169 SQLite databases in query-only mode, honors active WAL state, isolates corrupt databases, and reports partial coverage instead of mutating schemas.
- Injects the bundled stdio MCP server into new supported agents through Paseo's `agent.create` hook.
- Injects provider identity and an existing provider-specific storage root on create, resume, refresh, and import.
- Preserves existing MCP servers and explicit environment overrides.
- Prefers detected native provider integrations to avoid duplicate `ctx_*` tools.
- Reuses existing provider-specific databases. It does not merge session databases across providers because Context Mode intentionally isolates their session identities.
- Provides provider- and project-scoped knowledge search, local-path indexing, URL fetch/index, indexed-source visibility, and an Insight link.
- Requires an explicit provider, project path, scope review, and second confirmation before purge. Purge remains delegated to Context Mode's own MCP contract.
- Returns structured install and provider-specific upgrade argv for review; Paseo never executes those commands automatically.
- Adds a per-agent composer shortcut to the Context Mode surface.

Context Mode currently couples sessions, stats, and indexed content under `CONTEXT_MODE_DIR`. Until upstream supports separate session and content roots, this plugin keeps storage provider-scoped instead of risking cross-provider session contamination.

## Prerequisites

Node.js 24 or later is required by this plugin. The bundled Context Mode runtime is installed with the plugin. Native provider integrations such as OMP's plugin remain recommended because generic MCP injection provides tools but cannot add provider-native lifecycle hooks.

The plugin depends on the upstream `context-mode` npm package under the Elastic License 2.0. See [NOTICE](NOTICE).

## Install

Plugins are trusted, unsandboxed code. Install only on a Paseo daemon you control.

```bash
cd context-mode
npm ci
npm run typecheck
paseo plugin install /absolute/path/to/context-mode --host 127.0.0.1:PORT
paseo plugin ls --host 127.0.0.1:PORT
```

Enable plugins for that host before installation. For development, start the daemon with an explicit isolated `--home`, then target its explicit `--host` for plugin lifecycle commands. Current Paseo rejects supplying `--home` and `--host` together because they are alternate target selectors.

Open **Context Mode** in the sidebar, use the per-agent composer pill, or run **Open Context Mode** from the Command Center. Use **Settings → Plugins → Context Mode settings** to configure executable precedence, automatic activation, native-integration preference, and refresh interval.

## Commands and limits

The daemon launches Context Mode directly with an argv array and no shell. MCP calls cover diagnostics, raw stats fallback, search, indexing, fetch/index, and explicitly confirmed purge. Each subprocess has a 12-second timeout and a 192 KiB combined output cap. Status is cached for 10 seconds and raw stats for 5 seconds.

Install and upgrade actions return separate program and argument fields. They are displayed for review and never executed by the plugin. Older Context Mode builds that lack required tools are reported as unsupported. Missing executables, launch failures, timeouts, protocol errors, output limits, unsupported database schemas, locked databases, and partial database scans are surfaced as typed states or warnings.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run check
```

## Licensing and attribution

The plugin is MIT licensed. Context Mode is a separate project by Mert Koseoglu and contributors, distributed under the Elastic License 2.0. See [NOTICE](NOTICE).
