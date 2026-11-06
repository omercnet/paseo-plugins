# Item 10: Fast mode, slow mode, prompt-cache warming

## What it is
- **Fast mode**: pay a premium for faster output (priority/ultrafast service tier). **Slow mode**: take a cheaper, lower-priority lane (flex tier on OpenAI/Google, or Claude's low-priority lane after a 5-hour limit). **Cache warming**: OMP quietly re-sends the last request just before the provider's prompt cache expires (one-token output), so the next real message does not pay a full cache miss. It only runs when the expected saving beats the refresh cost by $0.05.
- Users: anyone on subscriptions or API keys who watches cost or speed. Slow mode matters most when a Claude 5-hour limit is hit. `get_state.usageLimit` reports that (stage, reset time); today only Claude subscriptions produce it.

## What users get today
- Paseo has a **Fast** toggle for built-in omp agents (the only one of the three OMP sends).
- Our plugin already has a **Quota pill**, popover, and an Accounts tab that show quota windows and reset times (read from OMP's agent.db).
- The typed Configuration editor already covers `tier.*` and `providers.*` (`providers.cacheWarming`, `providers.anthropic.slowMode`) by prefix (`shared/omp-settings.ts`).

## Works with the built-in provider?
- **Settings route: yes.** All three are plain OMP settings, applied to new sessions and after reload. Defaults are already sensible (`cacheWarming: idle`).
- **Live RPC route: no.** `set_slow_mode`, `set_cache_warming` and the `usageLimit` field are not sent or read by Paseo's built-in provider; `get_state` is called, but the plugin cannot see its output. Would need a Paseo change (unverified how large).
- `cache_warming_start/end` events are ignored, so no "warming now" signal.

## Value: low
- Cache warming is automatic, defaults on, and invisible when working; nobody needs to toggle it per message.
- Slow mode is rare and scenario-specific; Fast already exists in Paseo.
- A usage-limit banner is the only piece with real value (explains why an agent suddenly slowed or got throttled), but the data comes only from live `get_state`, which we cannot read. The Quota pill and Accounts tab already show reset times from the database.

## Best surface if built
- No pill. If anything, a one-line Help/Configuration note pointing at the three settings, or a Diagnostics line "Claude account in low-priority mode, resets at X" derived from agent.db (unverified whether the DB records the stage). Size S, speculative.

## Risks and costs
- Fast tier costs real money; semantics differ per provider and drift. A banner guessed from agent.db could show stale state.

## Recommendation: skip (revisit usage-limit banner only via upstream)
- Do nothing in the plugin. Optionally ask Paseo to surface `usageLimit` from `get_state` as a banner for all omp agents; that is where the user value is and it needs no plugin work.

## Unverified
- Whether agent.db records the usage-limit stage; whether Paseo already reads `usageLimit`; real-world frequency of the usage-limit state.

Related: items 51 and 11.
