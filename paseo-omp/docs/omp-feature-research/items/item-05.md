# Item 05: Ask a quick side question without interrupting

## What it is
OMP's `/btw` asks one tool-less question about the current conversation while the main run keeps going. It sees the session context, including text still streaming. Question and answer stay out of the transcript, saved in a sidecar history with follow-ups. RPC: `btw`, `btw_cancel`, `get_btw_history`. User: someone watching a long run who wants "why did you pick this?" without stopping the agent.

## What users get today
- Paseo core: a message mid-run interrupts or steers the run, or queues into the main transcript (upstream issue #2056, reproduced on Codex; unverified for omp). Mid-run fork (merged Aug 2026) opens a whole new agent per question.
- Paseo plugin registry: three `/btw` plugins exist: Side Chat (232 installs), ByTheWay (80), Better btw (17). Plugin slash commands with arguments shipped in Paseo 0.8 (here: 0.15.0). They read the timeline and spawn a throwaway agent, so they are provider-neutral.
- Our plugin: nothing. Our provider lists `btw` as unsupported.

## Works with the built-in provider?
Natively: no. No `btw` appears anywhere in the built-in provider's source (28 files checked), and plugins cannot send RPC. Hands-on, OMP 18.13.1, isolated dir: the three commands respond, but `btw` is not among the 48 slash commands advertised over RPC, so per the docs a typed `/btw` falls through as plain prompt text. Streaming deltas not exercised.

Through the community plugins: should work, unverified (not run on a built-in omp agent). Gaps against native:
- No prompt-cache reuse: each question starts a cold agent and pays for its context again.
- Side Chat only asks its side agent not to use tools. Built-in omp modes are Full Access, Write Approval, Always Ask; none is read-only, and Side Chat looks for a plan or read mode, so the side agent likely runs as Full Access (inferred from its code).
- Context is a text snapshot (Side Chat: last 8 messages, no tool calls). Better btw sends it to Anthropic via `claude -p`, even for omp agents.

## Value: low for us to build (medium as a capability)
The need is real: an upstream request and three plugins. But it is covered, and our only edge (cache reuse, in-flight text, tools hard-off) needs live RPC we cannot send.

## Best surface / size
None in the plugin. If ever: Paseo core calls native `btw` for built-in omp. Upstream size L; maintainers redirect feature asks to plugins.

## Risks / costs
- A fourth copy: same cold-cache cost, plus upkeep.
- Our own provider may be deprecated, so building there is wasted.
- A Help-tab pointer to unvetted plugins invites trust and stale-link problems.

## Recommendation: skip
Build nothing. Optional: after trying one on a built-in omp agent, tell its author about the Full Access default.

Related: items 3, 4, 7, 9, 12, 14 share this blocker (no live RPC to built-in omp). One upstream passthrough ask would unlock them; decide it once.

## Paseo check (2026-11-05)
- Paseo already has: Fork from the in-flight turn into a new tab or workspace (`docs/glossary.md:62`, `agent.fork_context`). The built-in omp provider has no `btw` (no match in `providers/omp/`, main), and `btw` is not among the 96 commands the 0.15.0 test daemon advertises, so typed `/btw` is plain prompt text.
- Community plugins (registry today): Side Chat (117 installs), ByTheWay (provider-native model and mode controls), Better btw, Tangent (`/btw`, `/fork` with native forks where supported), Side question (pocharlies-org, no tools, own panel), Quote (ask about a passage in a side chat).
- Not in Paseo: native OMP btw with prompt-cache reuse.
- Effect on the decision: recommendation unchanged (A). Six plugins plus core fork cover the need. Option C is an upstream ask; GAPS.md only.
- Unverified: any of these plugins on a built-in omp agent; whether Side question really forces tools off for omp.
