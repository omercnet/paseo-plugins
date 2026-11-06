# Item 17: Consult a past session (seance)

## What it is
OMP can fork a past session's transcript into a read-only "consultant" helper. You ask it a question ("why did we pick this retry design last week?") and it answers from that old conversation, reading the old session's files in place. It edits nothing and leaves your current session alone.

Entry points:
- `task` tool with `agent: "seance"`, `sourceSession`, and a question. The model calls it, so any agent can do this if the user says "consult session X about Y".
- `/seance [id|path]`, TUI only. Opens a picker, takes no question argument, drops you into a consultant chat.
- `/resume @claude|@codex` imports a Claude Code or Codex session into OMP.

Users: people on long projects who lose context between sessions. Occasional, not per-message.

## What users get today
- Paseo has agent list, history and Import session, which reopens an old session as a live agent.
- Paseo runs Claude and Codex as their own providers, so importing them into OMP is rare.
- The `task` route should already work by plain request in a built-in omp agent; the result shows as a task card. Not run; inferred from docs.
- The plugin has no session-consult surface (its Sessions pill was removed).

## Works with the built-in provider?
- `task agent: "seance"`: yes. It is a model tool call inside the session, no RPC needed. Not available in plan mode.
- `/seance` and `/resume @claude`: unverified, likely no. RPC runs some builtin slash commands through `prompt`, but the docs do not list these and the pickers are interactive.
- A plugin could send a templated prompt through its own daemon session (the plugin docs say handlers can send prompts). A composer-prefill API was not found (unverified).

## Value: low to medium
Real use case, but occasional, and it already works in plain language. The gap is only discoverability and knowing the session path, which Paseo exposes in `persistence.nativeHandle`. Import session covers "continue that old work". The foreign-import half is low.

## Best surface (if built)
An "Ask a past session" Command Center item: pick a past agent, type a question, the plugin sends one prompt to the current agent ("Use task agent seance with sourceSession <path> to answer: <question>"). No pill, no provider. Size S to M.

## Risks and costs
- Spends tokens; the consult uses the source's old model unless overridden, and that model may be unavailable.
- Id lookup is current-project only; other projects need explicit paths.
- Answer lands as a task card in the timeline; may be noisy.
- Drift: the template depends on the `task` tool shape (`sourceSession`, `solutionSpace` are required).

## Recommendation
Skip a dedicated surface for now. At most mention the plain-language prompt in the plugin Help tab. Revisit if users ask for cross-session recall. Skip foreign `/resume` import (Paseo handles Claude and Codex natively).

## Paseo check (2026-11-05)
- Paseo already has: Import session and agent history; no seance surface. `seance` and `resume` are not among the 96 commands the built-in omp provider advertises on the 0.15.0 test daemon, so only the model-driven `task agent: "seance"` route exists. Plugins can send a templated prompt: `@getpaseo/client` 0.15.0 `agents.ref(id).send(text)` (`dist/index.d.ts:298`) from a Command Center item (`public-docs/plugins/reference.md` "Command Center items"), so option C is buildable without a provider.
- Community plugins: Transcript Search (search active and archived Paseo transcripts), Memorise and Contextualise (shared facts across agents).
- Not in Paseo: asking a question of a past session.
- Effect on the decision: recommendation unchanged (A). Transcript Search covers finding the old session; asking it remains a plain-language prompt.
- Unverified: the seance task route end to end (the mock model cannot call tools).
