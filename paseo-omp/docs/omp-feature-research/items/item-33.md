# Item 33: LSP / DAP setup and status

## What it is
OMP agents can ask language servers (LSP) for errors, definitions, references and renames, and can drive a debugger (DAP). Both work with no setup: OMP auto-detects about 50 servers and 14 debug adapters from marker files (e.g. `Cargo.toml`) plus an installed binary. `lsp.json` (user or `<project>/.omp/lsp.json`) and `.omp/dap.json` add or override servers. The `lsp` tool's `status` and `reload` actions list servers and re-read config. Users who touch this: people with an unusual language or a misbehaving server. Rare, one-time.

## What users get today
- Zero-config for common languages.
- Plugin Diagnostics tab has one row: "LSP tool: Supported / Not advertised". Item 40 covers the `lsp.enabled` / `debug.enabled` switches; item 47 covers nicer tool-call cards.
- Nothing in Paseo edits `lsp.json` or `dap.json`.

## Works with the built-in provider?
Split.
- **Config editors: yes.** Plain JSON/YAML files on the daemon host, same pattern as the MCP editor. Merge rules are fiddly (6 filename variants, cwd over user, `settings`/`initOptions` replace instead of merging, wrapped vs flat form).
- **Reload: partly.** Config is cached per cwd inside the running OMP process; only the `lsp` tool's `reload` refreshes it. A plugin cannot send that to a built-in agent. New sessions pick up edits.
- **Live status: no.** `status` is a tool call inside the live session. No `omp lsp` CLI exists (checked `omp --help`, omp 18.13.1). A plugin would have to re-implement detection (markers, binary on PATH or local bins, TypeScript 7 rule), which drifts and cannot show what is really running. DAP has no status outside the session.

## Value: low
- Auto-detect covers nearly everyone; hand-edited config is a niche, once-only task with a clear doc page.
- A status list that is a guess is the Sessions-pill trap: nothing to act on.
- The real pain, "why no diagnostics?", is usually a missing binary or a disabled setting; only the live session knows.

## Best surface, if done
Section in the OMP screen Configuration tab: validated editor for user `lsp.json` / `dap.json`, labelled "applies to new sessions". Size S (raw editor with syntax check) to M (schema validation plus project scope). No pill.

## Risks and costs
- Invalid definitions are ignored with only a log warning, so an editor without validation looks broken.
- Guessed status misleads.
- Ongoing drift as OMP adds server fields.

## Recommendation: skip
Cheap alternatives: Help-tab link to the LSP config doc, and let item 40 expose the switches. Revisit only if Paseo can send `lsp status` to a live omp session (Paseo change); then a read-only status row could earn its place.

Unverified: real `lsp status` output; real-world `lsp.json` usage frequency; whether host tools could expose this upstream.

## Paseo check (2026-11-05)
- Paseo already has: nothing for LSP or DAP. Grep of app, server, protocol, docs and CHANGELOG finds only OpenCode permission keys (`providers/opencode/options.ts` L33) and ACP being "like LSP". The OMP provider (0.15.0 to 0.15.2 unchanged) only classifies the `debug` tool call for rendering (`tool-call-mapper.ts` L161), no status or reload RPC. No registry plugin for LSP/DAP found.
- Not in Paseo: lsp.json/dap.json editing, live LSP status, sending `reload` to a running omp session. This stays the documented gap in GAPS.md.
- Effect: recommendation unchanged (A, skip).
- Unverified: a registry plugin that edits provider config files generically; searches turned up none.
