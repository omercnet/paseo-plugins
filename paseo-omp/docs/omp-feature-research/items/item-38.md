# Item 38: Retry and fallback settings ("Resilience" group)

## What it is
When a model provider fails (rate limit, quota wall, outage), OMP retries and can switch to a backup model. Six settings steer this:
- `retry.fallbackOn`: which failures may switch model (`any`, only `usage-limit`, or everything `except-usage-limit`).
- `retry.modelFallback`: master switch for model switching (default on).
- `retry.usageAwareFallback`: before a turn, if a coding-plan quota is nearly used, move to another account or fallback model (default off).
- `retry.waitForUsageReset`: wait out a quota reset instead of failing (default off; holds subagents).
- `retry.fallbackRevertPolicy`: return to the primary model after cooldown, or stay on the fallback.
- `retry.fallbackChains`: the ordered backup models (the part people actually care about).

Users: people on quota-limited coding plans or flaky providers, mostly on long unattended runs. Set once, rarely touched.

## What users get today
Almost all of it already exists in the plugin (checked in `paseo-omp`):
- `retry.fallbackChains` has a structured row editor in the Configuration tab (role or model, fallback list with a model picker).
- `retry.waitForUsageReset`, `retry.usageReservePct`, `retry.usageReservePolicy` are plain-language rows in the Accounts tab.
- Every other `retry.*` setting (`enabled`, `maxRetries`, `modelFallback`, `fallbackOn`, `usageAwareFallback`, `fallbackRevertPolicy`) is shown generically in the Configuration tab's Model category, with OMP's own descriptions (confirmed via `omp config list --json` on a demo dir).
So item 38 is a regrouping of settings that are already editable, not new capability.

## Works with the built-in provider?
Yes for config: plain `omp config set`, applies to new sessions and, after reload, running agents. OMP's docs say routing edits apply to subsequent fallback decisions without a host restart.
Live part (seeing a fallback happen): OMP emits `retry_fallback_applied` and `auto_retry_*`, but only our provider turns them into rows. For built-in agents a plugin could read the session file after a turn: `model_change` entries carry `resolvedModelIsFallback`, so a "Switched to X after provider error" row via `agent.turn.after` is plausible (same mechanism as the rule-fired notice). Unverified.

## Value: low
- Everything editable is already editable; the gain is nicer labels and grouping.
- Settings are set-and-forget, in a rarely opened screen.
- Fallback chains are the real lever and already have a proper editor.
- The one thing missing from the user's view is "why did my agent change model?" That is a timeline notice, and it is small, but its value depends on whether Paseo already shows the model change (unverified).

## Best surface
If anything: (a) a "Resilience" section header in the Configuration tab with plain labels for the four unlabelled settings (S); (b) optionally a "fell back to X" timeline row from the session file (S to M, needs verifying that the session file is written reliably and the row is not duplicated by Paseo's model display).
No pill.

## Risks and costs
- Duplicates Accounts tab rows if we group `waitForUsageReset` and reserve settings again; settings in two places drift.
- `fallbackOn` semantics are subtle (subagents and advisors included, refusals handled specially); a toggle with a short label invites misconfiguration.
- Session-file row: depends on OMP's private file layout.

## Recommendation
Skip the dedicated group. Do at most the cheap relabel when someone is in the Configuration tab anyway (bundle with items 36/37). Verify separately whether a "fell back to model X" notice is worth a row; that is the only user-visible gap.

Related: item 9 (retry events, `abort_retry`) is the live counterpart and needs a Paseo change.

## Paseo check (2026-11-05)
- Paseo already has: the built-in omp provider turns OMP's `auto_retry_start/end`, `retry_fallback_applied` and `retry_fallback_succeeded` events into timeline status rows: "OMP retry N/M, Retrying in Xs: <error>", "OMP fallback applied for <role>: from -> to", "OMP fallback succeeded for <role>: Using <model>" (`packages/server/src/server/agent/providers/omp/event-mapper.ts:51-212`). Present in 0.15.0 (found in the installed `@getpaseo/server@0.15.0` dist `event-mapper.js`). It also maps `model_changed` (`agent.ts:1655`).
- Not in Paseo: editing any `retry.*` setting.
- Effect on the decision: recommendation unchanged (A), and stronger. Option C ("Switched to X" row from the session file) is already done by Paseo itself, so it should not be built. Item 9 (retry events) was not re-checked here; the event rows exist, an abort-retry action was not looked for.
- Unverified: rows not observed live (the mock model does not fail).
