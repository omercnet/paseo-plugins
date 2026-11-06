# Item 27: Learned / managed skills (review what the agent taught itself)

**Verdict: low value today. Recommendation: later, as a "learned by agent" badge and delete action inside the planned Skills section of the Rules tab (item 21). No dedicated screen, no card, no pill.**

## What it is
An experimental OMP setting, `autolearn.enabled` (default off), gives the agent two tools. `manage_skill` creates, updates or deletes a "managed skill": a `SKILL.md` under `<agent-dir>/managed-skills/<name>/`. `learn` saves a durable lesson (project `learned.md` with the `local` memory backend, or the memory database with Mnemopi/Hindsight), and can also create a managed skill. `autolearn.autoContinue` adds a private capture turn after busy runs (costs tokens). Managed skills load into every future session unconditionally; authored skills of the same name win. Lessons apply from the next session. Users: the few who opted into this experiment and want to audit or prune what the agent wrote.

## What users get today
- Managed skills already appear in `omp skill list --json` with source `omp-managed:user` (tested on a temp agent dir). Item 21's planned Skills section would list them for free.
- Lessons in Mnemopi are covered by the Memory panel (item 55). `learned.md` (local backend) is not shown anywhere.
- `learn` and `manage_skill` calls already show as ordinary tool rows in the timeline.
- Settings (`autolearn.*`, `memory.backend`) are editable in the typed Configuration tab (listed in OMP's settings doc; not run).
- Plugin code has no autolearn awareness beyond listing the tool names.

## Works with the built-in provider?
Yes. Everything is files on the daemon host: read, edit, delete `managed-skills/*/SKILL.md` and `memories/<encoded-cwd>/learned.md`; no RPC needed. A timeline card is a client-side renderer over existing tool-call items. Changes apply to new sessions; `manage_skill` alone refreshes the live session, so edits made by us take effect after a reload or new session.

## Value: low
- Opt-in, experimental, default off; the audience today is tiny.
- Real risk it addresses is the same as rules: bad lessons silently steer later sessions. But skills act only when matched, and lessons are capped (100 entries, `local`), so blast radius is smaller than rules.
- Review already works with a text editor or by asking the agent ("delete skill X").
- A card on each tool call is noise; most value is an audit list, not per-call display.

## Best surface / size
Item 21's Skills section: add a "learned by agent" badge (source `omp-managed`), a view of the body, and delete. Marginal size S on top of item 21. A `learned.md` viewer: S, only for the `local` backend (unverified how many users run it). Edit and promote (copy to `~/.omp/agent/skills`): M, with name-collision handling.

## Risks / costs
- Drift: managed-skill layout and `learned.md` path (`memories/<encoded-cwd>/`, encoding unverified) are internal and could change; the `skill list` source tag is the safer hook.
- Writing files behind a running OMP risks races with concurrent `manage_skill` calls (OMP serializes only in-process).
- Deleting a skill the agent is mid-use of; promoting can shadow or be shadowed by same-name authored skills.
- Feature may change or be removed while experimental.

## Recommendation: later
Do nothing standalone. When the Skills section ships, include the `omp-managed` badge and delete action. Revisit a `learned.md` viewer and card only if autolearn leaves experimental status or users ask. No upstream ask needed.

Unverified: `learn` or `manage_skill` live behavior (not run, costs tokens); `learned.md` path encoding; adoption of autolearn.

Related: item 21 (Skills section), item 55 (memory rows).

## Paseo check (2026-11-05)
- Paseo already has: nothing autolearn-specific in core (grep in app, server and docs, 0.15.0 to main). `learn` and `manage_skill` render as generic tool rows. Managed skills that OMP reports reach the slash menu as kind `skill` (`packages/server/src/server/agent/providers/omp/commands.ts:73`, 0.15.0).
- Community: `koinzhang/customize` 0.4.0 scans `~/.omp/agent/managed-skills` and tags those rows `autolearn` (user scope), with a preview, Open and Reveal (`customize/server/providers/omp.ts`, skills block). That is the "learned by agent" badge plus view, read-only.
- Not in Paseo or plugins: delete or promote of a managed skill, and a `learned.md` viewer.
- Effect on the decision: unchanged (A), narrowed. The badge and body view already exist in Customize, so the only new part when the Skills section ships is a delete action (size S or less).
- Unverified: Customize hardcodes `~/.omp/agent`, so it misses custom agent dirs or profiles.
