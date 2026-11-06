# Item 49: `generate_image` / `tts` (gallery and audio player)

## What it is
Two optional OMP tools, both off by default:
- `generate_image` (`generate_image.enabled`): the agent creates or edits images via an image model (OpenAI, Codex, xAI, Gemini, OpenRouter, Factory). Files land in the daemon host's temp dir (`/tmp/omp-image-<id>.webp`), outside the workspace.
- `tts` (`speechgen.enabled`): the agent writes a `.wav`/`.mp3` speech file into the workspace, using local Kokoro or cloud voices.

Who and when: people building apps, games or docs who want placeholder art, icons or narration inside the coding loop. Occasional, not daily.

## What users get today
- The built-in `omp` provider shows both as an `unknown` tool call row with raw args and result JSON (verified: `@getpaseo/server` 0.15.0, `providers/omp/tool-call-detail.js`).
- The image base64 is in the result, but Paseo caps tool call rows at 64 KB by cutting the longest strings (`agent-timeline-content.js`). The picture never reaches the app; `imagePaths` survives.
- Paseo's built-in Image file panel opens workspace images, but generated images sit in `/tmp`. Opening files outside the workspace: unverified.
- `tts` files appear in the file tree; no built-in panel plays audio.
- Paseo already speaks assistant replies itself, so "hear the agent" is covered.
- Isolated check: `omp models --kind image` found nothing without API keys; `--kind tts` listed local `kokoro`. Images need a paid image credential.

## Works with the built-in provider?
Yes, no live RPC needed:
- Image: a timeline transformer matches the `generate_image` row, reads `imagePaths`; a renderer fetches bytes through a plugin RPC (binary `Uint8Array`) and shows a thumbnail with Download. Size M.
- Audio: a plugin file panel for `wav`/`mp3` via `file.url()`. Native playback inside `DocumentFrame`: unverified. Size S/M.
- Turning the tools on belongs to item 40.

## Value
Low. Both tools are opt-in, images need an extra paid credential, and few coding sessions call them. When they do, the gap is real (an image you cannot see), but niche. An audio panel is generic Paseo value, better as an upstream built-in panel.

## Best surface if built
Inline thumbnail plus Download on the existing tool call row. No pill, no gallery screen: a gallery repeats the timeline and is a list nobody acts on (Sessions pill lesson).

## Risks and costs
- An RPC reading `/tmp` must be limited to `omp-image-*` files. Temp cleanup blanks old rows.
- Depends on OMP's result shape (`details.imagePaths`, xd:// wrapper variant); drift risk.
- Mobile audio untested.

## Recommendation
Later. Ship item 40 toggles first; if users enable `generate_image`, add the inline image renderer. Skip the gallery. Ask Paseo upstream for an audio file panel rather than building one.

Other items: item 40 should note these tools render as raw JSON with the built-in provider.

## Paseo check (2026-11-05)
- Paseo already has: `generate_image` and `tts` fall to the `unknown` row with full Input/Output JSON (`packages/server/src/server/agent/providers/omp/tool-call-detail.ts:415-420`, app `tool-call-details.tsx:365-412`); rows are cut to 64 KiB (`packages/server/src/server/agent/agent-timeline-content.ts:9`). Same in 0.15.0 and v0.15.2. Client tool_call transformers can read `detail.output` (`packages/plugin/src/client/contracts.ts:205-288`).
- Registry: `futuregadget/inline-image-preview` (paseo >=0.12.0) previews base64 image blocks in any tool result and `read` calls on image paths, with an RPC for bytes. It does not read `details.imagePaths`, and truncated base64 will not render.
- Not in Paseo: an image preview for `generate_image` paths; any audio player.
- Effect on the decision: recommendation unchanged (B). When revisiting, first try that community plugin (or a small transformer keyed on `imagePaths`) before building our own.
- Unverified: whether inline-image-preview renders a `generate_image` row at all.
