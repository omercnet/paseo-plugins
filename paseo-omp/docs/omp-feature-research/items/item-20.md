# Item 20: Compaction details

## What it is
When a long chat nears the model's context limit, OMP compacts it: older turns are replaced by a summary. OMP records this as a `compaction` entry in the session file (`omp://session.md`) with `tokensBefore`, optional `tokensAfter`, `method` and `warning`. A handoff (`handoff` RPC) starts a fresh context and returns `{ savedPath? }`. Users hit this on long sessions, mostly when the agent suddenly seems to "forget" something.

## What users get today
- Paseo shows compaction start/end for omp agents (events `auto_compaction_*` and `manual_compaction_*` are normalized in our provider; the built-in provider presumably does similar). Whether the built-in row shows token numbers or method: unverified.
- The plugin shows nothing extra. The plugin ignores `compactionSummary` messages in its own provider.

## Works with the built-in provider?
Partly, without new RPC. A plugin can read the agent's session file (`persistence.nativeHandle`) on `agent.turn.after`, find new `compaction` entries and append a timeline row ("Compacted: 182k to 41k tokens, method X"). `savedPath` for handoffs comes only from the RPC response, which a plugin cannot see; but handoff may also leave a trace in the session file (unverified). Live "compacting now" state is already Paseo's job.

## Value: low
It is a diagnostic number. It does not change what the user does next. The real user need ("why did the agent forget?") is answered by a one-line row, not a feature. Handoff `savedPath` is rarer still and hard to reach. Compaction settings tuning is a separate item (37).

## Best surface
A timeline row from `agent.turn.after`, nothing else. Size: S, but only after checking whether Paseo already shows tokens.

## Risks and costs
- Duplicate row if Paseo already renders compaction.
- Must parse session file format (drifts with OMP versions; row would silently vanish).
- Noise on every compaction.

## Recommendation
Skip for now. Revisit only if users report confusion after compaction, or if upstream Paseo lacks token numbers on its compaction row (then ask upstream first, since that is the right home).

Unverified: Paseo built-in compaction row content; whether handoff leaves `savedPath` in the session file; actual `tokensAfter` presence by method.

## Paseo check (2026-11-05)
- Paseo already has: a compaction row for omp. Live auto compaction maps `auto_compaction_start/end` with `preTokens` from `tokensBefore` (`packages/server/src/server/agent/providers/omp/event-mapper.ts:214-244`, `:295-299`); manual `/compact` emits its own rows (`agent.ts:1455-1483`); reopened chats replay `compaction` entries with `preTokens` (`history.ts:103-105`, `:518-525`). Label: live rows say "Context automatically/manually compacted" without tokens because trigger wins; reopened rows say "Context compacted (182K tokens)" (`packages/app/src/components/message-compaction-label.ts`). Same in 0.15.0 and v0.15.2.
- Not in Paseo: `tokensAfter`, `method`, `warning`, handoff `savedPath`.
- Effect on the decision: recommendation unchanged (A). Option B would duplicate an existing row; a `compaction` transformer could restyle it but only has `preTokens`.
- Unverified: live row text on the test daemon.
