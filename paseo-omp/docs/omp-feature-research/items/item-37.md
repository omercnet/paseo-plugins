# Item 37: Compaction (when and how to compact, per model)

## What it is
Long chats fill the model's context window. OMP then "compacts": it replaces old history with a summary or a cheaper local reduction. Three knobs shape this:
- `compaction.modelThresholds`: per-model trigger, e.g. `deepseek/*: 90000` (compact around 90k tokens), `"f90000"` (exactly 90k), or `"60%"` of the window.
- `compaction.methodOrder`: which strategies to try, in order. Default is `remote`, `snapcompact`, `handoff`, `shake`, `soft`.
- `extendedContext`: opt in to larger windows (and long-context pricing). A big enough per-model base also opts that model in.

Users: power users running long sessions on models with a small or unreliable window, or who want to control cost and quality of summaries. Most users never touch it; the defaults (reserve-based trigger, async background summarizing, native server compaction when available) are tuned already.

## What users get today
- Paseo: built-in omp provider already sends `compact` and `set_auto_compaction`; compaction rows show in the timeline (item 20 covers richer rows). Per-agent model picker exists.
- Our plugin Configuration tab already groups every `compaction.*` setting from `omp config list` under a "context" group, with a docs link. Booleans, numbers and enums edit generically: `extendedContext`, `compaction.enabled`, `thresholdPercent`, `thresholdTokens`, `reserveTokens`, `idleEnabled`, etc. Verified in code (`shared/omp-settings.ts`, `client/omp-config-surface.tsx`) and via `omp config list`.
- Not editable today: `compaction.methodOrder` (array) and `compaction.modelThresholds` (record). Only the routing paths (`modelRoles`, `retry.fallbackChains`, `cycleOrder`, a few more) have typed array/record editors.

## Works with the built-in provider?
Yes. Pure config-file edits via the plugin; OMP applies them to new sessions and to agents after reload. No RPC needed. Not applied live to a running agent (unverified in this run beyond the brief's stated behavior).

## Value: low
- The one real gap is the two structured keys. A per-model threshold is useful, but only for the few who hit small-window or provider-capped models, and the failure mode is visible (OMP compacts or errors).
- Scalar knobs that cover most needs already exist in the editor.
- Choosing a threshold needs model window knowledge; OMP's own `/models` preview (shows where each model compacts) and its warning on extended-window opt-in are terminal-only. A plain text box in Paseo would lack that guard rail, and mistakes (opting into long-context pricing by accident) cost money.
- Method order is expert tuning with sparse payoff; defaults already fall through gracefully.

## Best surface and size
If done: extend the Configuration tab's typed editors (no pill, no new screen). `methodOrder` as an ordered multi-select (S). `modelThresholds` as a per-model row table with parsing for `300k`, `f400k`, `80%` plus a warning when the base exceeds the standard window (M, needs the model window list; unverified that the plugin has window sizes handy). Total M.

## Risks and costs
- Drift: value syntax (`f` prefix, `*` only at end, project config overriding global, hub refusing edits) is changing OMP behavior; copying validation risks going stale.
- Cost surprise from accidental extended-window opt-in.
- Maintenance for a rarely used editor.

## Recommendation
Skip a dedicated build. Existing generic editor already covers the common toggles and numbers. Revisit only if users report compaction trouble on specific models.

## Cross-item note
Item 20 (compaction details timeline row) is the higher-value compaction surface; it shows users what actually happened, which a threshold editor cannot.

## Paseo check (2026-11-05)
- Paseo already has: compaction rows for manual and automatic compaction (`providers/omp/event-mapper.ts:214-245`, `agent.ts:1950-1965`), `/compact` and `/autocompact on|off` handled by the built-in omp provider (`agent.ts:1265-1280`), and context-window usage from OMP session stats (`usage-poller.ts:24-30`). All in 0.15.0 (checked in the installed `@getpaseo/server@0.15.0` dist). A custom omp profile can launch `omp --config <overlay.yml>` (`docs/custom-providers.md:439`, omp 18.13.1), so per-model thresholds can be set per profile by hand.
- Not in Paseo: any threshold or method-order setting for omp. Community plugins Context Compact and Auto Compact for Claude target Claude Code only.
- Effect on the decision: recommendation unchanged (A).
- Unverified: whether the Paseo compaction row shows the method or token counts (item 20).
