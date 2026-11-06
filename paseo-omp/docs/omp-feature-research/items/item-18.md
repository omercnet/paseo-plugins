# Item 18: Context notes mode (notes-backed context windows)

## What it is
An opt-in OMP compaction mode (`compaction.experimentalContextManagement: true`, default false, labelled "Notes-backed context windows (experimental)" in OMP's `/settings`). Instead of summarizing the transcript when the context fills up, the model keeps a persistent notebook (`context_notes` tool, max 16 KB, stored as `custom` journal entries with `customType: experimental_context_notes`) and asks for a fresh window (`new_context`). Old messages stay recoverable through `read history://current/full`. Source: `omp://compaction.md`, `omp://tools/context-notes.md`, `omp://tools/new-context.md`.

Who: power users running long sessions who find summary compaction lossy. When: long refactors, multi-hour investigations. It is experimental; notebook quality depends on the model remembering to write notes.

## What users get today
- Paseo: Compact button and auto-compaction toggle (built-in `compact` / `set_auto_compaction`). Nothing about notes.
- Plugin: the typed settings editor groups `compaction.*` under Context, so the boolean may already be editable there (unverified whether this key is listed). `context_notes` / `new_context` calls already appear as plain tool-call rows in the timeline because they are ordinary tools.

## Works with the built-in provider?
Yes, fully, without our provider:
- Toggle: write the settings file (plugin already does this). Applies to new sessions; for running built-in agents it needs a reload, since the "running session gains the tool immediately" claim applies to OMP's own settings reconcile, not to external file edits (unverified over RPC).
- Viewer: the notebook lives in the session JSONL file (`persistence.nativeHandle`), the same file the rule-fired notice already reads. No `get_entries` needed. A `context_notes` write tool call also carries the full text in its result details, so a client-side renderer can show it without any server work.

## Value: low to medium
- The mode is experimental and off by default. OMP docs warn notes quality is the model's responsibility and earlier pruning cannot be undone.
- The real win, if any, is OMP's, not a UI's: users get it by flipping one boolean. A notebook viewer is nice to have but small; the model's note text is already visible in the tool-call row.
- Niche: only users who hit compaction limits and distrust summaries.

## Best surface (if exposed)
- S: make sure `compaction.experimentalContextManagement` shows as a boolean with its OMP label and an "experimental" hint in the existing Configuration tab (Context group). No pill, no new tab.
- S: client-side renderer for `context_notes` / `new_context` tool calls: "Notebook updated (2.1 KB)" collapsed card showing the text, "New context window requested" notice. Pairs with item 20 (compaction details).
- Not recommended: a separate notebook panel. Same lesson as the sessions pill: a view with no action beyond what the timeline row shows.

## Risks / costs
- Drift: experimental feature, tool names and entry shape (`version: 1`) may change.
- Enabling it changes `/compact` behavior and requires `read` and `grep` in the tool set; restricted sessions silently fall back. A UI toggle may give false confidence that notes are active.
- Noise: `context_notes` calls add tool rows; a renderer reduces that, does not add it.

## Recommendation
Later. Ship nothing dedicated now. If the settings editor does not already list the key, add it as a typed boolean with the experimental label (S). Consider the tool-call renderer together with item 20 once the feature leaves experimental status.

Note for item 20: `new_context` rollover emits normal auto-compaction events, so compaction detail rows should label the method as "notes rollover" rather than summary.

## Paseo check (2026-11-05)
- Paseo already has: the built-in omp provider maps `context_notes` and `new_context` to a `plain_text` tool-call row with the result text (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:159-177`, present in v0.15.0 and v0.15.2). Compact and auto-compaction toggle emit `compaction` timeline rows (`omp/agent.ts:1454-1547`, `handleCompactionEvent` ~1949). Our settings editor groups by the `compaction.` prefix (`paseo-omp/shared/omp-settings.ts:259`), so the boolean is editable if OMP's schema lists it. Plugins can replace tool-call rows with a custom card via `client.addTimelineTransformer({query:{itemType:"tool_call"}})` (`docs/plugins.md:657-677`); our plugin already does this for images.
- Not in Paseo: any notebook viewer, notes size indicator, or label for notes rollover. Rollover shows as a normal compaction row.
- Effect on the decision: recommendation unchanged (A, later). Option B is cheaper than assumed: the toggle needs no work and the renderer is a client-only transformer. Still low value because the text already shows.
- Unverified: that `compaction.experimentalContextManagement` appears in the schema our editor reads; whether a running built-in agent applies the file edit without reload.
