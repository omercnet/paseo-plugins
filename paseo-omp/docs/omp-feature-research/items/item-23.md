# Item 23: Custom subagents (list, edit, per-agent settings)

## What it is
OMP agents hand work to subagents through the `task` tool. OMP 18.13.1 ships six (task, sonic, scout, reviewer, security-reviewer, seance); the bucket list names four. Users can add their own as markdown files with frontmatter (`.omp/agents/*.md` per project, `~/.omp/agent/agents/*.md` per user), turn agents off with `task.disabledAgents`, and set per-agent overrides: model, service tier, prewalk, advisor, compaction threshold, account pool, request budget. The terminal `/agents` hub manages all of it.

Who: power users tuning subagent cost, or teams with their own subagents, mostly at setup.

## What users get today
- The plugin's routing editor (OMP screen and workspace panel) edits four of the seven override records (model, tier, prewalk, advisor), with a model picker. Agent names are free text.
- `task.disabledAgents` and the compaction, account pool and budget records show read-only (checked in code).
- No agent list and no agent file editor anywhere in the plugin.
- `/agents` is not among the 82 slash commands OMP advertises over RPC (checked on 18.13.1).
- Agent files are plain markdown; users can ask the agent to write one.

## Works with the built-in provider?
Yes. It is all files: agent markdown and `config.yml`. Per OMP docs (not tested), OMP reloads settings and rediscovers agent files before each subagent spawn, so edits reach the next spawn, even in a running session. The model's agent list is built at session start, so a new agent may not be offered until a new session. No live RPC command is needed.

## Value: low
- The knob most users want, a cheaper model per subagent, already exists.
- Setup-time and rare. Disabling bundled agents, or per-agent pools and budgets, is niche.
- A list alone repeats the Sessions pill lesson: nothing to act on.

## Best surface and size
The existing routing editor. No new tab, no pill.
- S: agent-name dropdown on the override rows, plus on/off switches for `task.disabledAgents`.
- L: a full Agents tab with a frontmatter editor and an override table.

## Risks and costs
- Drift: OMP has no agent list command (`omp agents` only has `unpack`, which can enumerate bundled names into a temp folder). Listing everything means copying its discovery rules: project folder, user folder, extension packages, Claude marketplace plugins, bundled set. The frontmatter also has many fields and changes often.
- Safety: per docs, disabling `task`, the default agent, fails every spawn that names no agent. An empty account pool blocks the agent. Frontmatter `tools` and `spawns` grant capabilities.

## Recommendation
Skip for now. If users ask, do the small routing-editor add-on.

## Unverified
- Reload timing above is from docs only.
- Whether OMP flags an override keyed to an unknown agent name.
- Whether typing `/agents` in a Paseo chat does anything.

## For other items
`/settings` is also absent from OMP's advertised RPC commands (checked), so terminal-only hubs may not be reachable from Paseo chat.

## Paseo check (2026-11-05)
- Paseo already has: the built-in OMP provider (`providers/omp/subagent-index.ts`, `subagent-card-tracker.ts`, `agent.ts` ~L786) subscribes to OMP subagent events and renders running subagents in the core Subagents track and panel (title, description, model, status; CHANGELOG 0.15.0 own-panel change, #8276). That covers observing subagents, not configuring them.
- Not in Paseo: any agent-definition list or editor for OMP (`.omp/agents`, `task.disabledAgents`) or overrides. Only Copilot custom agents get a selector (`docs/providers.md` L45). No registry plugin found covering OMP agent files.
- Effect: recommendation unchanged (A, skip). Live subagent visibility is already served; the routing editor stays the only config surface.
- Unverified: whether `/agents` does anything in chat. Paseo's OMP handled-command list (`commands.ts`) has only compact, autocompact, handoff, steer, follow-up.
