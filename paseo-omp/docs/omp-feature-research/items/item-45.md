# Item 45: `browser` / `computer` screenshots

## What it is
From `eval`, OMP agents can drive a headless Chromium (`browser`, on by default) and the host desktop (`computer`, off by default). The model sees screenshots. People building web UI want to see them too, especially on phone or web.

## What users get today
- Our `omp-plugin` provider shows them inline (thumbnails, tap to enlarge).
- Paseo's built-in `omp` provider shows none. For `eval` it keeps only result text, so the image is gone before any plugin sees it (upstream main still does this). Moving users to built-in loses this.
- Paseo's own `browser_*` tools hit the same bug: open issue getpaseo/paseo#3244 (p2, triaged, second user confirmed 2026-10-20). Fix PR #3245 was closed unmerged; the maintainer said not to resubmit. A community plugin (`suiramdev/paseo-omp-screenshots`) fixes only `browser_*`.

## Works with the built-in provider?
- Needs a small Paseo change. Its Pi and Claude providers already move tool images into the timeline; OMP needs the same. The closed PR is a starting point (about 110 lines plus tests, needs a rebase).
- Plugin-only workaround: after each turn (`agent.turn.after`), read the OMP session file, find screenshot blob references, append a row, like the shipped rule notice. Rows carry references only (64 KiB cap); bytes load by RPC like our image viewer.

## Value
- Browser screenshots: **medium**. Common in UI work, visual proof builds trust, real demand (open bug, community plugin).
- `computer` screenshots: **low**. Off by default, needs OS screen permissions, and a headless daemon host has no screen.
- `app.cdp_url` at the Paseo Browser: **none**. Needs a debug flag, the desktop app is often not on the daemon machine, and `browser_*` tools already cover it.

## Best surface and size
Inline in the normal timeline. No pill, no panel.
- Upstream fix: **S**, plus the live and after-reopen QA the maintainer asked for.
- Plugin fallback: **M**, one end-of-turn "Screenshots" row reusing our image viewer.

## Risks and costs
- Upstream timing is not ours.
- Fallback reads OMP's private session and blob layout (drift), shows images at turn end not live, loses rows on daemon restart, and must be removed when upstream lands or images show twice.
- Privacy: screenshots of logged-in pages reach every client and sit in a daemon cache.

## Recommendation
**Expose, upstream first.** Comment on #3244 with a refreshed, tested patch; keep `omp-plugin` supported until it ships. Build the plugin row only if we set a deprecation date for `omp-plugin` before upstream lands. Skip the CDP idea.

## Unverified
- What the built-in timeline shows for an image-only `eval` (docs, not run).
- That `eval` screenshots persist as blob references (from `session.md`).
- Whether Paseo Browser tabs appear on an Electron debug port.

Other items: the same upstream fix helps item 44 (`eval`). Item 49 (`generate_image`) is not in the mapper's text-only list, so its image blocks may already reach a client renderer [unverified].

## Paseo check (2026-11-05)
- Paseo already has: nothing for `eval` images. `eval` is in `OPAQUE_TEXT_TOOLS` and maps to `plain_text` with text blocks only (`packages/server/src/server/agent/providers/omp/tool-call-mapper.ts:144-177`, `tool-call-detail.ts:277-283`). Unmapped tools (e.g. `browser_*`) become `unknown` rows that keep image blocks, cut to 64 KiB (`agent-timeline-content.ts:9`). No change in `providers/omp/` from v0.15.0 to main. 0.15.0 fixed Pi tool images (#8280), not OMP. #3244 still open (p2, triaged, last activity 2026-11-03).
- Registry: `suiramdev/paseo-omp-screenshots` requires paseo `<0.15.0`, so it cannot install on 0.15.x; `futuregadget/inline-image-preview` shows base64 image blocks in tool results. Neither can see `eval` screenshots.
- Effect on the decision: recommendation unchanged (B). The session-file row is still the only way to get `eval` screenshots back. A tool_call transformer covers `unknown` image rows cheaply.
- Unverified: live render of an `eval` screenshot on 0.15.0.
