# Item 26: Sources matrix (what OMP imports from Cursor, Claude, Copilot, ...)

## What it is
OMP reads other tools' files so existing projects work unchanged: Claude (`.claude`), Codex, Gemini, Cursor (`.cursor/rules`, `.cursorrules`, MCP), Windsurf, Cline (`.clinerules`), Copilot (`.github/copilot-instructions.md`, `.github/instructions`), plus OpenCode and plugin sources. Each source is a "discovery provider". Project files load by default. User-level foreign files (`~/.claude`, `~/.codex`, ...) load only if listed in `enabledProviders`. `disabledProviders` turns a source off entirely and always wins. Both are one shared id list with model providers (`google` vs `gemini`), and a project array replaces the global one. See `omp://context-files.md`, `omp://settings.md`.

Who and when: someone with a repo that has `.cursor` or `.claude` leftovers who wonders "why did the agent follow this rule / show this command / start this MCP server". Occasional debugging, not daily.

## What users get today
Nothing that shows where things came from. The typed settings editor lists `enabledProviders` and `disabledProviders` only as raw arrays with a docs link. In the terminal, `/extensions` shows it.

## Works with the built-in provider?
Partly, without our provider, by spawning our own `omp --mode rpc --no-session` in the workspace cwd (same trick as item 24). Verified on a test tree with `.cursor`, `.clinerules`, `.windsurf`, `.claude` files:
- Cursor always-apply rule and a Cursor glob rule appeared in the system prompt; skills and `.claude/commands` appeared in `available_commands_update`.
- Disabling `cursor` through a `--config` overlay removed both Cursor rules. Switches work as documented.
- **Gap:** the prompt and command list do not say which source a thing came from (commands only say `file` or `skill`). The only per-source attribution is `omp ttsr list --json`, which reports `provider` and path, but only for rules with a trigger (TTSR), not always-apply rules, skills, commands or MCP. So "why did this `.cursor` rule load" needs the plugin to scan the known paths itself. That copies OMP's discovery rules, which change often. Unverified: Cline and Windsurf rules did not show up in my probe (likely trigger or format requirements); MCP server listing from a Cursor source; user-level opt-in behavior.

## Value: low-medium
The matrix is a 7x5 grid, but most cells are empty for any real user (typical: Claude plus Cursor). The real pain is two cases: a stale foreign file silently shaping the agent, and enabling `~/.claude` skills. Both are served better by the per-feature tabs already proposed (Rules, Skills, Context files), which can show a source chip. A matrix writes global arrays whose replace-not-merge rule can silently re-enable sources in a project. The toggle itself is tiny and rarely used.

## Best surface and size
Not a standalone tab. Fold into the other config views as a "Source" chip plus one "Sources" card in the OMP screen Configuration tab: a list of the 7 sources with on/off, and user-level opt-in, scope shown (global vs project, path-scoped entries read-only). Size S for the toggles (typed array editor exists), M if per-item provenance via file scanning. No pill.

## Risks and costs
- Provenance means duplicating OMP's path conventions; drift risk.
- Writing `disabledProviders` hits the shared namespace and array replacement trap; must write the layer the user sees and warn on project override.
- Disabling `native`/model ids by mistake breaks models.

## Recommendation
Later. Ship the Rules, Skills and Context-files views first with a source column from OMP's own output (`ttsr list` provider, `available_commands_update` source). Add a small Sources toggle card only if users ask. Skip the full matrix.

Related: item 22 can use `omp ttsr list --json` for source and builtin vs user in one call.

## Paseo check (2026-11-05)
- Paseo already has: nothing for OMP sources. Core grep (app, server, docs, v0.15.0 to main) finds no provenance view. The built-in provider drops command `sourceInfo` and keeps only a skill or command kind (`packages/server/src/server/agent/providers/omp/rpc-types.ts:187-195`, `commands.ts:38-74`).
- Community: `koinzhang/customize` 0.4.0 (`customize/server/providers/omp.ts`) shows OMP instructions, rules, skills and MCP per file path, and tags foreign-tool files `legacy`. That covers Cursor rules and MCP, `.claude` skills and CLAUDE.md, `.codex`, and Copilot instructions. It is read-only. It ignores `enabledProviders` and `disabledProviders`, so a disabled source still shows as active, and it has no Windsurf, Cline or Gemini paths for OMP.
- Not in Paseo or plugins: per-source toggles, and correct handling of `disabledProviders`.
- Effect on the decision: unchanged (B). The "where did this come from" half already exists as a community plugin. A Sources toggle card stays the only unique piece and remains "only if users ask".
- Unverified: Customize output on a real tree with `.cursor` files.
