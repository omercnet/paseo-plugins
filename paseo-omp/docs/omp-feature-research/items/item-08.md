# Item 08: Fork a conversation into a new agent

## What it is
OMP's `fork` command copies a conversation into a new session file. With an `entryId` it keeps everything up to that message (tool results included) plus the session's artifacts, so `artifact://` links still work. Without one it copies the whole session. Source: `omp://rpc.md`, `omp://tree.md`.

Who: people who want to try a second approach from the middle of a long run without losing the first. Occasional, not daily.

## What users get today
- Paseo can rewind a conversation (the provider sends `branch`, inferred) and has Import session for terminal sessions.
- The plugin has no fork action. Nothing duplicates an agent from a chosen message.
- Item 13 hit the same blocker: Paseo never sends `fork`.

## Works with the built-in provider?
Needs a Paseo change. Detail from the docs: RPC `fork` moves the running OMP process onto the new file; it does not create a second agent. Paseo would have to start a new OMP process on a copy. It fails with `session_busy` while the agent streams or runs bash, eval, compaction or retry, so it only works on idle agents. A plugin cannot send `fork` to a built-in agent.

Plugin-only workaround (unverified): copy the session file and artifacts folder, cut at a message, then create or import an agent on it. The SDK shows `workspace.agents.create({config, prompt})`, but I found no documented way to point it at an existing OMP session file. Cutting also needs OMP's rule to extend through a tool-call batch, and OMP holds a per-session lease. Hand-rolled copies risk corrupt or conflicting sessions.

## Value: low to medium
Real but occasional. Users can already start a fresh agent with a summary. The exact copy of tool results and artifacts is only reliable if OMP does it.

## Best surface
Paseo's own message menu ("Fork into new agent"), which would help every provider. A plugin cannot add buttons to built-in user messages; it could only replace the row (loses native rendering) or append a row after every turn (noisy). A `/fork` slash command for the whole session is the only plugin-shaped option and depends on the workaround. Upstream size: M. No pill.

## Risks and costs
- Plugin workaround drifts from OMP's session format and can race the lease.
- Artifacts are copied per fork (disk).
- Fork copies the conversation, not the workspace files; users may expect both.

## Recommendation
Do not build in the plugin. File one upstream ask with Paseo: message action "Fork into new agent" backed by OMP `fork {entryId}` on a fresh process, disabled while busy. It also unlocks item 13's branch tree.

Unverified: whether Paseo has fork for other providers; whether `agents.create` can resume from a session file; live `fork` behavior (not run).

Other items: 13 and 14 share the `session_busy` rule and the missing Paseo `fork` call.
