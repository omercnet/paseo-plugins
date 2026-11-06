# Item 04: Goal mode

## What it is
An OMP agent keeps working toward a stated objective across many turns without re-prompting, until it marks the goal done, a token budget runs out, or the user pauses or drops it. Terminal: `/goal` or `omp --goal "<objective>"`. RPC: a `goal` command (get/create/resume/pause/drop) plus `goal_updated` events. Users hand off a long, loosely bounded task and walk away, which is also where open-ended token spend is riskiest.

## What users get today
- Paseo loops, schedules and heartbeats cover "come back later", not "continue until the agent judges it done".
- Our `omp-plugin` provider shows `goal_updated` as a timeline row (objective, status, tokens, budget) but cannot send `goal` (marked unsupported in `omp-rpc-protocol.ts`).
- The typed settings editor already exposes `goal.*`. Default `goal.continuationModes` is `["interactive"]` (verified, omp 18.13.1), so goals do not auto-continue in Paseo's RPC sessions until `"rpc"` is added.

## Works with the built-in provider?
Mostly no. It cannot send `goal`, so no live create, pause, resume, drop or budget meter. Partial paths (all unverified):
- Plugin writes `goal.continuationModes` to include `rpc` (new sessions).
- Builtin slash commands run through `prompt` over RPC, so `/goal <objective>` typed in Paseo might work; the composer may not offer it.
- Paseo's Stop is an `abort`, which per the docs already pauses the goal. Resume would need `/goal resume` as text.
- Reading goal state from the session file is untested.
A real panel needs our own provider or a Paseo change to forward `goal` and surface `get_state.goal`.

## Value
**Low to medium.** Attractive for unattended work, but opt-in and niche, partly covered by prompts and schedules, and the live controls are exactly what the built-in provider cannot do. Our provider is being deprecated, so a panel built on it is throwaway. Autonomous continuation also adds cost risk.

## Best surface (if done)
No pill. Cheapest version: a settings-editor preset that sets `goal.enabled` and adds `rpc` to `goal.continuationModes`, with a cost warning (S), plus a goal status timeline row if the session file allows (S). A full panel with controls (M-L) only after Paseo upstream forwards `goal`.

## Risks and costs
- Unbounded spend without a budget.
- `rpc` continuation applies to every built-in agent, not one chosen run.
- OMP goal rules are intricate and still evolving (drift).

## Recommendation
**Later.** Build no panel now. Ask Paseo upstream to forward `goal` ops and expose `get_state.goal`, which would give all Paseo users a first-class goal UI. Meanwhile, at most add the settings preset after verifying `/goal` works as prompt text.

Unverified: `/goal` via built-in prompt, session-file goal journaling, composer slash-command discovery.
