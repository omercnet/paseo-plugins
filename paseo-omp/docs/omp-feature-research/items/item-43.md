# Item 43: Live CI status from the OMP `github` tool (`run_watch`)

## What it is
OMP's `github` tool wraps the `gh` CLI. Its `run_watch` op lets the agent wait on GitHub Actions for a commit or run: it polls every 3s then 15s, streams progress, and on failure returns the last N log lines per failed job plus a full-log artifact. `pr_checkout` checks a PR out as a git worktree under `~/.omp/wt`. Source: `omp://tools/github.md`.

Who and when: someone who tells an omp agent "push and wait for CI, fix what fails". The bucket-list idea is a live CI card (job chips, failed-log tail) for that tool call, and opening OMP's PR checkouts as Paseo workspaces.

## What users get today
Paseo already covers almost all of this, for every provider:
- Sidebar workspace rows can show PR and checks status (changelog: "Choose what a sidebar workspace row shows: host, pull request, checks").
- Pull request pane with checks, "outcome summaries and failure-first grouping" (#3483), hover card breakdown.
- "Attach ... failed check logs to chat from the PR panel" (#1400). This is the failed-log tail, with a one-click path to the agent.
- PR checkout as a new Paseo worktree, and pasted PR links become a checkout option (#2290).
- Our own `pr-radar` plugin adds a cross-workspace PR and checks inbox.

The only gap: inside the chat, a `run_watch` call shows as a generic tool row while it waits.

## Works with the built-in provider?
- Card: in principle yes, as a client timeline renderer that recognizes the `github` tool call and draws its result. [UNVERIFIED] whether the built-in omp provider forwards the structured `details.watch` object and the streaming `onUpdate` snapshots, or only the final text. If only final text, the card is a parse of the text after the wait ends, so not "live".
- PR checkout as Paseo workspace: OMP creates the worktree itself, outside Paseo's worktree manager. Adopting it would mean a plugin watching tool results and creating a Paseo workspace for a foreign path. Possible in theory [UNVERIFIED], but it duplicates Paseo's native PR checkout and creates two worktree owners for the same PR.

## Value: low
- `github.enabled` defaults to `false`; `run_watch` only appears for users who turned the tool on, have `gh` installed and authed, and ask the agent to babysit CI. Niche.
- The user-facing need (see CI state, see why it failed, feed logs to the agent) is already met by Paseo's PR pane, sidebar checks and attach-failed-logs, which work for all providers and without the agent spending a turn polling.
- A prettier tool row adds polish, not capability.

## Best surface if built
Client timeline renderer for the `github` tool call (status line, job chips, collapsible failed-log tail, link to the run). No pill, no tab. Size S if details reach the client, M if the text must be parsed. Skip the PR checkout part.

## Risks and costs
- Drift: renderer depends on OMP's private result shape or text format, which can change any release.
- Two sources of truth for CI (agent card vs PR pane) that can disagree in timing.
- Workspace adoption of `~/.omp/wt` paths risks orphaned worktrees and confusion with Paseo's own PR checkout.

## Recommendation
Skip. Point users at Paseo's PR pane and "attach failed check logs" instead. Revisit only if a broader "rich OMP tool cards" effort (items 41 to 49) builds a shared renderer framework and the built-in provider is confirmed to pass tool `details`; then this is a cheap add-on.

Note for item 40 (Tools panel): `github.enabled` is off by default, so any GitHub tool feature depends on that switch being discoverable.

## Paseo check (2026-11-05)
- Paseo already has: PR checks in sidebar rows, PR pane with failure-first grouping (#3483), attach failed check logs to chat (#1400), PR link to worktree checkout (#2290); all in `CHANGELOG.md` well before 0.15.0, all providers.
- Built-in omp maps `github` to a `plain_text` row with result text only; `details.watch` is dropped (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:144-177`, text from `tool-call-detail.ts:260-283`). Partial results stream as running updates through the same mapper (`agent.ts:1879-1886`), so `run_watch` progress text is already live in the row. Same in 0.15.0 and v0.15.2.
- Not in Paseo: a structured CI card for the agent's own tool call.
- Effect on the decision: recommendation unchanged (A). Option B's precondition ("built-in provider passes tool details") is now checked and false, so any card would parse text.
- Unverified: exact `run_watch` text format on a live run.
