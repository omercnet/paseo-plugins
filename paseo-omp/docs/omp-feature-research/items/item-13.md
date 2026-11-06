# Item 13: Branch tree viewer

## What it is
OMP stores a session as an append-only JSONL tree: every entry has `id` and `parentId`, the active conversation is the root-to-leaf path, and old paths stay in the file after a rewind, a `rewind` tool checkpoint, or a `/tree` jump (`omp://session.md`, `omp://tree.md`). In the terminal, `/tree` shows that tree with labels, siblings and the active path, lets you jump to any node inside the same file, and can attach a `branch_summary` of the abandoned path. A Paseo tree viewer would show the same picture for an agent and let the user jump or fork from a node.

Who: users who iterate on one agent for a long time, rewind often, or use the `rewind`/checkpoint tool. When: "which attempt am I on", "what did approach B say", "go back to before the refactor".

## What users get today
- Paseo already sends `branch {entryId}` for built-in omp agents and the plugin implements `branch` plus `get_branch_messages`. [INFERENCE] this backs Paseo's edit-and-resend / rewind on a user message. Note `branch` over RPC starts a new session file from a user message; it is not the in-file `/tree` move.
- Paseo's timeline shows only the active path. Abandoned siblings, labels and branch summaries are invisible. A `branchSummary` message is normalized as `ignore` in the plugin (`omp-rpc-protocol.ts:55`), so even the summary text never reaches the timeline.
- Item 8 (fork from a message) covers "start a fresh agent from here" separately.

## Works with the built-in provider?
- Read-only tree: yes, without RPC. The session file at `persistence.nativeHandle` has `id`/`parentId`/`timestamp`, `label` entries and `branch_summary` entries; the tree is exactly what `getTree()` projects (`omp://session-tree-plan.md`). A workspace panel can parse it on `agent.turn.after`. Caveat: the active leaf is "last physical entry" on reload, so a pointer-only move is only known once something is appended (unverified against a live file).
- Jump inside the file: no. `navigate_tree` and `set_label` are not in `rpc.md` (plugin lists them as `unsupported` placeholders). Needs an OMP upstream RPC and then a Paseo provider change. Two upstream asks before it works at all.
- Fork from a node: `fork {entryId}` exists in RPC but the built-in provider does not send it; needs a Paseo change (same blocker as item 8).

## Value
Low to medium. Branches exist only after rewinds or `rewind` tool use (`checkpoint.enabled` is off by default), so most Paseo sessions are a straight line and the panel would show nothing new. For the minority with branches, a read-only tree answers "what else did I try" but the user cannot act on it from Paseo; the Sessions-pill lesson applies. The actionable version (jump in-file, label, summarize) is blocked on two upstreams.

## Best surface
If exposed: a "Branches" section in the existing workspace OMP panel, hidden when the tree is linear. Nodes show role, first line, label, active-path marker, branch-summary text. Size S for read-only (M with fork once Paseo sends `fork`). No pill.

Cheap partial win: unignore `branchSummary` messages and render them as a timeline row ("Abandoned branch summary"). Size S.

## Risks and costs
- Re-implementing tree projection from raw JSONL drifts from OMP (entry types, migration rules, virtual root for multiple roots).
- Large sessions: parsing the whole file per turn; needs incremental read.
- Read-only list nobody can act on repeats the Sessions-pill mistake.

## Recommendation
Later. Ship only the S piece (render `branchSummary` rows) now. Revisit the tree panel once OMP exposes `navigate_tree`/`set_label` over RPC and Paseo sends `fork`; file the upstream asks. Do not build a read-only tree panel today.

Note for item 8: `fork {entryId}` is the same Paseo-side blocker; one upstream ask serves both.
