# Item 21: Skills (list, turn on or off, edit)

**Verdict: low value. Recommendation: later, as a small Skills section in the planned Rules tab. No editor, no chip, no pill.**

## What it is
A skill is a folder with a `SKILL.md`: name, one-line description, instructions. OMP finds skills in 11 kinds of source (`~/.omp`, `~/.agents/skills`, a project's `.claude/skills`, plugins, the skills.omp.sh registry). Every visible skill's name and description goes into each session's prompt. The model reads the full file when a task matches, or the user types `/skill:<name>`. Skill-pack users run them often; turning one off is occasional, for example when a pack does not suit a project.

## What users get today
- **List and run: covered.** OMP reports each skill as a `skill:<name>` command (45 in this repo). Paseo's built-in provider tags them as skills and shows the typed `/skill:<name>` in the timeline, not the expanded body (daemon code). A "Use skill" chip adds nothing.
- **Coarse switches: covered.** The Configuration tab reads `omp config list --json`, so it already edits `skills.enabled`, the per-source switches and `skillful` (drops the skill list from the prompt).
- **Gaps:** where a skill came from, and per-skill off. `skills.ignoredSkills` and `disabledExtensions` are lists, which the typed editor skips.

## Works with the built-in provider?
Yes, no RPC command or Paseo change. `omp skill list --json` in the workspace folder returns name, description, path, source (`agents:user`, `claude:project`, ...), hidden flag and warnings. Off means adding a name or glob to `skills.ignoredSkills` (tested: `hyperframes*` removed exactly 9). Applies to new sessions and after a reload.

## Value: low
- The 43 visible skills here add roughly 3,700 to 6,000 tokens per session prompt (my `omp toks` estimate). Small, and `skillful` already removes it.
- Listing and running are covered. Per-skill off is occasional; "ask the agent" or a one-line edit does it.
- Unlike rules, skills are not silent: they act only when read or invoked. Collisions are rare (0 of 45 here). Editing `SKILL.md` is rarer still.

## Best surface and size
A Skills section inside the Rules tab: name, description, source, level, on/off. S once Rules exists (shared list-setting writes), M alone. No new tab, no pill.

## Risks and costs
- **Turned-off skills vanish from `omp skill list`**, and a `--config` overlay did not change it (tested). Off rows must come from the ignore lists (names or globs only) or from re-implementing OMP's discovery. Small upstream ask: an include-disabled flag.
- **A project list replaces the user list** (tested): ignoring one skill at project level silently re-enables the user's ignored ones. The UI must copy the list or warn.

## Recommendation
Later: fold into the Rules tab when it ships. Skip the editor, chip and pill.

## Not verified
How the Paseo composer menu draws skill commands, and a live `/skill:` prompt through the built-in provider (daemon code and docs only).

Related: item 26 explains why a project's `.claude/skills` load.

## Paseo check (2026-11-05)
- Paseo already has: the composer slash menu lists OMP skills from `get_available_commands` and `available_commands_update`, tagged kind `skill` when OMP's source is `skill` (`packages/server/src/server/agent/providers/omp/commands.ts:38-74`). Skills also complete inline, mid-sentence (`packages/app/src/utils/agent-command-autocomplete.ts:79-83`, `hooks/use-agent-autocomplete.ts:217-235`). The typed `/skill:<name>` is echoed instead of the body (`custom-message.ts:16-33`). Same code in installed 0.15.0, unchanged to v0.15.2. Core "Orchestration skills" (`public-docs/skills.md`, 0.15.0) only installs Paseo's own skills.
- Community: `koinzhang/customize` 0.4.0 (Paseo >= 0.15.0) has an OMP scanner (`customize/server/providers/omp.ts`). It lists skills per root with project or user scope, a `legacy` tag for `.claude`/`.codex`, a status (disabled via `skills.ignoredSkills`, `disabledExtensions: skill:*`, off-by-default gates), token estimates and a preview. It is read-only. `gpambrozio/skills` 0.4.0 lists and invokes, but for OMP shows only the session list.
- Not in Paseo or plugins: an on/off write. Customize merges list layers, while OMP replaces them, so it can be wrong.
- Effect on the decision: unchanged (B), narrowed. Provenance is covered by Customize, so the Skills section only adds on/off and correct layering.
- Unverified: live menu rendering; Customize on a real OMP home.
