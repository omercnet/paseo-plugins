# Item 41: ast_edit staged preview with Apply/Discard

## What it is
`ast_edit` rewrites code by structure (ast-grep patterns), for example "rename every `foo(a, b)` call to `bar(b, a)` across 200 files". It never writes on the first call. It returns a preview of the changes and queues a pending action. The files change only when the agent then writes to the virtual device `xd://resolve` (apply) or `xd://reject` (discard), with a one-sentence reason (`omp://tools/ast-edit.md`, `omp://resolve-tool-runtime.md`).

Key point: the "Apply/Discard" decision is made by the model, not the user. While a preview is pending, OMP forces the model's next tool call to be a `write` to one of those two devices, so it resolves in the same run, within seconds. The user is not asked.

Users: anyone doing large mechanical refactors. The model uses `ast_edit` only when it chooses to; it is discoverable, not an essential tool.

## What users get today
- The `ast_edit` call and the `write xd://resolve` call both show as ordinary tool rows in the Paseo timeline. How exactly they render is unverified (I did not run a daemon).
- If the user has OMP tool approvals on, the typed approval flow already maps edit/write tools to Paseo permission prompts (our provider does this; whether the built-in provider does is unverified). That is the real "user says yes/no" gate.
- The plugin has no `ast_edit` or `xd://` handling (searched client code).

## Works with the built-in provider?
Partly. A plugin can restyle the `ast_edit` tool row with a timeline transformer/renderer (a diff card from `details.files` / the `-LINE:before / +LINE:after` text). It cannot send the live resolve command: the built-in provider only sends prompt, steer, abort and the other listed commands. A button could only send a chat message ("apply it"), which spends a model turn and races the model, which has usually already resolved. A true staged-then-user-decides flow needs a Paseo change (pause the turn on the pending preview and expose a resolve RPC) or our own provider. Not worth asking upstream for this alone.

## Value: low
- Preview is already in the timeline as text; the rendering gain is cosmetic.
- Apply/Discard cannot be user-driven on built-in agents; a fake button that messages the model misleads.
- `ast_edit` is niche and model-initiated; most edits go through `edit`, which has no staged flow at all.
- Duplicates the generic permission prompt if approvals are on.

## Best surface if ever done
A timeline transformer rendering `ast_edit` results as a per-file diff card (read-only, no buttons). Size S to M. Depends on knowing the real tool-call payload shape (unverified).

## Risks/costs
Drift with OMP output format (hashline vs plain mode, truncation to 120 chars). Misleading UI if buttons imply control that does not exist. Small audience.

## Recommendation: skip
Revisit only if Paseo adds "pause on pending preview" or a generic resolve command. If we want a cheap win, a read-only diff card belongs with a general tool-card pass (see item 42), not as its own feature.

Cross-note: items 42 and 41 share the "tool cards" idea; one transformer pass could cover both.

## Paseo check (2026-11-05)
- Paseo already has: built-in omp maps `ast_edit` to a `plain_text` row (result text only, `details.files` dropped) via `OPAQUE_TEXT_TOOLS` (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:144-177`). The follow-up `write xd://resolve` shows as a `plain_text` row labelled `resolve` (`tool-call-detail.ts:445-452`). Same in 0.15.0 and v0.15.2. OMP permission prompts map via `rpc-ui-permission-mapper.ts`.
- Not in Paseo: a diff card for `ast_edit`, or any command to resolve a pending preview.
- Effect on the decision: recommendation unchanged (A). A read-only card must parse text, since structured `details` never reach the client.
- Unverified: live render of an `ast_edit` pair.
