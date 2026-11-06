# Item 48: web_search sources list

## What it is
OMP's `web_search` tool runs one query through a chain of search backends (hosted model search, Exa, Brave, DuckDuckGo and many more). The tool result is plain text: an optional answer, then numbered sources (`[n] title (age)`, URL on the next line, a snippet), optional citations and related questions. The proposal is a tidy, clickable sources list for that tool call.

Who and when: anyone whose agent researches docs, errors or library versions. Frequent in research-heavy turns, but each result is a side detail the user rarely needs to open.

## What users get today
- The built-in `omp` provider already maps `web_search` to a Paseo "search" tool call (upstream `tool-call-mapper.ts`): query as the label, the raw result text as content. So the call is visible with its query, and the sources are readable in the expanded text.
- Our `omp-plugin` provider does the same mapping (`timeline-projector.ts`). Nothing in the plugin is specific to web search.
- Gap: sources show as one text blob, not a list of links. Whether URLs in that blob are tappable in the Paseo UI is unverified.

## Works with the built-in provider?
Yes, without our provider. The data is already in the tool result text, and the session file has structured `details.response.sources`. A client-side timeline transformer or renderer (plugin API) could parse the text (stable `[n] title` / URL format, documented in `omp://tools/web_search.md`) and render a list. Whether a plugin renderer can replace the built-in search card body is unverified; I did not test it.

## Value: low
- The agent's answer already quotes what matters; users click a source only to verify a claim.
- It is a presentation tweak on one tool card, not new capability or insight.
- Parsing text that is formatted for the LLM is fragile. OMP can change the format without notice.
- Error output (`Error: No web search model configured`) is more useful to surface, but that already shows in the card text.

## Best surface and size
Timeline renderer for `web_search` search cards: favicon, title, domain, clickable URL. Size S to M. No pill, no screen.

A better idea nearby (different item): web search provider setup (`web_search.enabled`, `modelRoles.web`, API keys for Exa/Brave/etc.) in the typed settings editor. A failing or unconfigured search chain silently degrades research. That already fits the existing Configuration tab.

## Risks and costs
- Drift: depends on OMP's text format, or on reading the session file for structured sources.
- Duplication: if upstream Paseo improves its search card, our renderer collides with it.
- Maintenance for a small visual gain.

## Recommendation
Skip as a plugin feature. If sources links matter to users, ask upstream Paseo to render URLs in the existing search card (benefits every provider). Check that web search settings are editable in the Configuration tab instead.

Unverified: URL tappability in the built-in card; plugin renderer override of built-in search cards; live output of the tool.

Note for other items: web search backend and key configuration (`providers.webSearchTimeoutSeconds`, `modelRoles.web`, `searxng.*`, `exa.*`) belongs with settings/config items, not here.

## Paseo check (2026-11-05)
- Paseo already has: built-in omp maps `web_search` to a `search` row with query and raw text (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:73-81`), and flags `details.error` as a failure (`tool-call-detail.ts:307-319`). The app renders search `content` as plain selectable `Text`, not links (`packages/app/src/components/tool-call-details.tsx:302-320`). `SearchDetail.webResults` exists but OMP does not fill it, and it also renders as plain text (`:331-338`). Same in 0.15.0 and v0.15.2.
- Not in Paseo: tappable source links for any provider's search card. No registry plugin found for it.
- Effect on the decision: recommendation unchanged (A). The tappability question is answered: URLs are not tappable, but the text is selectable. A plugin transformer could replace the row (tool_call transformers run before built-in rendering), so B stays cheap if users ask.
- Unverified: live render on the test daemon.
