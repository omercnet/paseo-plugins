# Item 16: /share, /dump, /fresh

## What it is
Three OMP slash commands:
- `/share`: uploads an encrypted, secret-redacted snapshot of the session and returns a link (`my.omp.sh/s/<id>#<key>`). The key stays in the URL fragment. Capped at 1 MB; big sessions get trimmed.
- `/dump` (and `/dump all`): the full model-facing transcript as text, including system prompt and tool list, plus a JSON file of the exact LLM request in the OS temp dir. `all` makes a zip with subagent transcripts. Used for debugging "why did the model do that" and for bug reports.
- `/fresh`: drops the provider-side stream state (prompt cache, server conversation id) and keeps the visible conversation. Recovery for a wedged provider stream. Rejected while a turn is streaming.

Users: someone sending a transcript to a teammate (`/share`), an OMP bug reporter or prompt debugger (`/dump`), someone whose provider keeps erroring (`/fresh`). All occasional.

## What users get today
Verified in Paseo source (`providers/omp/agent.ts`): any slash command that Paseo does not handle itself (it handles compact, autocompact, handoff, steer, follow-up) goes to OMP as a normal `prompt`. OMP's `command_output` frames are rendered by Paseo as an assistant message in the timeline. OMP publishes its built-in commands through `available_commands_update`, and Paseo maps them into the composer slash menu. So typing `/share` in a built-in omp agent should already return the link in the timeline. [UNVERIFIED end to end: I did not run it, and I did not confirm that these three names are in the advertised list.]

Our plugin has a support report (`paseo-omp.get-support-report`, 64 KiB cap) that collects plugin, provider and config health. It has no session dump and no share.

## Works with the built-in provider?
Mostly yes, already, with no plugin: the commands travel through `prompt`. What the plugin cannot do is send them on the user's behalf. A button (Share, Reset stream) needs the plugin client to send an agent message, which I did not find in the plugin docs. [UNVERIFIED whether a plugin client can send a prompt to an agent.] Our canary uses a daemon client for this, not the plugin API. For a plugin-built dump, the session file path is readable, but it would be our own lesser reimplementation, not OMP's `/dump`.

## Value: low
- `/share` and `/fresh` already work by typing. A button saves typing a few characters, for rare events.
- "Reset stream after repeated errors" needs us to detect repeated failures and then act. Detection is possible (turn failures), but acting needs a prompt send. A timeline notice saying "try /fresh" is the only safe piece, and error text may already say so.
- `/dump` in the support report: the plugin cannot run it on a built-in agent. A reimplementation duplicates OMP.

## Risks and costs
- Privacy: `/share` uploads session content to a third-party host (`my.omp.sh`) by default. A one-click button makes accidental leaks easier. Redaction is on by default but opaque payloads are dropped, not guaranteed clean.
- `/dump` leaves files in /tmp containing raw context and possibly secrets. Embedding it in a support report that users paste around is a leak path.
- Drift: command behavior and output format are OMP's and change without notice.

## Best surface if built
None justified. If anything: a one-line hint in the Help tab ("Type /share, /dump, /fresh in the composer"), size S. No pill.

## Recommendation
Skip as features. Optionally add the Help-tab hint. Revisit a Share button only if Paseo itself exposes a way for plugins to send agent messages and users ask for it.

Note for other items: whether a plugin client can send a prompt to an agent decides several items (any "button that runs a slash command"). Worth one shared check.

## Paseo check (2026-11-05)
- Paseo already has: `share`, `dump` and `fresh` are in the built-in omp slash menu with OMP's descriptions (live list of 96 commands from the 0.15.0 test daemon via `agents.ref(id).commands()`; mapping in `providers/omp/commands.ts`). `/dump` typed there worked: it printed the transcript and the path of the LLM request JSON in /tmp. Plugins can send agent messages: `@getpaseo/client` 0.15.0 `agents.ref(id).send(text)` (`dist/index.d.ts:298`), reachable from `usePaseo()` and Command Center callbacks (`public-docs/plugins/reference.md` "Use the Paseo SDK"). Community: Thread Share, Agent Share.
- Not in Paseo: nothing else; `/share` and `/fresh` were not run (third-party upload; mock model).
- Effect on the decision: recommendation changed from B to A. The slash menu already lists all three with descriptions, so a Help tab line adds no discoverability. Option C's precondition (plugins can send messages) is now met, but a Share button still adds privacy risk for little gain.
- Unverified: `/share` and `/fresh` end to end.
