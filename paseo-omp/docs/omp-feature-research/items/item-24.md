# Item 24: Context files (AGENTS.md, CLAUDE.md, GEMINI.md)

## What it is
At session start OMP finds instruction files (`.omp/AGENTS.md`, standalone `AGENTS.md`/`CLAUDE.md` up the tree, `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, `.github/copilot-instructions.md`, user-level files) and injects them into the system prompt. Rules (`omp://context-files.md`): one user-level file survives, one project file per directory depth, and at the same depth the higher-priority source wins and the rest are silently shadowed. `disabledExtensions: context-file:<level>:<basename>` drops a file by name at every depth, and the file it shadowed then loads instead. In the terminal, `/extensions` lists them.

Who and when: a user asking "why is the agent ignoring my AGENTS.md?" Typical traps: a `.claude/CLAUDE.md` silently beats a package `AGENTS.md`; `~/.omp/agent/AGENTS.md` hides `~/.claude/CLAUDE.md`; foreign user files need `enabledProviders` opt-in; task subagents never get files named `AGENTS.md`; Paseo worktrees miss a gitignored `AGENTS.local.md` unless `contextFiles.extra` is set. Occasional, not daily.

## What users get today
Nothing that shows what loaded. The plugin's typed settings editor already lists `disabledExtensions` as a raw array, so disabling is possible if you know the id. Editing markdown files is already done in any editor or by the agent itself.

## Works with the built-in provider?
Yes, without our provider. Verified by hand: run `omp --mode rpc --no-session` in the workspace cwd, send `get_state`, read `systemPrompt`, extract `<file path="...">` entries from `<repo-rules>`. On a test tree (`AGENTS.md` at root, `pkg/AGENTS.md`, `pkg/.claude/CLAUDE.md`) it returned root `AGENTS.md` plus `pkg/.claude/CLAUDE.md`, showing `pkg/AGENTS.md` shadowed. With a `--config` overlay disabling `context-file:project:CLAUDE.md` it returned `pkg/AGENTS.md` instead. About 0.5s, no model call. This reuses OMP's own discovery, so no logic drift.

Limits: it shows what a new agent in that directory would load, not a live agent's exact prompt (the plugin cannot call `get_state` on a running built-in agent). "Shadowed" needs the plugin to also list candidate files by known names and diff against the winners; that is a small glob, not a reimplementation.

## Value: medium-low
Real debugging value when instructions are ignored, and the shadowing rules are genuinely non-obvious. But context files are user-written and known, unlike the 26 hidden built-in rules; the question comes up rarely. Inline editor: none (duplicates editors and the agent). Per-file disable toggle: low (niche; raw setting already editable, and the id disables every depth, which surprises people).

## Best surface and size
Read-only "Context files" section in the workspace OMP panel: loaded files in injection order with source, shadowed candidates greyed with "shadowed by X", click to open. Optional disable toggle later. Size S. Natural fit inside item 26 (Sources matrix) if that ships. No pill.

## Risks and costs
- Spawning `omp` per panel open: must use the daemon's `PI_CODING_AGENT_DIR`/profile, cache per cwd, refresh on demand. Whether MCP servers start during that headless spawn is unverified (a test dir with one stdio MCP server still answered in 0.5s).
- Parsing `<repo-rules>` from prompt text can drift if OMP changes the tag format.
- Disable toggles write global or project config; the "replaced, not merged" array rule can silently re-enable things.

## Recommendation
Later, as a small read-only section (or merged into item 26). Skip the inline editor. Skip the toggle unless users ask.

Unverified: MCP startup during headless spawn; `~/.paseo/worktrees` workspace walk behavior for standalone `AGENTS.md`.

Related to item 26: the same `get_state` probe can answer "which sources contributed" for the Sources matrix.

## Paseo check (2026-11-05)
- Paseo already has: built-in plugin `worktree-include` (`plugins/worktree-include/`, hook `worktree.create.after`, CHANGELOG 0.15.0, PR #8100) copies gitignored files listed in `.worktreeinclude` into new worktrees. That fixes the "worktree misses a gitignored `AGENTS.local.md`" trap without `contextFiles.extra`. Community Skills plugin (gpambrozio/skills, 0.4.0) lists skills with source, but it is skills only, not context files. Community "Agent Prompt Hub" (casonmo/agent-prompt) edits global prompt files for Claude/Codex/Pi/OpenCode, not OMP discovery or shadowing.
- Not in Paseo: any view of which context files an OMP agent loaded or which were shadowed. Core grep (app, server, docs) finds no context-file UI. The OMP provider (`providers/omp/`, 0.15.0 to 0.15.2 unchanged) does not surface `systemPrompt` or `get_state` data.
- Effect: recommendation unchanged (A, later, read-only). Drop the worktree trap from the case for this feature.
- Unverified: whether `.worktreeinclude` needs setup users do not have.
