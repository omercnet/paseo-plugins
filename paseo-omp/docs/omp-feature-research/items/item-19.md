# Item 19: Checkpoint and rewind cards

**What it is.** With `checkpoint.enabled` (default off), the model gets two tools. `checkpoint` marks the conversation ("exploring X"). `rewind` ends it: OMP drops everything explored since the mark and keeps only a short report. It is context hygiene for long investigations. It does not touch files (no git, no snapshot), so it is not an undo button. Users never call it; the model does.

**What users get today.** Both calls already show as ordinary tool-call rows in Paseo's timeline. The prune happens silently inside OMP. The only gap: nothing says "this investigation was collapsed into this report." The plugin only lists `checkpoint` and `rewind` as tool names and a settings prefix; no card exists.

**Built-in provider?** Yes, without any RPC command. Both are plain tool calls in the stream and the session file (`checkpoint` tool result, then `rewind` result with `details.report`, a `branch_summary` entry and a hidden `rewind-report`). A client timeline renderer can pair them, and the `agent.turn.after` hook can read the session file. The setting itself is a config write the plugin already supports. Nothing needs a live command.

**Value: low.** 
- The feature is off by default and the model chooses when to use it. Few users will enable it, and fewer sessions will use it.
- The raw tool rows already show the goal and the report text.
- A card changes no decision: there is no action to take (no restore, no file revert).
- The real benefit, smaller context, is already visible through Paseo's usage display.
- Risk of misleading users: "rewind" sounds like an undo for files, and it is not.

**Best surface if ever done.** A client timeline renderer that groups the checkpoint call, the collapsed steps and the rewind report into one folded row. Size M, mostly UI work to fold the intermediate tool calls. The on/off switch belongs in item 40's Tools panel (already asked), not here.

**Risks/costs.**
- Drift: depends on tool names and `details.report` shape in OMP.
- Grouping must handle an unfinished checkpoint, a missing checkpoint entry (rewind falls back to root), and resume.
- Needs the real session to verify; not exercised here.

**Recommendation: skip the card.** Cover the toggle via item 40. Revisit only if users report confusion about "missing" context. Unverified: how the built-in provider streams the `rewind` branch change to Paseo's timeline after the prune (not tested on a live agent).

**Other items.** Item 13 (branch tree) would show the `branch_summary` entry that rewind creates.

## Paseo check (2026-11-05)
- Paseo already has: built-in omp maps `checkpoint` and `rewind` to `plain_text` rows; the label uses `goal` / `report` args and the body is result text (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:144-177`). On reopen, history replays only the active entry chain and hides `branchSummary` messages (`history.ts:86-114`, `:496-505`). Same in 0.15.0 and v0.15.2.
- Registry: `jegork/tidy-timeline` folds notices and pasted text, not tool pairs.
- Not in Paseo: a folded checkpoint/rewind card.
- Effect on the decision: recommendation unchanged (A).
- Unverified: whether a reopened chat drops the rows explored between checkpoint and rewind (active chain only suggests it may).
