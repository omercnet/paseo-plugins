# Item 36: Saved model presets

## What it is
A preset is a named snapshot of all model role assignments (default, smol, slow, plan, commit, and so on) plus `defaultThinkingLevel`. In OMP you run `/modelpreset save cheap` and later `/modelpreset switch deep` to swap a whole setup at once (for example "cheap and fast" vs "deep and expensive"). Presets live under `modelPresets` in `config.yml`. A project config can define its own presets; same-name presets are replaced whole, not merged (`omp://models.md`, "Model presets"; `omp://settings.md`).

Users: people who keep several routing setups and flip between them (budget mode for chores, strong models for hard work). Occasional, not per message.

## What users get today
- Paseo has per-agent model, thinking and mode pickers, so changing one agent's model is covered.
- Our plugin's Configuration tab has a routing editor for `modelRoles`, so a user can edit roles one by one. It has no way to save a set or swap sets. Nothing in the plugin mentions `modelPresets`.

## Works with the built-in provider?
Yes, for config. `omp config list` (checked with `PI_CODING_AGENT_DIR=/tmp/omp-demo-builtin`) shows `modelPresets = {}` as a normal record setting, so the plugin can read and write it with `omp config get/set`, like it already does for `modelRoles`. "Apply preset" is a plugin-side write of `modelRoles` and `defaultThinkingLevel` from the saved entry. This reaches new sessions, and running agents after a reload, same as every other settings edit. It does NOT switch a live session's model; that stays on Paseo's own per-agent picker. `/modelpreset` itself cannot be sent into a live built-in session (no RPC passthrough), and I did not test whether it is accepted via `prompt` (unverified).

Gaps if we re-implement apply: OMP's own switch also honors `modelRoleStorage` (global vs project), clears roles the preset omits, and reports roles a higher layer still overrides. Reproducing that in plugin code risks drifting from OMP. Cleaner: apply = write `modelRoles` + thinking level, and say plainly that it affects new sessions.

## Value: low to medium
- Real, but narrow: only users who already juggle multiple full routing setups.
- Mid-session switching, where presets shine in the terminal, is not reachable from Paseo. In Paseo the user creates an agent and picks a model, which already covers most "use a cheaper model now" needs.
- The routing editor is a rarely visited config screen. A preset dropdown there is cheap polish, not a headline feature.
- Most users keep one routing setup and never save a preset, so the list would be empty for them.

## Best surface
Inside the existing routing editor (Configuration tab): a "Presets" row with a dropdown, "Apply", "Save current as" and "Delete". No pill, no new tab. Size: S to M (schema for `modelPresets`, three actions, tests for layer precedence and null tombstones).

## Risks and costs
- Silent drift from OMP semantics (project vs global storage, tombstones, whole-entry override). Mitigate by showing which layer a preset came from and not offering project-level writes.
- "Apply" can be misread as switching running agents. Label it "applies to new sessions".
- Overwriting existing roles: needs a confirm showing the diff.
- Small maintenance surface otherwise; no provider dependency.

## Recommendation
Later. Worth doing only as a small add-on to the routing editor, bundled with other routing work (items 37 to 39), not as a standalone project. Skip if the routing editor is not otherwise being touched.

Related to other items: item 37/38 (compaction, retry) share the same routing editor, so one pass could cover all three.

## Paseo check (2026-11-05)
- Paseo already has: Agent profiles (provider, model, mode, thinking) in Settings, Agents, Agent profiles (`public-docs/agent-profiles.md`, before v0.15.0). Custom omp profiles with `smolModel`/`slowModel`/`planModel` options passed as `--smol/--slow/--plan` (`docs/custom-providers.md:439-464`, `providers/omp/provider-config.ts:18-66`, v0.15.0). OMP slash commands go through the built-in provider: tested on the 0.15.0 test daemon, `/modelpreset list` in a new built-in omp agent replied "No model presets saved. Use /modelpreset save <name> to create one." So save, switch and delete already work from the composer, live, without a plugin. Community plugin OMP Roles (paseo.sh/plugins/po-trottier/omp-roles) adds a composer pill that sends `/switch @role`.
- Not in Paseo: a preset list or Apply button in a settings screen.
- Effect on the decision: changed from B to C. The notes assumed presets could not be used in a live built-in session; they can, through `/modelpreset` in the composer. A routing-editor row would duplicate it.
- Unverified: that `/modelpreset save` and `switch` behave like the terminal (not run, to avoid writing the daemon's OMP config); that the composer slash menu lists `modelpreset`.
