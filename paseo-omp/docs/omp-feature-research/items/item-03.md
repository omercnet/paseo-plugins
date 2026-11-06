# Item 03: Edit or cancel queued messages (queue chips)

## What it is
When an OMP agent is busy, a new message is queued as a steer (delivered at the next tool boundary) or a follow-up (delivered when the agent would stop). OMP's RPC can:
- `queue_update` event / `get_state.queuedMessages`: the live list of pending queued texts.
- `remove_queued_message`: take one pending message back (returns its images so the draft can be restored).
- `promote_queued_message`: move a follow-up into the steering queue ("send now").
- `abort_and_restore_queue`: abort and return every queued text, like Esc in the OMP TUI.

Who: anyone who types ahead while an agent works, then changes their mind or wants a follow-up to land now.

## What users get today
- Built-in `omp` provider: sends `steer` only. No `remove`, `promote` or `abort_and_restore_queue` in its command list (per BRIEF). Whether Paseo's own composer shows queued messages client-side before sending, with its own cancel, is **unverified** (Paseo source fetch failed: no network).
- Our plugin: `queue_update` is `ignore`, all three commands are `unsupported` (`paseo-omp/server/provider/omp-rpc-protocol.ts` lines 87, 145, 165-166).
- Once a steer is sent, users cannot see or take it back. Only Stop, which also kills the turn and drops the queued text.

## Works with the built-in provider?
**No. Needs a Paseo change.** All four pieces are live session traffic. A plugin cannot send RPC commands into a built-in agent, and the queue is not in the session file until delivered, so `timeline.append` from the file cannot show it either. Our `omp-plugin` provider could do it, but that provider is being deprecated.

## Value
**Medium.** Real, recurring pain (a mistyped or stale steer is unrecoverable and can derail a long turn). But the most common fix, "don't send that", is partly met if Paseo already holds messages in its own composer queue (unverified). The OMP-specific gain is precise: retract a steer already handed to OMP without killing the turn, and Esc-restore on Stop so no typed text is lost.

## Best surface
Not a pill, not a plugin surface. Belongs in Paseo core, provider-agnostic: queued-message chips above the composer with Remove and Send now, and Stop returning withdrawn text to the composer. Size: S for an upstream issue; M for Paseo to build.

## Risks / costs
- Match is by text: duplicate texts remove the first match. Live-steered text stays visible but is no longer removable (`removed: false`); UI must handle that.

## Recommendation
**Upstream ask to Paseo, skip plugin work.** File a Paseo issue: "Queued message chips with Remove / Send now, and Stop restores queued text, for providers that support it", citing OMP's RPC as a ready backend. Verify first whether Paseo already has a client-side queue (unverified here).

Unverified: Paseo's current composer queue behavior; nothing run hands-on.
