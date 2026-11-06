# Item 15: Warm process reuse

**What it is.** OMP's RPC has `new_session`, `open_session` and `switch_session`. They let one running OMP process drop its current session and adopt another (`rpc.md` calls it "a pre-spawned process can adopt a thread after startup"). The point is skipping process startup for a new agent. Only a host that manages a pool of OMP processes would use it. No end user would ever see or choose it.

**What users get today.** Paseo's built-in provider starts one OMP process per agent. Starting an agent costs a process spawn. I measured on this host: `omp --version` 9 ms, and spawn to first `get_state` reply in RPC mode about 520 ms (one run, empty config, so unverified on a loaded real setup with many MCPs and extensions). Our plugin also spawns per agent (`omp-rpc-transport.ts`) and marks all three commands `unsupported`.

**Works with the built-in provider?** No. Process lifecycle belongs to Paseo's provider, and a plugin cannot send RPC commands into it. It would need a pool inside Paseo core, or our own provider, which we are moving away from.

**Constraints that cut the benefit.** A process holds one active session. Switching aborts the running turn and replaces the session, so a process cannot serve two live agents at once. Reuse is only possible for idle processes, which means building a pool, idle timeouts, and cleanup of per-session state (goals, extensions, MCP connections, model, env, cwd). Spawn cwd and env are fixed at start, so a reused process may carry the wrong workspace context or MCP set. These are correctness risks to buy roughly half a second.

**Value: low.** Saves about 0.5 s on agent creation, no new capability, invisible in the UI, with isolation risk. Paseo's own agent start is likely dominated by model latency afterwards.

**Best surface / size.** None for a plugin. A real implementation is L and lives in Paseo core.

**Risks/costs.** State leaking between agents, orphaned processes, harder crash handling, drift from OMP's session semantics.

**Recommendation: skip.** If startup time ever becomes a complaint, measure with a real config first, then raise it upstream with Paseo as a core optimization rather than building it here.

Unverified: spawn timing under a real config; whether Paseo core already pre-spawns.

## Paseo check (2026-11-05)
- Paseo already has: one OMP process per agent session. `OmpCliRuntime.startSession` (`packages/server/src/server/agent/providers/omp/cli-runtime.ts:73-112`, main) spawns a fresh `JsonlRpcProcess` and negotiates the protocol each time. No pool, prewarm or reuse in `providers/omp/` or elsewhere in `agent/` (grep for warm/pool/prespawn: nothing). The provider never sends `new_session`/`switch_session`.
- Not in Paseo: process pooling for any provider.
- Effect on the decision: recommendation unchanged (A). Option B is an upstream ask, which the decided direction rules out; GAPS.md only if startup is ever a complaint.
- Unverified: real startup time with a loaded config (still the 0.5 s single measurement).
