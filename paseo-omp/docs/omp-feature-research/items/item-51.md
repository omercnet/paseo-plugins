# Item 51: `omp stats` and `omp usage clients --days N`

## What it is
Two OMP reports about spend.
- `omp stats` reads every OMP session log on the machine and builds totals: requests, tokens, cost, cache hit rate, error rate, speed. It breaks them down by model, project folder, agent type (main vs subagent), tool, and time. It also has a browser dashboard on port 3847, plus `--json` for machine output.
- `omp usage clients --days N` shows token burn per **auth-broker client** (other machines or apps sharing one OMP login through the broker/gateway). It only has data when the broker is in use.

Users: anyone paying per token or watching a subscription, asking "where did my money and tokens go this week, which model or project?" Checked in bursts, not per message.

## What users get today
- Paseo shows per-agent usage display (token and context numbers). It has no cross-agent, cross-time rollup by model or project. [partly unverified: exact Paseo usage UI]
- The plugin's Accounts tab shows logins with live-ish quota and banked resets, and the Quota pill reads `usage_history` from `agent.db` (limit windows, not spend).
- Nothing in Paseo or the plugin shows spend history or cost by model/project.

## Works with the built-in provider?
Yes. No RPC needed. Both are CLI/file reads on the daemon host:
- `omp stats --json` verified on the demo dir: it syncs session files into `stats.db` and prints JSON with `overall`, `byModel`, `byFolder`, `byAgentType`, `timeSeries`, `modelSeries`, and more. Fields include cost, `unpricedRequests`, `cacheSavings`.
- `omp usage clients --days 30` verified: with no broker it prints "No per-client usage recorded yet". It has no useful output for most users.
- Caveat: `omp stats` writes `stats.db` and may call the judge model for the "frustration" panel (only for the dashboard, not `--json`; unverified for `--json`). Use `--json` only.

## Value
- `omp stats` rollup: **medium**. Cost-by-model and by-project is a real question, and Paseo cannot answer it today. It is occasional use, and cost is $0 for subscription/OAuth logins, so it helps mostly API-key users. Data covers terminal-started sessions too, so it is the one view of all OMP spend.
- `omp usage clients`: **low/none**. Needs a broker gateway setup; rare.

## Best surface
A "Usage" tab on the existing OMP screen: period selector (7/30/90 days from `timeSeries`), totals, tables by model and project, cache savings, and a "unpriced requests" note. Rendered from `omp stats --json` via a server RPC with caching. No pill, no timeline row. Size: **M** (RPC + cached JSON parse + tab; no charting needed beyond a simple bar series). A cheap alternative is a Command Center item that opens `omp stats` dashboard URL, but it binds to loopback on the daemon host, so it fails for remote/mobile users.

## Risks and costs
- Drift: `omp stats --json` shape is not a documented contract; validate with a schema and fail soft.
- Runtime: first sync of a large history may take seconds; needs a timeout and caching.
- Misleading numbers: subscription users see $0; OAuth plans need a "not billed per token" label. Pricing peers (e.g. MiniMax) are estimates.
- Side effects: `stats.db` is written in the OMP dir.
- Overlap risk: Paseo upstream may ship its own usage dashboard; ours would then be redundant.

## Recommendation
**Later / narrow expose.** Skip `usage clients`. If we build anything, do the Usage tab from `omp stats --json` after the Rules and Accounts-style higher-value items, because it is occasional and mostly useful to API-key users.

Other items: item on `usage --history` / quota trend (limit windows over time) could share this tab.

## Paseo check (2026-11-05)
- Paseo already has: per-agent session cost in the context-window hover/sheet (`packages/app/src/components/context-window-meter.tsx`, fed by the OMP usage poller `providers/omp/usage-poller.ts`; v0.15.0 to v0.15.2 unchanged). Core Usage modal and sidebar item show plan quota windows only, no spend history (`docs/glossary.md` Usage source / Usage report; `public-docs/plugins/reference.md` Usage sources).
- Community plugins already cover spend rollups (registry, checked today): `duegin/stats` (cost and tokens by provider, model, project; 24h/7/30/90 days/all/custom; reads `~/.omp/agent/sessions`, uses OMP's logged cost, ledger in `~/.paseo/plugin-data`), `aborakati/usage-monitor` (history by provider or model, reads OMP session files), `nerveband/provider-usage`. Option C would duplicate duegin/stats nearly feature for feature.
- Not in Paseo: cache savings and unpriced counts from `omp stats --json`; `omp usage clients`.
- Effect on the decision: recommendation changed from B (Later) to A (Skip). The "if Paseo ships its own usage view" trigger is met in practice by the registry. Optional: mention duegin/stats in a Help line.
- Unverified: duegin/stats not installed or run; its OMP numbers vs `omp stats`; whether `usage-monitor` OMP history is accurate.
