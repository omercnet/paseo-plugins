# Item 30: Marketplaces (browse and add plugin catalogs)

## What it is
An OMP marketplace is a Git repo or folder with a catalog file (`.omp-plugin/marketplace.json`, or the Claude Code format `.claude-plugin/marketplace.json`). It lists installable plugins (skills, commands, agents, MCP servers, extensions). Users run `omp plugin marketplace add owner/repo`, then `omp plugin discover` to browse and `omp plugin install name@marketplace [--scope user|project]` to install. Catalogs can be added, removed and updated. Installed plugins can be upgraded. Anyone who wants to extend OMP with community plugins (for example the official Claude plugin catalog) uses it, once at setup and occasionally after.

## What users get today
The plugin's OMP plugins tab already lists installed plugins (npm and marketplace, with user/project scope) and offers install, enable, disable, uninstall and upgrade, all through `omp plugin ... --scope --json` (`paseo-omp/server/omp-plugins.ts`). The install box accepts `name@marketplace`.
Missing: adding or removing a catalog, listing catalogs, browsing what a catalog offers. So `name@marketplace` is a dead end in Paseo unless the user first added the catalog in a terminal. Paseo itself has nothing here.

## Works with the built-in provider?
Yes for everything that matters. It is pure CLI and files on the daemon host, no live RPC needed. Verified read-only with `PI_CODING_AGENT_DIR=/tmp/omp-demo-builtin`: `omp plugin marketplace list`, `omp plugin discover`, `omp plugin upgrade --dry-run` run fine and print plain text; `omp plugin list --json` returns `{npm, marketplace}`.
Not possible: `/reload-plugins` or a live reload of a running agent. New plugin content only reaches new sessions (and the plugin already says this in its success messages). Do not promise reload.
Unverified: whether `marketplace list` and `discover` have JSON output when catalogs exist (they printed text with `--json` on empty state), and the cached catalog layout under `~/.omp/plugins/cache/marketplaces`. I did not add a marketplace, since that writes state and needs network. Parsing text would be fragile; reading the cached catalog JSON is the likely route.

## Value
Medium-low. The gap is real (the install box cannot be fed without a terminal), but it is a rare, one-off setup action. Discover as a grid is the only part with browse value, and most catalog content is Claude-oriented skills, so fit with OMP is uneven. Update badges duplicate the existing Upgrade button. Risk side: marketplace plugins can load extension code with full host access, so a one-tap add and install flow needs a clear trust warning.

## Best surface
Existing OMP plugins tab, no pill, no new screen. Add a small "Catalogs" section: list, add by source, remove. Add a "Browse" list per catalog that fills the existing install box (scope selector already exists). Size S to M (M if catalog parsing is needed). Skip the grid, update badge and reload.

## Risks and costs
- Trust: installing third-party code; needs a confirmation naming the source and scope.
- Drift: marketplace CLI output is text, schema could change; prefer reading catalog files.
- Network and git fetch on the daemon host; timeouts and errors need handling.
- Project scope needs a cwd; the tab must handle no-project state (already does for installs).

## Recommendation
Expose narrowly (add/remove/list catalogs plus a browse list feeding install) in the OMP plugins tab. Skip Discover grid, update badge and Reload. If the team wants only high-value items, "later" is also defensible.

Related: item for the plugin manager itself (installed plugin list) is already shipped; no other item affected.

## Paseo check (2026-11-05)
- Paseo already has: a Paseo plugin registry (CLI `paseo plugin add owner/slug`, `docs/plugins.md` L136, `packages/server/src/server/plugins/managed-source/registry.ts`, 0.11+; paseo.sh/plugins lists 476). Community plugin Cafe (paseo-cafe/cafe) browses and installs from it in-app. These are catalogs of Paseo plugins, not OMP marketplaces.
- Not in Paseo: anything for OMP marketplaces (add/remove catalogs, browse, install by `name@marketplace`). Core grep for marketplace finds only unrelated ACP catalog text. Paseo UI and CLI have no generic extension point for another tool's marketplace; our plugin tab remains the only place.
- Effect: recommendation unchanged (A). Do not reuse Paseo registry or Cafe UI for OMP content; at most copy the Cafe browse interaction.
- Unverified: Cafe internals, and whether `omp plugin marketplace` has JSON output with catalogs present.
