# Item 50: Magic keywords (ultrathink, orchestrate, workflowz, jevify)

## What it is
OMP treats four plain words in a prompt as switches. Each adds a hidden instruction for that one turn:
- `ultrathink`: careful reasoning, and max reasoning effort when auto thinking is on.
- `orchestrate`: split work across parallel subagents and verify each phase.
- `workflowz`: scripted multi-subagent workflow (needs `eval` and `task`).
- `jevify`: bulk-classification contract (needs `eval`).

Matching is strict: lowercase, standalone word, ignored in code blocks, inline code, paths and call syntax. All on by default; `magicKeywords.enabled` and per-keyword switches turn them off. The OMP terminal UI animates the word in the editor and highlights it in sent messages.

Who: any OMP user who types one of these words, often unaware it is special. The notice changes behavior and cost (more subagents, max reasoning).

## What users get today
- The behavior already fires with the built-in provider, since OMP injects the notice itself.
- No highlight, no tooltip, no signal that a keyword fired (the notice is hidden).
- The plugin has no keyword code. Its settings editor lists the `magicKeywords` group, so the switches are reachable (from source, not exercised).
- Paseo has a thinking-level picker, which covers the explicit version of `ultrathink`.

## Works with the built-in provider?
- Composer highlight and tooltip: **needs a Paseo change.** Plugin docs offer pills, slash commands and attachment sources, but no way to decorate text inside the prompt input. Faking it with a pill is what the brief says to avoid.
- After-the-turn notice: **possible, unverified.** Like the shipped "rule fired" row, an `agent.turn.after` hook could read the session file and append a row such as "ultrathink: max reasoning this turn". Not verified that the hidden message is readable there.
- On/off switches: already reachable.

## Value: low
- Keywords are a terminal shortcut; in Paseo the user already picks thinking level and mode.
- A tooltip teaches discoverability once. Not worth upstream work.
- The only useful piece is knowing a keyword fired when it raises cost (`orchestrate`, `workflowz`), a weak cousin of the rules notice.

## Best surface
- Highlight: none without Paseo upstream. Not worth asking.
- Optional: a timeline row after the turn (S, if the session file carries the notice), or a Help tab paragraph listing the four words and the off switch (S).

## Risks and costs
- Drift: the keyword table lives in OMP source, and names differ from settings keys (`workflowz` uses `magicKeywords.workflow`). A hardcoded list goes stale.
- Re-implementing the matching rules client-side would disagree with OMP and show false highlights.
- A row on every keyword use is noise for little information.

## Recommendation: skip
Revisit a timeline row only if users report surprise subagent cost. Cheapest acceptable form: a Help tab paragraph. Do not build highlighting.

Cross-item note: after-turn detection of hidden notices could share code with other after-turn timeline row items.

## Paseo check (2026-11-05)
- Paseo already has: no magic keyword code anywhere (grep of /tmp/paseo-src for ultrathink, workflowz, jevify, magicKeywords: only unrelated prose). Thinking-level picker covers explicit `ultrathink`. Plugin timeline transformers can target `itemType: "user_message"` (`packages/plugin/src/client/contracts.ts:277-290`, v0.15.0 docs `docs/plugins.md:641`), and a server hook `agent.turn.after` plus `timeline.append` is already used by our rule notices (`paseo-omp/server/rule-notices.ts:109-124`). Our editor already groups `magicKeywords` (`shared/omp-settings.ts:256`).
- Not in Paseo: any composer text decoration API (docs/plugins.md lists pills, slash commands, attachment sources only).
- Effect on the decision: recommendation unchanged (A, skip). New detail: a client transformer could re-render a sent user message with the keyword highlighted, so D is not strictly upstream-blocked for sent messages, but it replaces the native user row and duplicates OMP's matching rules. Not worth it.
- Unverified: whether the hidden keyword notice is in the session JSONL; whether a `user_message` replacement keeps native copy, edit and attachment behavior.
