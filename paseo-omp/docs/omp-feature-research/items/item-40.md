# Item 40: Tools panel (one switch per optional tool)

## What it is
A single place in Paseo to turn OMP's optional built-in tools on or off: `github.enabled`, `security.enabled`, `generate_image.enabled`, `speechgen.enabled`, `computer.enabled`, `lsp.enabled`, `debug.enabled`, `ida.enabled`, `checkpoint.enabled`, `task.isolation.enabled`, and the `magicKeywords.*` switches. Users would use it once per machine or project, when they want GitHub/security/image tools that OMP ships off by default, or want to silence LSP/debug/magic keywords. The second half of the item is a plugin bug: `OMP_BUILTIN_TOOL_NAMES` in `paseo-omp/server/provider/config-normalization.ts` omits `wait`, `ida`, `generate_image`, `tts`, so our own provider throws `OMP cannot enforce unknown denied tools` when Paseo's `disallowedTools` names them.

## What users get today
Almost all of it. Verified with `omp config list --json` (omp 18.13.1, isolated dir): every key above exists and is a plain boolean. The plugin's Configuration tab reads that same command and renders every scalar with a typed control (`OmpSettingTypeSchema` has `boolean`). `categorizeOmpSetting` already files `github.`, `computer.`, `checkpoint.`, `debug.` under Tools, `lsp.` under Files, `task.` under Tasks, `magicKeywords` under Interaction. `security.`, `generate_image.`, `speechgen.`, `ida.` have no prefix and fall to General. So the switches exist; they are just scattered across five groups and `github.enabled` sits next to 30 unrelated keys.

## Works with the built-in provider?
Yes. These are settings-file keys, applied at session start. The OMP docs say `generate_image` and `speechgen` even reconcile live in a running session (unverified from Paseo). The `OMP_BUILTIN_TOOL_NAMES` fix only matters for our `omp-plugin` provider, which is slated for deprecation.

## Value
Low to medium. The capability is already shipped; the gap is discoverability. A user who wants GitHub or security scan today has to know the key name and hunt through the Configuration tab. A "Tools" row with ten labelled switches and one-line descriptions ("GitHub CLI tool, needs `gh` on PATH, off by default") closes that in a few minutes of reading. But it is a once-per-setup action, and the typed editor already gets the job done for anyone who searches.

## Best surface
Not a new panel and not a pill. Cheapest: fix categorization so the four stray prefixes (`security.`, `generate_image.`, `speechgen.`, `ida.`) land in Tools, and pin the `*.enabled` keys to the top of the Tools group with short descriptions. Size S. A separate "Optional tools" card on the Overview tab with the same ten switches would be M and duplicate the editor; skip unless the user wants it.

The `OMP_BUILTIN_TOOL_NAMES` fix is a two-line S change; worth doing only if `omp-plugin` provider stays alive another release, otherwise it dies with the provider.

## Risks and costs
- Drift: OMP adds or renames tool keys (e.g. `ratchet.enabled`, `archive.enabled` are already in the docs). A prefix list needs occasional upkeep; the typed editor itself does not.
- Safety: `security.enabled` and `github.enabled` unlock exec-approval tools; the editor already shows them, so no new exposure.
- `ida.enabled` is on by default but only matters with a local IDA install; a switch for it is noise for nearly everyone.

## Recommendation
Expose as a small regrouping in the existing Configuration tab (S): move the four stray prefixes into Tools, sort `*.enabled` first, add descriptions. Do not build a separate panel. Apply the `OMP_BUILTIN_TOOL_NAMES` fix only if the own provider ships again.

Unverified: live reconciliation of `generate_image`/`speechgen` through Paseo; whether the editor shows descriptions today (did not open the client component).

Note for item 35: `tools.approval` would be the natural neighbour of these switches if a Tools section is ever restructured.

## Paseo check (2026-11-05)
- Paseo already has: provider `disallowedTools` in config (`packages/protocol/src/provider-config.ts:28,62`); the built-in omp provider merges it (`packages/server/src/server/agent/providers/omp/provider-config.ts:159`) but never passes it to OMP at launch (no other use in `providers/omp/`, v0.15.0 to v0.15.2). A custom omp profile in `config.json` can replace the launch command (`docs/custom-providers.md:439-464`, `runtime.ts:97-105`), so `omp --tools=...`, `--no-lsp` or `--config <overlay.yml>` (omp 18.13.1 `--help`) work per profile. Paseo's own Paseo-tools and browser-tools cards only toggle Paseo's tools. No registry plugin toggles OMP tools.
- Not in Paseo: any UI listing OMP's optional tools; no app editor for custom provider command/env (`packages/app/src/screens/settings/providers-section.tsx`, `components/provider-diagnostic-sheet.tsx` only toggle, models, diagnostics).
- Effect on the decision: recommendation unchanged (A). Paseo gives only a hand-edited per-profile route.
- Unverified: whether built-in omp agents fail or ignore Paseo `disallowedTools` at runtime.
