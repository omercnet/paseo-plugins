# Item 47: `lsp` / `debug` cards

Verdict: **LSP diagnostics card is low-to-medium value and only a polish item. Debugger card with Continue/Step is not feasible with the built-in provider and rare anyway. Skip the debugger; defer the LSP card.**

## What it is
- `lsp` is an agent tool. The model asks language servers for errors and warnings in a file (`action: diagnostics`), plus go-to-definition, references, rename, code actions. Result is one block of text, such as a summary line and grouped diagnostics. The `details` field only holds `action`, `success`, `serverName`. No structured diagnostics list (omp://tools/lsp.md).
- `debug` is an agent tool that drives a debugger (14 adapters: gdb, lldb, debugpy, dlv, node...). Launch, set breakpoints, continue, step, read stack and variables. Output is also text, with structured `details` (stack frames, variables, state) in the session file only.
- Users: anyone letting the agent run on code with a language server. The agent uses these tools by itself. A human watching the timeline sees them as ordinary tool calls.

## What users get today
- Paseo already shows every tool call in the timeline, with its text output. Diagnostics appear as that text. Nothing is lost, only not prettified.
- The plugin only shows a health row "LSP tool: Supported / Not advertised" in the Diagnostics tab. No config editor for `lsp.json` or `dap.json` (that is item 33, separate).

## Works with the built-in provider?
- **LSP card: yes, partly.** A client-side timeline transformer/renderer can restyle the existing `lsp` tool-call row: parse the text output and group by file with severity badges. Risk: parsing a text format that is not a stable contract. [unverified: how Paseo hands tool-call rows to renderers for omp, and whether it passes tool name and raw text through.]
- **Debugger stop-state card (read-only): yes, partly.** The same renderer approach could show stack and locals from the tool text, or from the session file `details` (path in `persistence.nativeHandle`) via `timeline.append` on `agent.turn.after`. Only after the turn ends, so never live.
- **Continue/Step buttons: no.** They would need a live DAP command in the running session. The plugin cannot send OMP RPC or tool calls into a built-in agent, and the debug session lives inside the OMP process (single, in-memory `dapSessionManager`, 10 min idle cleanup). A button could at best send a chat prompt "continue", which is a worse version of typing it. It also races with the agent, who is the one driving the debugger. Needs a Paseo change or our own provider.

## Value
- **LSP card: low-medium.** Diagnostics are the main reason agents call `lsp`, and a grouped list is easier to scan than a text block. But the text is already readable, and edits get diagnostics inline without the tool (writethrough), so many users never see an explicit `lsp` call.
- **Debugger card: low.** Agent-driven debugging is rare. Buttons that fight the agent for control are a UX hazard, and are infeasible anyway.

## Best surface and size
- Timeline tool-call renderer only; no pill, no tab. LSP card: M (parser, severity styling, collapsed state, tests across language servers' output). Debugger card: M-L for read-only, not worth it.
- Cheaper alternative worth considering: surface `lsp status` and server list in the OMP screen. Overlaps item 33, so decide there.

## Risks and costs
- Parsing human-oriented text output that OMP may reword in any release: drift, silent breakage. Fallback must be the plain text row.
- Renderer code runs for every tool call; must be cheap and must never hide the original output.
- Debug output can contain variable values (secrets). A richer card makes them more prominent.

## Recommendation
- **Skip** the debugger card and any Continue/Step controls.
- **Later** for an LSP diagnostics renderer; revisit if users ask, or if upstream OMP starts putting structured diagnostics in `details`. Low cost to ask OMP for structured diagnostics `details`; that would remove the parsing risk.

Not verified: Paseo's current rendering of `lsp` and `debug` rows in the timeline; actual text format on a real run; whether renderers receive tool `details`.

Other items: item 33 (LSP/DAP config editors) shares the server-status idea; item 40 (Tools panel) already has `lsp.enabled` and `debug.enabled` switches.

## Paseo check (2026-11-05)
- Paseo already has: built-in omp maps `debug` to a `plain_text` row (label from action/target, result text only, `details` dropped): `packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:144-177`. `lsp` is not mapped, so it falls to the default `unknown` row (`tool-call-detail.ts:415-420`), which the app shows as pretty-printed Input/Output JSON (`packages/app/src/components/tool-call-details.tsx:365-412`). Same code in 0.15.0 (installed dist) and v0.15.2/main (no diff in `providers/omp/` since v0.15.0). Client `addTimelineTransformer({ query: { itemType: "tool_call" } })` gets the full row incl. `detail` (`packages/plugin/src/client/contracts.ts:205-288`, `docs/plugins.md` "Contribute timeline items", present in 0.15.0).
- Registry: `emosenkis/lsp` adds diagnostics to Paseo's file editor (not the timeline).
- Not in Paseo: any LSP or debug card; structured debug `details` never reach the client.
- Effect on the decision: recommendation unchanged (B). LSP rows are raw JSON, not readable text as the notes assumed, so a card would help a bit more than estimated; a debug card can only parse text.
- Unverified: live rendering of a real `lsp` call (not run on the test daemon).
