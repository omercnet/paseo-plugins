# Item 25: Prompt files and personality

## What it is
Plain Markdown files in `~/.omp/agent/` (or a project `.omp/`) that change what OMP tells the model before every session:
- `APPEND_SYSTEM.md`: extra instructions added to the end of the default prompt. The safe, common one.
- `SYSTEM.md` / `SYSTEM_TEMPLATE.md`: replace the default instruction template. Drops OMP's tool policy, workflow and delegation rules. Power users only.
- `PERSONALITY.md` + `personality` setting (`default`, `friendly`, `pragmatic`, `none`): tone of replies. User-level only.
- `TITLE_SYSTEM.md`: how OMP names its own sessions.

Users: people who want house style ("answer tersely", "always run tests") across every OMP session. Set once, rarely touched.

## What users get today
- `personality` is already in the plugin's typed settings editor (model group, `shared/omp-settings.ts`).
- Paseo has its own host-level **Append system prompt** (Settings > host) that applies to every provider, and per-agent system prompts (voice mode, agents spawned by agents).
- `AGENTS.md` / `CLAUDE.md` project context already covers most "project rules" needs.
- No surface shows or edits the prompt files.

## Works with the built-in provider?
Yes for the files themselves: OMP reads them at launch, no RPC needed. A plugin can read and write them.

Important catch (verified): the built-in `omp` provider passes `--append-system-prompt` whenever Paseo has a host append prompt or an agent system prompt (`providers/omp/runtime.ts:151`). In OMP the explicit flag replaces a discovered `APPEND_SYSTEM.md` instead of adding to it (docs `system-prompt-customization.md`, and `appendSystemPrompt ?? discover()` in the 18.13.1 binary). So a user's `APPEND_SYSTEM.md` silently stops applying in Paseo once any Paseo prompt is set. `SYSTEM.md` and `PERSONALITY.md` are not affected.

`TITLE_SYSTEM.md` has no effect in Paseo: the built-in provider does not read OMP session titles; Paseo names agents itself.

## Value
Low. Set-once files, already editable in any editor, mostly used by terminal power users. Personality is covered. The only real user pain is the silent `APPEND_SYSTEM.md` override, and that only hits users who use both OMP's file and Paseo's prompt.

## Best surface
No pill, no editor. If anything: one Diagnostics check (S) warning "`APPEND_SYSTEM.md` found, but Paseo's Append system prompt overrides it", plus a note when `SYSTEM.md` is active ("default tool policy is off"). The plugin cannot see per-agent prompts; whether it can read the daemon's host prompt is unverified.

Proper fix is upstream: OMP concatenating flag and file. A one-line OMP issue, low priority.

## Risks / costs
- An editor for `SYSTEM.md` from a phone invites breaking every agent (drops tool policy). Do not build one.
- Prompt files load at launch; edits need a new session or reload, which confuses users.
- Drift: the check hardcodes OMP precedence rules that may change.

## Recommendation
Skip a dedicated surface. Optionally add the single Diagnostics warning (S). Keep `personality` in the settings editor as is.

Unverified: enum rendering of `personality` in the editor.

Other items: anything about Paseo host settings should note this `APPEND_SYSTEM.md` override.

## Paseo check (2026-11-05)
- Paseo already has: host-level Append system prompt (`daemon.appendSystemPrompt`, `packages/server/src/server/daemon-config-store.ts`, UI in `packages/app/src/screens/settings/host-page.tsx`, in the protocol config at `packages/protocol/src/messages.ts:245`), merged with per-agent prompts by `composeSystemPromptParts` and passed as `--append-system-prompt` (`providers/omp/runtime.ts:151-152`). Confirms the note's override finding on v0.15.2. No Paseo warning or merge with `APPEND_SYSTEM.md`.
- Extension point: `agent.create.before` can change the saved `config.systemPrompt` (`public-docs/plugins/hooks.md` lines 203-222). A plugin could append the file's text there, a real fix rather than a warning. Cost: it also bakes text into saved config (survives plugin removal) and double-applies if OMP later concatenates. Not recommended without a user ask.
- Not in Paseo: any prompt-file view, or a way for plugins to read the host append prompt (not found in `packages/plugin/src`; protocol config only).
- Effect on the decision: recommendation unchanged (A). Optional note on the hook path.
- Unverified: the hook path end to end.
