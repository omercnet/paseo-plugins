# Item 02: Show what the advisor costs

## What it is
The advisor is a second model that reviews the main agent's work and leaves notes (blocker, warning, etc). Its calls are billed separately. OMP emits `advisor_cost_changed` when the running advisor spend changes. The idea: a cost chip next to the advisor notes.

Who and when: only people who turned the advisor on and want to know if the second reviewer is worth its price.

## What users get today
- Advisor notes already render in the timeline as an "Advisor" block, plus an "Advisor review completed" notice. Cost is not shown.
- Advisor spend is counted in OMP session cost and in spend caps (`session.maxCost`), so the main total is not wrong, just not split out.
- OMP itself offers `/advisor status` (per-advisor cost) and `omp stats`.

## Works with the built-in provider?
Partly, and not through the event. The `advisor_cost_changed` frame carries no documented payload in `rpc.md` (the plugin schema is an empty object; UNVERIFIED what OMP actually sends). The built-in provider does not forward it to plugins anyway. Route that works: on `agent.turn.after`, read the session's advisor transcripts (`__advisor*.jsonl`, documented to hold assistant turns with usage/cost) and append a timeline row. Their exact path and format were not checked (UNVERIFIED). Cost can also be asked via `/advisor status`, which needs a live RPC command, so that needs our provider or a Paseo change.

## Value: low
- The advisor is **off by default in RPC hosts** (`advisor.*` protocol default is disabled), so most Paseo users never see an advisor note.
- Users who enable it are power users already editing config; the cost is a nice-to-know, not a decision point.
- It is already inside the session total and the cost cap.

## Best surface and size
If done at all: one line in the timeline after the advisor completion notice ("Advisor spent $0.04 this turn, $0.31 total"), built from the advisor transcript files. Size M (file parsing, format drift risk) for a low-value line. No pill.

## Risks and costs
- Depends on undocumented transcript layout; drift from OMP.
- Extra file reads each turn.
- Noise for the few advisor users.

## Recommendation: skip
Revisit only if the Advisor roster tab (item 34) ships; a cost column fits naturally there (read-only, from the same files) and costs little extra.

Note for item 34: the roster editor is the right home for any advisor cost display.

## Paseo check (2026-11-05)
- Paseo already has: advisor notes mapped to a timeline tool row "Advisor, N notes, M blockers" (`providers/omp/advisor-message.ts`, used from `agent.ts` and `history-hooks.ts`). Session cost in the context meter hover from `rpc get_session_stats` polling (`providers/omp/usage-poller.ts`), which should include advisor spend (inference, since OMP counts it in session cost).
- Not in Paseo: `advisor_cost_changed` is not handled anywhere in `providers/omp/*.ts` (v0.15.2). No advisor cost split. Plugin hook `agent.turn.after` (`public-docs/plugins/hooks.md`) receives the timeline, so a plugin could append a row, same as the earlier plan.
- Registry: `duegin/stats` has a "model roles" view over OMP sessions, which may split advisor model spend (unverified).
- Effect on the decision: unchanged (B stays reasonable); with item 34 recommended skip, B has no home, so A (skip) is equally fine. Left as B.
- Unverified: whether session cost in the meter includes advisor spend; duegin/stats role split.
