# Item 07: Keep Paseo and OMP conversation titles in sync

## What it is
OMP names every session (a title stored in the session file, shown in `omp --resume`, the terminal title and the session picker). Over RPC, `set_session_name` renames it and `get_state.sessionName` reads it. The idea: renaming an agent in Paseo also renames the OMP session, so the same conversation has the same name in both places.

Who benefits: someone who renames Paseo agents and later resumes the same session from a terminal (`omp --resume`) or looks at OMP's own session list. That is a narrow overlap.

## What users get today
- Paseo shows its own agent title everywhere (agent list, history). Paseo already generates and edits that title itself.
- OMP's automatic titling is turned off in RPC mode (`PI_NO_TITLE=1`, per `omp://rpc.md`), so Paseo-driven OMP sessions are mostly untitled on the OMP side anyway.
- **Import session** goes the other way: it reads the OMP title (and the first prompt) when opening a terminal session, so OMP to Paseo naming already works at import time.
- The plugin reads titles from session files for its own provider (`session-descriptors.ts`) but never writes them. Its own provider marks `set_session_name` as "unsupported", so even our provider does not do this today.

## Works with the built-in provider?
No, not as a live command. The built-in provider cannot send `set_session_name`. Options:
- **Paseo change:** the built-in provider would need to forward renames as `set_session_name` (one small RPC call, and `get_state` already returns `sessionName`). This is the clean fix and is small upstream.
- **Plugin writing the session file directly:** technically possible (title is a fixed-width slot in the header plus a `title_change` audit entry), but OMP documents that it holds a per-session lease and detects size changes, and says it "cannot protect against non-cooperating external writers". A foreign write to a live session file risks a write conflict or a forked sibling file. Unverified in practice; not recommended.

## Value: low
- Names only matter on the OMP side if the user leaves Paseo for the terminal on that exact session. Paseo already has Import for the reverse trip.
- Paseo titles are the surface users actually see; OMP titles are invisible in Paseo.
- One-directional (Paseo to OMP) sync would leave OMP renames (`/rename` in a terminal, plan-approval naming) out of date in Paseo unless a second path is built.

## Best surface and size
No plugin surface fits. If anything: a built-in change in Paseo (rename handler calls `set_session_name` on omp agents, S). Plugin-only: none worth building.

## Risks and costs
- Plugin file writes to live sessions: corruption or lease conflicts, drift from OMP's file format.
- Two-way sync needs conflict rules (which title wins), polling `get_state`, and OMP's `titleSource` (`auto` vs `user`) rules.
- Title cards (`<icon> <CODE>: title`) in OMP titles would appear in Paseo if synced back, which is noisy.

## Recommendation: skip in the plugin
Do not build it. If the user wants it anyway, file a small upstream request: Paseo's built-in omp provider forwards agent renames via `set_session_name`. Revisit only if users report confusion when resuming Paseo sessions in a terminal.

Unverified: behavior of a live write to the session title slot; whether Paseo forwards renames to any provider today.

Cross-item note: `PI_NO_TITLE=1` in RPC mode may matter to any item about OMP-generated titles (the `TITLE_SYSTEM.md` prompt would have no effect for Paseo agents).

## Paseo check (2026-11-05)
- Paseo already has: agent rename that only stores the Paseo title (`packages/server/src/server/agent/agent-manager.ts:2314` `setTitle` on main; the provider session interface in `agent-sdk-types.ts` has no rename method on main or v0.15.0). OMP's own `/rename <name>` is in the built-in omp slash menu and works: typed on the 0.15.0 test daemon it replied "Session renamed to Paseo check title." Community plugins Chat Titles, Tab Namer and Title style only change Paseo titles.
- Not in Paseo: forwarding a Paseo rename to any provider, or reading OMP renames back.
- Effect on the decision: recommendation unchanged (A). Users who want an OMP-side name can type `/rename` in the composer today. Option B is an upstream ask, which the decided direction rules out; if wanted, record it in GAPS.md instead.
- Unverified: whether `/rename` while a turn is streaming is accepted.
