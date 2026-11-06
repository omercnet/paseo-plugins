# Item 39: Lists and maps the editor can't change

## What it is
Seven OMP settings that hold a list or a map rather than a switch or a number. All confirmed present in `omp config list --json` (omp 18.13.x, isolated dir):
- `enabledModels`, `disabledProviders`, `enabledProviders`: allow/deny lists for models and providers. Entries can be plain names or path-scoped objects (`{path: ~/work, models: [...]}`).
- `modelProviderOrder`: which provider wins when two providers offer the same model id.
- `workspace.additionalDirectories`: extra folders every session can read, grep and glob (multi-root workspace; `/add-dir` does the same live in the terminal).
- `disabledExtensions`: ids such as `skill:<name>`, `extension-module:<name>`, `context-file:user:CLAUDE.md`.
- `edit.modelVariants`: model-name substring to edit mode.
- `providers.maxInFlightRequests`: cap on concurrent requests per provider.

Users: power users tuning routing, locking a project away from a provider, adding a sibling repo, silencing one skill or context file, or avoiding rate limits with many parallel agents.

## What users get today
The Configuration tab shows these values read-only. The typed editor only edits 7 structured keys (`modelRoles`, `cycleOrder`, `retry.fallbackChains`, `task.*`); `isEditableSetting` rejects every other array or record. Users edit `config.yml` by hand or use the terminal (`omp config set`, `/add-dir`, `/extensions`). Items 21, 24, 28 each want `disabledExtensions` handled by a purpose-built UI.

## Works with the built-in provider?
Yes. Plain settings-file keys, written through `omp config set <key> <json>`, the same path the editor uses now. Applies to new sessions and after a reload. Whether the built-in provider's model picker honors `enabledModels` is unverified. Path-scoped entries are read when the session's cwd matches, so they work per workspace.

## Value
Low to medium overall, uneven per key:
- `additionalDirectories`: medium. Paseo has no multi-root concept; this is the only way to give an agent a second folder. Terminal `/add-dir` does not reach a Paseo agent.
- `providers.maxInFlightRequests`: medium for heavy users. Many parallel Paseo agents on one account is exactly where 429s happen. Niche otherwise.
- `disabledExtensions`: low as a raw list (users can't guess ids). Valuable only inside an Extensions or Rules view (items 21, 24, 28).
- `disabledProviders`/`enabledProviders`: low. Shared id namespace mixes model backends and discovery sources (disabling `claude` also drops its MCP servers and skills), so a raw editor invites mistakes.
- `enabledModels`, `modelProviderOrder`, `edit.modelVariants`: low. Rare expert tuning; the routing editor and per-agent model picker cover the common need.

## Best surface
No pill, no new tab. A generic string-list editor and a flat map editor in the existing Configuration tab (S to M). Only edit lists made of plain strings; refuse or show read-only when a path-scoped object entry exists, so nothing is silently dropped. Add a dedicated field with path validation for `additionalDirectories`.

## Risks and costs
- Replace, not merge: a project list replaces the global list. A user adding one entry in a workspace override can accidentally re-enable everything in the global list. Needs an "effective value" hint.
- Path-scoped objects need round-tripping or a read-only fallback.
- Shared provider id namespace, wrong ids fail silently.
- Drift: new array keys appear each OMP release; a generic editor ages better than per-key UIs.

## Recommendation
Later. Do not build a generic editor now. Let `disabledExtensions` ship inside items 21, 24, 28. If users ask for more Paseo-side control, build the small generic editor, starting with `additionalDirectories` and `maxInFlightRequests`. Skip `enabledModels`, `modelProviderOrder`, `edit.modelVariants` entirely.

Unverified: whether the Paseo model picker respects `enabledModels`; how an agent reloads after `additionalDirectories` changes (said to be new-session only).

Note for items 21, 24, 28: the editor does not edit `disabledExtensions` today; it displays it read-only.

## Paseo check (2026-11-05)
- Paseo already has: no multi-root workspaces. The Claude provider has an `additionalDirectories` option (`packages/server/src/server/agent/providers/claude/options.ts:50`); the omp provider does not (`providers/omp/provider-config.ts:16-23`, v0.15.0 to v0.15.2). A custom omp profile can replace the launch command (`docs/custom-providers.md:439-464`), so `omp --add-dir=<path>` (repeatable) or `--config <overlay.yml>` (omp 18.13.1 `--help`) gives fixed extra folders or lists per profile, by hand in `config.json`. Community plugin Model providers (paseo.sh/plugins/hulkzzhou1/model-providers) manages endpoints and selected models for OMP, which touches `enabledModels`-style needs.
- Not in Paseo: an editor for any of these seven keys; no app UI for custom provider command or env.
- Effect on the decision: recommendation unchanged (B).
- Unverified: how Model providers writes OMP model lists.
