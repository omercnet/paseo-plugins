# Item 14: Composer shell (`!cmd`, `bash` / `abort_bash`)

**Verdict: low value as a plugin feature. Skip; optionally raise upstream in Paseo.**

## What it is
In OMP's terminal UI, typing `!ls` runs the command locally and records the output in the session so the model sees it on the next turn. `!!ls` runs it but hides the output from the model. In RPC mode the same thing is the `bash` command (concurrent, with `abort_bash` to cancel) and the result is stored as a `bashExecution` message. No model turn is spent. Users reach for it mid-conversation: "here is the failing test output", "what branch am I on", without asking the model to spend a tool call.

## What users get today
- Paseo workspaces already have real terminals, so running a command (and watching it live) is covered. `!!` semantics (run something for yourself) is fully covered.
- What is missing is only the "run it and put the output in the agent's context without a model turn" part. Today a user pastes output into the message box, or asks the agent to run it.
- The plugin does not use `bash` (`omp-rpc-protocol.ts` marks `bash` and `abort_bash` as `unsupported`). It already normalizes `bashExecution` messages in history, so they render if they ever appear (e.g. after Import session of a terminal session that used `!`).

## Built-in provider?
- Not as a true `!cmd`. The built-in provider cannot send RPC `bash`, so output cannot be recorded as a `bashExecution` in the live session. Only our own `omp-plugin` provider could, which we are retiring.
- Partial workaround (unverified, not built): a plugin client slash command (`/sh <cmd>`) that runs the command on the daemon host in the agent's cwd and appends a timeline row via `timeline.append`. That row is display only. The model would not see it, which defeats the point. Making it visible means sending it as a prompt or steer, which costs a model turn, i.e. the same as pasting.
- Writing the session file directly to inject a `bashExecution` entry into a live session is fragile and could corrupt state. Not recommended.
- Real fix is in Paseo: a `!` prefix in the composer handled by the omp provider (add `bash`/`abort_bash` to the provider's command set). It is a generic idea (Claude Code also has `!`), so it belongs in core, not a plugin. Whether Paseo already has or plans such a feature is unverified (a quick web search found nothing).

## Value: low
- Terminal exists; the gain is saving one model turn on occasional output sharing.
- Frequent enough for terminal power users, but Paseo users with a terminal panel have an adequate path.
- No safe plugin-only version exists.

## Best surface / size
If upstream accepts: composer `!` prefix in Paseo core, size M on the Paseo side (provider command, abort wiring, timeline row, cwd and busy handling). Plugin work: none. No pill.

## Risks and costs
- Safety: arbitrary shell from a text box on a remote daemon, with no approval flow; needs the same trust thinking as terminals.
- Drift: `bash` is dispatched concurrently and responses are matched by `id`; `!cd` can move the session cwd, refused while streaming; busy state blocks fork. More edge cases to mirror.
- Output size and secrets land in model context and the session file (cost and leakage).

## Recommendation
**Skip in the plugin.** Do not build a `/sh` look-alike. Optionally file an upstream ask: "composer `!cmd` for omp provider via RPC `bash`/`abort_bash`".

Note for other items: the plugin already normalizes `bashExecution`/`pythonExecution` history rows; item 44 (`eval`) can reuse that path.

## Paseo check (2026-11-05)
- Paseo already has: workspace terminals; no `!` composer prefix in `packages/app/src` (grep for shell mode found nothing). The built-in omp provider never sends RPC `bash`/`abort_bash` (no match in `packages/server/src/server/agent/providers/omp/`, main). Live on the 0.15.0 test daemon, `!echo bang-shell-test` went to the model as a plain prompt, and `bash` is not among the 96 advertised slash commands.
- Community plugins already build option C: Shell Yeah (`/sh`, live output in chat, agent sees it only if you send it, 128 installs) and Terminal Integration (runs code blocks in a Paseo terminal and sends output back to the agent).
- Not in Paseo: recording command output in OMP context without a model turn.
- Effect on the decision: recommendation unchanged (A), stronger: option C exists as Shell Yeah, so we would build a duplicate. Option B is an upstream ask; GAPS.md only.
- Unverified: Shell Yeah and Terminal Integration on a built-in omp agent.
