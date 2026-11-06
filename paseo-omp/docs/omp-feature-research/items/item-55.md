# Item 55: Memory (backend switcher, scoping, editable rows, consolidate now, stats)

## What it is
OMP has five memory backends (`off`, `local`, `hindsight`, `mnemopi`, `sharpshooter`), chosen by `memory.backend` in `config.yml`. Mnemopi is the local SQLite one: it recalls memories on the first turn, retains turns, and consolidates working memory into episodic memory and facts. Users reach it through `/memory` (`view`, `stats`, `diagnose`, `queue`, `enqueue`, `clear`) and the agent tool `memory_edit` (`update`/`forget`/`invalidate` working or episodic rows by id). Users: people who enabled memory and want to see or fix what the agent remembers, usually after a wrong recall.

## What users get today
- Memory panel and pill: read-only list of the `facts` table of the newest matching `mnemopi` bank. Facts are the one store OMP marks immutable, so the panel shows the rows nobody can edit and hides the working and episodic rows that `memory_edit` can change.
- The typed settings editor already groups `memory.`, `mnemopi.`, `hindsight.`, `sharpshooter.` keys, so backend and scoping are already editable. Diagnostics and the support report already show the memory backend.
- `/memory stats` and `/memory enqueue` can be typed in the composer (builtin slash commands over RPC `prompt`, output in `command_output` frames). Unverified: whether Paseo renders `command_output` for built-in agents.
- No `omp memory` CLI subcommand exists (checked `omp --help`), so no out-of-session stats or consolidation.

## Works with the built-in provider?
- Backend switcher and scoping: yes, config writes, already covered by the settings editor.
- Stats and consolidate now: only through a live session `prompt`. A plugin button needs Paseo to let plugins send a prompt to a built-in agent and show the output. Unverified; otherwise needs a Paseo change.
- Editable rows: `memory_edit` needs live Mnemopi state in the session. Writing the SQLite file directly is possible but the schema (working, episodic, FTS, embeddings, graph, WAL) is OMP internal and the file is open in running sessions. Unsafe.

## Value: low to medium
Memory is off by default and Mnemopi is one of five backends, so few users use it. The real pain, "the agent remembered something wrong, remove it", is already solved by telling the agent in chat "forget memory <id>", which uses `memory_edit` safely. Stats and consolidation are rare diagnostic actions. The one real gap is that the current panel shows the wrong store and offers no action, the same pattern as the removed Sessions pill.

## Best surface and size
Do not build the feature set. If anything, fix the existing panel: show working and episodic rows (content, importance, veracity, age) read-only, with a "Tell agent to forget" button that puts `Forget memory <id> with memory_edit` into the composer. Remove the Memory pill (duplicates the panel, no per-message value). Size S.

## Risks and costs
Reading Mnemopi tables pins the plugin to an undocumented schema. The bank match (basename prefix) can pick the wrong bank. Direct DB edits risk corruption. Slash commands via `prompt` cost a model turn. Backend changes fast, so drift is likely.

## Recommendation
Skip the backend switcher, editable rows, Consolidate now and stats. Optional later: the small panel fix and pill removal above. No upstream ask.

## Unverified
`command_output` rendering in Paseo; whether plugins can send prompts to built-in agents; exact Mnemopi working/episodic table names.

## Paseo check (2026-11-05)
- Paseo already has: `command_output` frames from OMP are rendered as an assistant message in the current turn, ANSI stripped (`omp/agent.ts:1634-1652`, dispatch at 1773; present in v0.15.0 and v0.15.2). Output arriving before the turn starts is buffered. So `/memory stats` and `/memory enqueue` typed in the composer show their text. Slash commands come from OMP `get_commands` (`agent.ts:1245`). `memory_edit`, `retain`, `recall`, `reflect` tool calls render as plain text rows (`tool-call-mapper.ts:159-177`). Plugins can send text to a built-in agent with `paseo.agents.ref(id).send` (used in `paseo-omp/client/mcp-popover.tsx:75`).
- Not in Paseo: any OMP memory UI. Registry plugins Memorise (monarchmaisuriya) and Repo Notes (maxwell-01) are separate memory systems injected into prompts, not OMP Mnemopi views.
- Effect on the decision: recommendation unchanged (A). Two unverified items resolved: `command_output` renders, and plugin send works. A "Tell agent to forget" button and a "Run /memory stats" button are cheap, but they still cost a model turn and the panel still reads an undocumented schema.
- Unverified: that `/memory` appears in the composer command list for built-in agents; Mnemopi table names.
