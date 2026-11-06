# OMP bucket list for paseo-omp

Sources: the `omp://` docs (134 files, swept in 4 clusters) checked against `paseo-omp/server/provider/omp-rpc-protocol.ts` (`OMP_RPC_COMMAND_POLICIES`, event policies) and the shipped README/OVERVIEW. "RPC" means a command is defined in `rpc.md` but marked `unsupported` in the plugin today. `[UNVERIFIED]` means the doc doesn't say whether the feature works over RPC.

## Tier 1: Quick wins (event already received, or a single RPC command)

| # | Feature | Mechanism | Paseo surface |
|---|---|---|---|
| 1 | Rule fired notice (TTSR) | `ttsr_triggered` event, currently `ignore` | Timeline notice: "Rule `<name>` fired, stream rewound" |
| 2 | Advisor cost | `advisor_cost_changed`, currently `ignore` | Cost chip next to advisor notes |
| 3 | Queue chips | `queue_update` (ignored), `remove_queued_message`, `promote_queued_message`, `abort_and_restore_queue` | Queued steer/follow-up chips with Remove and Send now; Esc puts the text back in the composer |
| 4 | Goal mode | `goal {op: get/create/resume/pause/drop, objective, token_budget}`; `goal_updated` is already normalized. Needs `goal.enabled` and `goal.continuationModes` to include `rpc` | Goal pill/panel with budget meter, pause, resume, drop |
| 5 | Side question | `btw`, `btw_cancel`, `get_btw_history`; frames `btw_delta`, `btw_record` | "Quick question" popover on a running agent; streams, no transcript pollution |
| 6 | Export HTML | `export_html {outputPath?}` | Agent menu "Export transcript" (warn: unredacted) |
| 7 | Title sync | `set_session_name`, `get_state.sessionName` | Paseo agent rename syncs OMP session name |
| 8 | Fork from here | `fork {entryId?}` (fails with `session_busy` while running) | Message action "Fork into new agent"; keeps tool results and artifacts, leaves the parent untouched |
| 9 | Retry control | `set_auto_retry`, `abort_retry`; `auto_retry_*` already normalized | "Retrying 3/10 in 4s [Cancel]" chip |
| 10 | Fast / slow / cache warming | `set_fast_mode`, `set_slow_mode`, `set_cache_warming`; `get_state.fastModeActive`, `usageLimit` | Composer pills, plus a usage-limit banner with reset time |
| 11 | Cost cap | settings `session.maxCost`, `session.warnCost`; RPC error code `cost_cap` | Budget field on agent create; distinct "Budget reached" error with Raise limit |
| 12 | Editable todos | `set_todos` | Make the shipped todo panel editable (reorder, add, mark blocked) |

## Tier 2: Bigger session features over RPC

13. **Branch tree viewer.** `get_tree` and `get_entries` are read-only. Show siblings, labels, active path and branch summaries, with fork/branch from any node. In-file navigation needs `navigate_tree`/`set_label`, which `rpc.md` does not define (upstream ask).
14. **Composer shell.** `bash` / `abort_bash`: `!cmd` in the composer runs in the agent context and the output lands in the timeline.
15. **Warm process reuse.** `new_session`, `open_session`, `switch_session` can start agents in an existing OMP process instead of spawning a new one. Perf work, not UI.
16. **Share link / dump / fresh.** These are slash commands sent through `prompt`, with output in `command_output` [UNVERIFIED per command]. `/share`: Share button that returns the E2E link. `/dump`: "Attach OMP dump" in the support report. `/fresh`: "Reset provider stream" recovery action after repeated provider errors.
17. **Consult past session.** `/seance` or `task agent: "seance"`: a sessions-popover action. Foreign `/resume @claude|@codex` import as well [UNVERIFIED over RPC].
18. **Context notes mode.** `compaction.experimentalContextManagement` plus `context_notes`/`new_context`: a toggle and a notebook viewer (via `get_entries`).
19. **Checkpoint/rewind cards.** `checkpoint.enabled`: an "exploration scope" card that collapses into the rewind report.
20. **Compaction details.** Show method and `tokensBefore`/`tokensAfter` on compaction items. Show `savedPath` for handoffs.

## Tier 3: New config tabs (file-based, daemon-side read/write)

All live under `~/.omp/agent/` (or `~/.omp/profiles/<n>/agent/`) and `<cwd>/.omp/`, and reuse the existing store selector.

21. **Skills.** Glob the roots and show source, level and shadowed state. Toggle via `disabledExtensions: skill:<n>` / `skills.ignoredSkills`. Edit `SKILL.md`. "Use skill" chip inserts `/skill:<name>` (needs `skills.enableSkillCommands`).
22. **Rules / TTSR.** `.omp/rules/*.md|mdc`, `RULES.md`: buckets for always-apply, rulebook and TTSR, builtin vs user. Toggle via `ttsr.disabledRules`. Frontmatter form editor. Dry run via `omp ttsr test`. Pairs with item 1.
23. **Agents.** `.omp/agents/*.md` plus the bundled scout/reviewer/task/sonic: list, edit frontmatter, toggle via `task.disabledAgents`, plus a per-agent override table (model, advisor, prewalk, tier, account pool, compaction threshold). Reuses the routing editor.
24. **Context files.** Which `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` got injected and which were shadowed, with an inline editor and per-file disable (`disabledExtensions: context-file:<level>:<basename>`).
25. **Prompt files.** `APPEND_SYSTEM.md`, `SYSTEM.md` (warn: drops the default tool policy), `PERSONALITY.md`, `TITLE_SYSTEM.md`, `personality` setting.
26. **Sources matrix.** Rows: Claude, Codex, Cursor, Gemini, Windsurf, Cline, Copilot. Columns: context, rules, skills, commands, MCP. Switches write `enabledProviders`/`disabledProviders`. Answers "why did this `.cursor` rule load".
27. **Learned / managed skills.** `autolearn.enabled`, `<agent-dir>/managed-skills/`, `learned.md`: review, edit, delete, promote. Card on `learn`/`manage_skill` tool calls.
28. **Extensions and hooks inventory.** `.omp/hooks/{pre,post}`, `.omp/extensions`, `.omp/tools`: read-only list with load errors (`extension_error`) and a disable switch. Starter from the `safety-hook` example.
29. **Slash command authoring.** `.omp/commands/*.md`: editor with a source chip and shadowed-duplicate warnings.
30. **Marketplaces.** Extends the plugin manager: add/remove catalogs, Discover grid, user vs project scope, "update available" badge, Reload plugins (`/reload-plugins`), and what each plugin contributes.
31. **Custom providers (`models.yml`).** Add-provider wizard (baseUrl, api, auth, discovery for ollama/llama.cpp/lm-studio/litellm), plus `omp models refresh <provider>`.
32. **Secrets obfuscation.** `secrets.enabled` and `secrets.yml` entries `{type, content, mode, replacement}`: list editor that never echoes values.
33. **LSP / DAP.** `lsp.json`, `.omp/dap.json` editors, and a server status list via `lsp` `action: status|reload`.
34. **Advisor roster.** `WATCHDOG.yml`/`WATCHDOG.md` editor, `advisor.*` cadence settings, and an Advisor on/off pill (`/advisor on|off`, non-TUI returns text).

## Tier 4: Settings editor depth (non-scalar keys the typed editor skips)

35. **Tool policy editor.** `tools.approval` (per tool: allow/prompt/deny), ordered `bash.patterns` `{match, approval}`, `tools.restrictedFolders`, plus a Forget approvals button (`/forget-approvals`).
36. **Model presets.** `modelPresets` record: preset dropdown in the routing editor plus "Save current as" (`/modelpreset`).
37. **Compaction.** `compaction.modelThresholds` (`tokens`/`fN`/`N%`), `compaction.methodOrder`, `extendedContext` toggle.
38. **Retry.** `retry.fallbackOn`, `usageAwareFallback`, `waitForUsageReset`: a "Resilience" group in the routing editor.
39. **Arrays.** `enabledModels`/`enabledProviders`/`disabledProviders` (path-scoped object entries), `modelProviderOrder`, `workspace.additionalDirectories`, `disabledExtensions`, `edit.modelVariants`, `providers.maxInFlightRequests`.
40. **Tools panel.** One switch each for `github.enabled`, `security.enabled`, `generate_image.enabled`, `speechgen.enabled`, `computer.enabled`, `lsp.enabled`, `debug.enabled`, `ida.enabled`, `checkpoint.enabled`, `task.isolation.enabled`, `magicKeywords.*`. Also add `wait`, `ida`, `generate_image`, `tts` to `OMP_BUILTIN_TOOL_NAMES`; today `disallowedTools` throws on them.

## Tier 5: Rich tool cards

41. **`ast_edit`.** Staged diff preview with Apply/Discard that answers `xd://resolve`/`xd://reject` [UNVERIFIED how it renders today].
42. **`task` isolation.** Show `patchPath`/`branchName` on the task card with Apply/Discard. Revive button and per-child cost/tokens on the subagent row.
43. **`github` `run_watch`.** Live CI card with job chips and a failed-log tail. PR checkout opens as a Paseo workspace.
44. **`eval`.** Code cell, `views` (table/json/markdown), image output, workpool status.
45. **`browser`/`computer`.** Screenshot filmstrip card. Possibly point `app.cdp_url` at the Paseo Browser.
46. **`security_scan`.** Security tab: scans, phases, finding counts by severity, SARIF download, validate.
47. **`lsp` / `debug`.** File-grouped diagnostics card with severity; debugger stop-state card (stack, locals) with Continue/Step.
48. **`web_search`.** Sources list with links.
49. **`generate_image` / `tts`.** Gallery with download; audio player.
50. **Magic keywords.** Composer highlight of `ultrathink`/`orchestrate`/`workflowz`/`jevify` with a "will add..." tooltip.

## Tier 6: CLI wrappers (separate `omp` process, no RPC needed)

51. **`omp stats`, `omp usage clients --days N`.** Usage dashboard.
52. **`omp tiny-models list|download`, `omp setup speech`.** Local models tab with download manager and role assignment.
53. **`omp auth-broker status|migrate --dry-run`, `omp auth-gateway status|check`.** Broker health in Accounts, plus per-agent account pools (`task.agentAccountPools`).
54. **`omp gc`.** "Free disk space" button. **`omp update [--stable|--canary]`.** Update button next to the version diagnostic.
55. **Memory.** Backend switcher, scoping, editable rows (`memory_edit` semantics), "Consolidate now" (`/memory enqueue`), stats (`/memory stats`). Today the panel reads `mnemopi.db` read-only.

## Skip / low value

- `/collab`, `omp stream`, `/record`: Paseo already syncs clients; RPC sessions have no screen.
- Keybindings, theme, `statusLine.*`, `tui.*`: TUI only.
- `/vibe`: documented as interactive-TUI only and blocks fork/handoff [UNVERIFIED over RPC]. Worth an upstream ask rather than a workaround.
- `live_*` voice, dictation: needs a Paseo audio path.
- `omp worktree`: overlaps Paseo worktrees.

## Upstream asks (OMP)

- RPC `navigate_tree` and `set_label` (needed for item 13 to navigate in-file instead of only forking).
- RPC catalogs for skills, rules, agents and context files. Today a UI has to re-implement discovery precedence by globbing.
- Confirm which builtin slash commands are safe over RPC `prompt` (`/share`, `/dump`, `/fresh`, `/seance`, `/advisor`, `/prewalk`, `/modelpreset`, `/extended-context`, `/vibe`).

## Suggested order

1. Tier 1 items 1-5 and 11: smallest diffs, user-visible, and they use events and commands that are already parsed or defined.
2. Tool policy editor (35) and Tools panel (40): each one closes a common "how do I turn X on/off" gap.
3. Skills, Rules and Agents tabs (21-23): the biggest discoverability win; OMP's best features are file-configured and invisible from Paseo today.
4. Tree viewer and fork (8, 13), `ast_edit` and task isolation cards (41, 42).
