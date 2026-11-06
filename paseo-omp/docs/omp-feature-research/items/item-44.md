# Item 44: eval code cells, views, images, workpool status

## What it is
`eval` runs a Python or JavaScript cell in a kernel that keeps state between calls (`omp://tools/eval.md`). The terminal draws a code block with status and shows printed tables, JSON and Markdown as pretty "views". Images attach to the result. `workpool()` and `agent()` fan work out to subagents. The agent uses it for data analysis and batch scripts, and for the `workflowz` and `jevify` keywords. Users mostly want to see what code ran.

## What users get today
Verified in `@getpaseo/server` 0.14.0 (`providers/omp/tool-call-mapper.js`): the built-in provider treats `eval` as an "opaque text tool". The row is a plain text row labelled `eval` with only the result text. The code is missing, views are lost, and images are dropped (item 45). Subagents from `agent()` and `workpool()` already show in Paseo's subagent strip. The plugin does nothing for eval.

## Works with the built-in provider?
Partly.
- **Code cell:** not by a client transformer, since Paseo's row lacks the code. Either a small upstream mapper change (it already sees `{language, code, title}`), or a plugin reading the session file in `agent.turn.after` and appending a row. The second duplicates the existing row; unverified.
- **Views:** live in `details.cells[].views`, user-only, max 16 per cell and 32 KiB each. Only the session-file route reaches them.
- **Workpool status:** `.status()` and `.peek()` are process-local and reach the model only if printed. No RPC event carries them, so no live status without our provider.

## Value: low
- The real gap, not seeing the agent's code, is a two-line mapper fix that helps every Paseo user.
- Table and JSON views are cosmetic over text users already read.
- Workpool status is unreachable.
- Eval is model-driven and off the common path for most sessions.

## Best surface and size
Upstream mapper change (S): title as label, code and output as a shell-like row. No plugin surface, no pill. A plugin session-file row would be M and fragile.

## Risks and costs
Plugin route depends on OMP's private `details` shape and duplicates Paseo's row. Upstream route is maintainer-decided and costs us nothing to maintain.

## Recommendation
No plugin card. Ask Paseo upstream for an eval mapper; revisit views only if that lands and users ask. Skip workpool status.

## Unverified
Real eval session file contents; clean call/result correlation; whether Paseo main differs from 0.14.0.

## Cross-item note
Items 43, 44, 45 and 49 share one blocker: the built-in provider reduces rich tool results to text. One upstream ask to pass tool `details` to the client serves all four.
