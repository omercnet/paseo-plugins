# Item 29: Slash command authoring

## What it is
OMP custom slash commands are markdown files. `review-pr.md` in `<project>/.omp/commands/` or `~/.omp/agent/commands/` becomes `/review-pr`. Frontmatter gives a description and argument hint; the body is a prompt template with `$1`, `$ARGUMENTS` and similar. Users who repeat the same prompt (review, release notes, triage) write these once.

Commands also load from Claude, Codex, OpenCode and `.agents` folders, OMP plugins and marketplaces. Name clashes resolve by fixed provider priority: OMP native (project over user), plugins, Claude, Codex, OpenCode. Losers are dropped silently. Built-in names are reserved.

## What users get today
- Paseo's composer completes slash commands for omp agents from OMP's `get_available_commands` list. For the built-in provider this is unverified.
- Authoring is "create a markdown file"; any editor works.
- Nothing shows which commands exist per source or which are shadowed. That is the only real gap.

## Works with the built-in provider?
Mostly yes. It is file-based and daemon-side, like the settings editor. Showing shadowed duplicates means re-implementing OMP's precedence by globbing roots, because the RPC list contains only winners. `side: true` does nothing over RPC (runs as a plain prompt). Whether running agents pick up new files without a reload is unverified.

## Value: low
- Writing a command is rare and one-time, and users who do it are power users with an editor.
- A shadowed command is a rare mistake; most people have a handful of commands.
- The warning is only useful if correct. Precedence spans many providers, opt-ins and settings (`enabledProviders`, `commands.enableClaudeUser`, `disabledExtensions`). A wrong warning is worse than none.
- It needs the same multi-root discovery engine as items 21 (skills), 23 (agents), 24 (context files) and 26 (sources matrix).

## Best surface and size
Only as a read-only "Commands" section inside a shared discovery tab built for items 21 and 26: name, source chip, path, shadowed flag, open file. No pill. Small (S) on top of that engine; a full editor is L and not worth it.

## Risks and costs
- Drift: provider list and precedence change with OMP releases.
- Safety: editing prompt files that run with the user's authority.
- Building it alone duplicates the shared engine.

## Recommendation: skip as a standalone feature
Fold a read-only commands list with shadow flags into the skills and sources work if that proceeds. No editor. Upstream ask for that group: an RPC catalog that includes shadowed entries.

Note for other items: per the docs, queued steer and follow-up calls do not expand file commands; only a full `prompt` does.

## Paseo check (2026-11-05)
- Paseo already has: the slash menu shows OMP commands for built-in agents from `get_available_commands` and the `available_commands_update` event (`packages/server/src/server/agent/providers/omp/agent.ts:1245-1250`, `:1712-1715`), with the description and argument hint. Paseo also prepends its handled commands (compact, autocompact, handoff, steer, follow-up; `commands.ts:5-36`). OMP's `sourceInfo` is parsed but dropped (`rpc-types.ts:187-195`), so the menu shows no source. Same in 0.15.0 and v0.15.2. Plugins can add client slash commands, and provider commands win on name clashes (`docs/plugins.md:4`, `use-agent-autocomplete.ts:215-224`).
- Community: provider-agnostic prompt libraries (yannelli Prompt Manager, `paseo-prompt-kit`, `lefos13/workspace-snippets`) cover "reuse a prompt" without OMP files. `koinzhang/customize` has a Commands tab for some providers, but its OMP scanner skips commands.
- Not in Paseo or plugins: an OMP command list with source and shadowed duplicates.
- Effect on the decision: unchanged (B). The running half (list and run winners) is fully covered. The shadow view is unique but low value.
- Unverified: live menu for a `.omp/commands` file; `sourceInfo` contents.
