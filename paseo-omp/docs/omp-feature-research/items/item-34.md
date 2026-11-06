# Item 34: Advisor roster

**Verdict: value low. Recommend skip (at most a Help tip).**

## What it is
The advisor is a second model that reviews the main agent's work in the background and injects notes ("nit", "concern", "blocker"). Concerns and blockers can interrupt the agent. `WATCHDOG.md` is free-text review guidance. `WATCHDOG.yml` is a roster of named reviewers, each with its own model, tools, instructions and cadence. Users: people who accept extra spend for an automated second opinion on long runs.

## What users get today
- Verified on `omp --mode rpc` (OMP 18.13.1): `/advisor on|off|status|dump` return text; status shows each reviewer's model, tokens and cost. Paseo's built-in provider passes them through, so they work from the composer (code read, not run in the UI).
- Advisor notes already render in the timeline as "Advisor, N notes, M blockers" (code read).
- Our OMP screen already edits every `advisor.*` setting, the advisor model role, the per-agent override and fallback chains (docs and code read).
- Not covered: `WATCHDOG.md` and `WATCHDOG.yml`.

## Works with the built-in provider?
Yes, no provider needed. Verified: `advisor.enabled: true` in OMP config turns it on in RPC sessions (off by default there), and a project `.omp/WATCHDOG.yml` roster is discovered. Roster edits reach new or reloaded agents only (`/advisor off` then `on` did not re-read the file, seen once). `/advisor configure` is terminal-only, so a file editor is the only other way to edit a roster.

## Value: low
- Niche and opt-in: off by default, needs a model, and the default cadence adds a review call on every tool round.
- Serious users set it up once in the terminal editor; the files are shared and Paseo picks them up.
- Paseo-only users can ask their agent to write the file (inference).
- The real gap is silent mistakes: a malformed entry is dropped, and an invalid roster silently becomes the single default advisor, with no warning to the host (verified).

## Best surface and size, if wanted
No pill: set once, and `/advisor on|off` exists. Cheapest: a Help tab note (S). Fuller: a Reviewers card with raw text editors for both files plus a "what OMP sees" check that runs `/advisor status` in a throwaway headless OMP (0.7 s, no model call, verified) (M). A form editor (L) is not advised.

## Risks and costs
- A form editor drifts with OMP validation and tool names, and loses YAML comments.
- Tool grants like `edit` or `bash` for a background model need trust; more reviewers multiply spend.
- The feature is changing fast, so copy and UI age quickly.

## Recommendation
Skip. If discoverability matters, add a Help tip only. Revisit if users ask for rosters.

## Unverified
Slash menu and timeline rows in the live UI; whether agents write valid rosters; whether anyone wants the advisor in Paseo.

Cross-reference: item 02's "later, with the roster tab" option has no home if this is skipped; `/advisor status` already reports cost.

## Paseo check (2026-11-05)
- Paseo already has: advisor note timeline rows (`providers/omp/advisor-message.ts`, v0.15.2). Slash commands come from OMP's own list plus Paseo-handled builtins (`providers/omp/commands.ts`), so `/advisor` reaches the composer if OMP reports it (code read, not run in the live UI).
- Not in Paseo: any WATCHDOG roster editing or advisor toggle; no handling of OMP config warnings (`config_warnings_changed` unused in `providers/omp/`).
- Registry: no advisor or OMP roster plugin found by search (not exhaustive).
- Effect on the decision: recommendation unchanged (A, skip). Plugin cost for a roster editor stays full price; nothing in Paseo to reuse.
- Unverified: `/advisor` presence in the live slash menu on 0.15.0.
