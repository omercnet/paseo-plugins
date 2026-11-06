# Item 42: Apply or discard a subagent's isolated work

## What it is
OMP's `task` tool can run a subagent in an isolated copy of the repo (a git worktree or filesystem clone) so parallel subagents do not trip over each other. When the subagent finishes, OMP captures its changes as a patch file (`patchPath`) or as a branch (`omp/task/<id>`, `branchName`) and merges them into the parent checkout. The bucket idea: show that patch or branch on the task card with Apply and Discard buttons, plus Revive and per-child cost on the subagent row.

Who would use it: someone running big parallel refactors who wants to review each subagent's work before it lands. Few users do this.

## What users get today
- Isolation is **off by default** (`task.isolation.enabled = false`, checked with `omp config list` on OMP 18.13.1). RPC hosts like Paseo pin neutral defaults for it too, so most Paseo omp agents never use it.
- When on, `task.isolation.apply` defaults to **true**: OMP merges changes itself. OMP has no Apply or Discard step to hook into. Apply/Discard would be a new Paseo flow, not an exposed OMP feature.
- Paseo already shows built-in omp subagents as child sessions (read-only), and the tool call result text. The plugin (our provider only) already adds steer/stop under each `task` card.
- The OMP Agent Hub (terminal only) shows patch paths, branch, cost and tokens per subagent and has a revive key. Paseo has no equivalent.

## Works with the built-in provider?
Partly.
- Read-only: patch path, branch and per-child usage can be read from the tool result and the subagent session files on the daemon host. Timeline transformers can render them. Yes.
- Apply: only by turning `task.isolation.apply` off in config (new sessions only), then the plugin runs `git apply <patchPath>` or a cherry-pick itself. Feasible on the host, but the parent agent is told nothing about the manual apply, and a patch that no longer applies after the parent keeps editing becomes the user's problem. Unverified end to end.
- Discard: just deleting the patch/branch. Trivial, but dropping work the parent already believes was merged is confusing.
- Revive: needs a live command into the session (the parent can only be prompted to `write agent://<id>`). Built-in provider cannot send it; needs our provider or a Paseo change.
- Per-child cost/tokens: Paseo's child sessions may already show usage; unverified.

## Value: low
- Feature is opt-in, off by default, git-repo only, and rare in practice.
- Paseo users already get a safe review path: Paseo workspaces are git worktrees, so changes can be reviewed with Paseo's own diff and git tools after the fact.
- Apply/Discard changes OMP semantics (auto-merge becomes manual) and invites state drift with the parent agent.
- Revive and cost parts are terminal-Hub features with no Paseo gap that users have asked about.

## Best surface if built
A timeline transformer on the `task` card showing patch/branch name and a copyable `git apply` hint (read-only). Size S. Full Apply/Discard with an apply=false toggle: M to L, plus a race and conflict story.

## Risks and costs
- Drift from OMP: result field names (`patchPath`, `branchName`, `nestedPatches`) can change.
- Safety: plugin writing into the user's working tree behind the agent's back.
- Needs a setting that changes agent behavior for everyone to be useful.

## Recommendation
Skip. If anything, revisit a read-only patch/branch line on the task card later. Revive needs Paseo or our provider and is not worth an upstream ask on its own.

Not verified: how Paseo renders task results with isolation today, because no isolated run was executed (no daemon lifecycle allowed).

Cross-item note: item 40 (tools panel) already lists `task.isolation.enabled`; a toggle there is the cheapest way to let users opt in.

## Paseo check (2026-11-05)
- Paseo already has: built-in omp subagents as child agents, shown as launch markers in the parent timeline from v0.15.2 (#8276, not in 0.15.0). No isolation handling in the provider: no `patchPath`, `branchName` or isolation fields in `providers/omp/` (main). Paseo's own answer to reviewing parallel work is a worktree workspace per subagent with diff review before merge (`public-docs/orchestration.md:13`, `public-docs/parallel-development.md`, `public-docs/orchestration-workflows.md:33`).
- Community: Turn Review (keep or undo file changes per turn with per-file diffs).
- Not in Paseo: Apply/Discard of OMP isolated task patches, Revive, per-child cost on the task card.
- Effect on the decision: recommendation unchanged (A). Users who want review-before-merge already get it by running Paseo subagents in separate worktrees.
- Unverified: how an isolated OMP task result renders in Paseo (no isolated run executed); per-child usage on Paseo child agents.
