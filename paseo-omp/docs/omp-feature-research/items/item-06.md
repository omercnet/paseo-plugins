# Item 06: Export a conversation as a web page

## What it is
OMP can turn a session into one self-contained HTML file: full transcript, tool calls rendered like the TUI, subagent transcripts, thinking blocks and the system prompt. Used to share a run with a teammate, attach it to a bug report or PR, or archive it. In the terminal it is `/export` or `omp --export <session.jsonl> [out.html]`.

## What users get today
Nothing in Paseo or the plugin (grep of paseo-omp README/OVERVIEW: no export). Paseo's timeline is the only view. The support report covers diagnostics, not conversations. Whether Paseo core has its own export for any provider is unverified.

## Works with the built-in provider?
Yes, without RPC. The bucket list mechanism (`export_html` RPC) is not needed and the built-in provider does not send it. The CLI path `omp --export <file>` needs only a session file; the plugin already reads it from `persistence.nativeHandle` (`server/rule-notices.ts`). Smoke test: ran `omp --export` on a demo session with `PI_CODING_AGENT_DIR=/tmp/omp-demo-builtin`; got an 868 KB standalone HTML in one call, no running agent needed. Tradeoff: the CLI path omits the live system prompt and tool descriptions that the in-session export embeds. Subagent transcripts are included.

## Value: low to medium
- Real but occasional: sharing/archiving a run. Not a per-message or daily need.
- Covers what Paseo does not: a portable, offline, readable artifact. Paseo agent history is only visible inside Paseo.
- Weak on remote clients: Paseo is often used from a phone or browser while the file lands on the daemon host. Getting the bytes to the user (download, open in Paseo Browser, copy path) is the hard part and is unverified for plugin surfaces.
- Overlaps OMP's `/share` (encrypted link), which is a better sharing path but needs a live slash command, so it is not available for built-in agents.

## Best surface
An agent action "Export transcript" (agent menu or Command Center item for the selected agent), no pill. The server runs `omp --export` into a temp or user-chosen directory, then shows the path or opens it. Size: S for the export itself, M if a proper download/open flow for remote clients is required. Unverified: whether plugins can add agent-menu actions, and how to hand a file to a remote client.

## Risks and costs
- Safety: OMP states the HTML is not secret-redacted or encrypted. It can hold raw context, pasted keys, tool output and image data. Needs a clear warning; `omp anonymize` exists as a redacted alternative (unverified how well it fits).
- File size: large sessions give large files (868 KB for a tiny one).
- Drift: output format is OMP's; we only call the CLI, so maintenance is low.
- Sessions with spaces in path: CLI takes a plain argument, fine; the slash command does not.

## Recommendation
Later. Cheap to build, but occasional use and an unsolved delivery path for remote users. If built, do it as a single Command Center / agent action over the CLI with an "unredacted" warning, not via RPC and not as a pill. Better value may come from asking Paseo upstream for a generic "download file from daemon" capability.

## Cross-item note
Item 16 (`/share`, `/dump`) has the same built-in-provider limit (needs live slash command); `omp --export`, `omp anonymize` are CLI-only alternatives for sharing.

## Paseo check (2026-11-05)
- Paseo already has: OMP's `/export` in the built-in omp slash menu, and it works: on the 0.15.0 test daemon it replied "Session exported to: omp-session-...html" and wrote a 44 KB HTML file into the agent's cwd. Paseo's Files panel can download any workspace file, including over relay and SSH (CHANGELOG #6595, 0.12.x; #1351 for password-protected daemons). So remote delivery, the open problem in this item, is solved.
- Community plugins: Conversation exporter (Markdown/JSON to clipboard or folder), Agent Share (Gist), Thread Share.
- Not in Paseo: a one-click Export action, or a warning that the HTML is unredacted.
- Effect on the decision: recommendation changed from A to C (Skip). Typing `/export`, then Download in Files, already does what option A would build.
- Unverified: Download on mobile for this file; the export lands in the repo folder as an untracked file, so it can be committed by accident.
