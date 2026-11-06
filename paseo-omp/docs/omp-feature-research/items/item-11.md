# Item 11: Spending cap per agent

## What it is
OMP can stop a session from spending past a dollar limit. `session.maxCost` refuses new model requests once spend reaches the limit. `session.warnCost` warns once at a lower amount. Spend counts the session plus its subagents, side requests (compaction, handoff) and resumed history. Both are unset by default. Over RPC the stopped prompt ends with `error.code: "cost_cap"`; the server stays up and later prompts fail the same way until the cap is raised. Requests already in flight can finish past the cap.

Who wants it: people who leave agents running unattended, on phones or overnight, on pay-per-token API keys. Subscription users (flat rate) barely care.

## What users get today
Paseo shows usage per agent, but nothing stops a runaway agent. The plugin has no cost cap code (searched `paseo-omp` for maxCost, warnCost, cost_cap, budget: only unrelated byte budgets). The settings editor may already let users type the two keys (unverified; I did not check the editor's catalog).

## Works with the built-in provider?
Partly, and better than the brief assumes:
- Setting the cap: yes. A plugin can write `session.maxCost` to global `config.yml` or to a project file `<cwd>/.omp/config.yml`. OMP docs say changing either while a session is open applies to its next request, and RPC hosts watch these files. So "Raise limit" can be a file write, no RPC command needed (live reload unverified on a running Paseo agent).
- Granularity: global or per working directory, which in Paseo means per workspace/worktree. Not per agent. Two agents in one workspace share a file but each has its own spend counter.
- Budget field on agent create: not possible for built-in agents; the plugin does not own the create form or launch flags (`--max-cost` unreachable).
- "Budget reached" error: whether Paseo's built-in provider shows `cost_cap` distinctly is unverified. Likely it shows a generic error text. A plugin could detect it on `agent.turn.after` by reading the session file and append a timeline row with a Raise limit hint, but a timeline row cannot host a button unless Paseo supports actions there (unverified).

## Value
Medium. Real protection against surprise bills, but only for API-key users, and a hard stop mid-task can annoy. The default-off setting means most users never hit it. Warn is probably more useful than max.

## Best surface
No pill. Add Budget fields (warn, max, per workspace or global) to the existing OMP screen Configuration tab, plus a "Budget reached" timeline row via `agent.turn.after`. Size: S for the fields, M for the row and raise action.

## Risks
- Per-workspace file writes touch user repos (`.omp/config.yml` may be committed by accident). Prefer global.
- Spend accounting is OMP's; resumed sessions start from file totals, so numbers can differ from Paseo's usage display.
- Detecting the cap after the fact needs session-file parsing, which can drift with OMP versions.

## Recommendation
Expose a small version: global warn/max fields in Configuration, no per-agent field, no pill. Add the timeline row only if the built-in provider's own error text proves unclear. Ask Paseo upstream only if per-agent launch flags are wanted; not worth it now.

Unverified: editor already covers keys; live reload on a Paseo agent; Paseo's rendering of `cost_cap`; timeline row actions.

## Paseo check (2026-11-05)
- Paseo already has: per-agent spend from OMP session stats (`totalCostUsd`, `providers/omp/usage-poller.ts:24-30`), no cap of its own (searched server for maxCost, cost_cap, budget). A rejected prompt shows OMP's error message as a failed turn; `error.code` is ignored (`providers/omp/agent.ts:181-187`). OMP `notice` events become notifications (`event-mapper.ts:68-81`). A custom omp profile can launch `omp --max-cost=<usd> --warn-cost=<usd>` (both in omp 18.13.1 `--help`; `docs/custom-providers.md:439-464`), giving a per-profile cap with no plugin, by hand in `config.json`. Community Usage Monitor shows balances, not caps.
- Not in Paseo: an app field for caps, a raise-limit action, a distinct "budget reached" row.
- Effect on the decision: recommendation unchanged (A). Option B's row is less needed since OMP's own error text reaches the timeline. Worth one Help line on the custom-profile flags.
- Unverified: exact cost_cap and warnCost text in Paseo (not triggered live).
