# Item 12: Editable todos (`set_todos`)

## What it is
OMP agents keep a todo list (phases with tasks: pending, in progress, completed, abandoned, blocked with a reason). `set_todos` replaces the whole list in the running session; it is saved on the session branch, like the terminal `/todo` edit. The docs pitch it for pre-seeding a plan before the first prompt. Users would use it to correct a plan mid-run: drop a task, reorder, add one, mark one blocked.

## What users get today
Paseo already renders the agent's todo list as a native timeline item (`omp:todos`, read-only). In the OMP terminal, `/todo` edits it as markdown; that is the only edit path. `set_todos` is `unsupported` in our own provider's command policy, so nothing edits todos in Paseo today. The user can steer by typing a message ("skip step 3"), which works in every provider.

## Works with the built-in provider?
No. It needs a live RPC command into the running session, and the built-in provider does not send `set_todos`. Needs a Paseo change (a provider method plus a UI affordance in the native todo item) or our own provider. A plugin cannot do it. Writing to the session file behind a running agent is unsafe (OMP owns it, and has no reload).

## Value: low
- Steering via chat already covers the intent, and the model sees it naturally. A UI edit is injected as a developer reminder anyway, so the model only learns of it on its next turn.
- Agents rewrite their own list constantly; a user edit can be overwritten on the next todo tool call. Race with a running turn is likely.
- No task IDs in the protocol, so reorder or edit means replacing the entire list; easy to clobber.
- Pre-seeding a plan before the first prompt is the real fit, but few users do that from a GUI.
- Todo lists are a progress readout, not something people curate.

## Best surface / size
If ever done: the native todo item in the timeline, in Paseo core (M-L, cross-provider design, touches the Paseo UI). Not a plugin surface. No pill.

## Risks
Drift from OMP's todo semantics (blocker field, auto-clear, branch restore). Edit races. Upstream UI work for a niche feature. Only works for omp, so a one-provider UI in core is hard to justify.

## Recommendation
Skip. Revisit only if users ask to seed or edit plans, and then as an upstream Paseo ask (provider `set_todos` plus an edit mode on the todo item), not a plugin feature.

Unverified: behaviour of `set_todos` while a turn is running (docs only say it replaces state); whether the agent overwrites edits.

## Paseo check (2026-11-05)
- Paseo already has: the native todo timeline item for built-in omp (`providers/omp/todo-mapper.ts`). OMP's `/todo` is in the built-in omp slash menu and edits work over RPC: on the 0.15.0 test daemon `/todo` replied "No todos. Use /todo append <task> to start one.", and `/todo append Paseo check task` added the task, which then showed in Paseo's Tasks item.
- Not in Paseo: an edit mode on the todo item, or a provider `set_todos` call (no match in `providers/omp/`, main).
- Effect on the decision: recommendation unchanged (A), stronger: editing already works by typing `/todo ...` in the composer, so option B is not needed even later.
- Unverified: other `/todo` subcommands (done, remove, reorder) over RPC, and whether the model overwrites a user edit on its next todo call.
