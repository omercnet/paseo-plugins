# Item 28: Extensions and hooks inventory

## What it is
OMP runs user-written code at session start: extensions (`.omp/extensions`), hooks (`.omp/hooks/pre|post/*.ts`) and custom tools (`.omp/tools`), in the project and in the user agent dir. They can block tool calls, rewrite context or add tools. A broken one emits `extension_error` and fails quietly. Users: power users and teams shipping project hooks (for example a safety hook that blocks `rm -rf`), when an agent is blocked or odd and they don't know why.

## What users get today
- OMP's `/extensions` TUI command lists and toggles discovered items. Not reachable from Paseo.
- Our plugin provider turns `extension_error` into a timeline notice. Built-in `omp` agents: unverified.
- The settings editor covers `extensions` and `disabledExtensions` as raw keys. No inventory.

## Works with the built-in provider?
Partly. Listing is file globbing on the daemon host, so yes. Disabling writes `disabledExtensions` (ids like `extension-module:<name>`), applied to new sessions and after reload. Load errors are the problem: `extension_error` is a live RPC event the plugin cannot receive from a built-in agent. Scanning the session file might work (unverified it is persisted). OMP has no CLI to list extensions or hooks (`omp --help` shows only `plugin list`), so discovery precedence must be reimplemented. Disable ids for hooks and tools were not found in the docs (unverified).

## Value: low to medium
- These files are written by the user or checked into the repo, so users know they exist. Far less discovery value than Rules (26 built-ins nobody knows). No built-in hooks.
- The real pain, "my hook broke or blocked something", needs live errors: the part we cannot get without our provider or an upstream change.
- Rare: most users have none.

## Best surface and size
Read-only section in the OMP screen Configuration or Diagnostics tab (path, level, kind, state, toggle). No pill. S for list plus toggle, M with error scraping. Same glob-and-toggle pattern as items 21 to 24, so build only as one more row type there.

## Risks and costs
- Drift: discovery rules (project cwd-only, profile aware, legacy settings entries, `--no-extensions`) are easy to get wrong, giving a wrong inventory.
- Safety: toggling a safety hook off weakens protection; needs a warning.
- Duplicates OMP's `/extensions`.

## Recommendation: later
Do not build alone. Add as a row type when the Skills/Rules/Agents tabs ship. Ask OMP upstream for an RPC or CLI catalog and for `extension_error` to reach built-in agents; that unlocks the high-value half.

Cross-item: the upstream "RPC catalogs" ask should also cover extensions, hooks and tools.

## Paseo check (2026-11-05)
- Paseo already has: the built-in OMP provider handles `extension_ui_request` (extension dialogs and notify, `packages/server/src/server/agent/providers/omp/agent.ts:1568-1620`). It has no `extension_error` handling: no match in installed 0.15.0 `dist`, `v0.15.2` or main. Load errors stay invisible for built-in agents (already in GAPS.md, item 28).
- Community: no registry plugin lists OMP extensions, hooks or tools. `koinzhang/customize` 0.4.0 scans OMP instructions, rules, skills and MCP only (`customize/server/providers/omp.ts`). "Concise" covers its own hook only.
- Not in Paseo or plugins: any extensions, hooks or tools inventory, or a toggle for `disabledExtensions`.
- Effect on the decision: unchanged (A). There is no overlap, and the Rules tab is decided (SUMMARY.md), so a row type stays the cheap path. Live load errors remain a documented gap, not a build item.
- Unverified: whether OMP persists `extension_error` in the session file.
