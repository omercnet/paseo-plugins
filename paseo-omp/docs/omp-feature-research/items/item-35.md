# Item 35: Tool policy editor (allow / ask / deny)

**Verdict:** Medium value, narrow audience. Expose the rules as a "Tool policy" card in the OMP screen's Configuration tab. Skip Forget approvals.

## What it is
Rules OMP checks before each tool call: run it, ask first, or refuse.
- `tools.approval`: a policy per tool (ask before `eval`).
- `bash.patterns`: ordered shell rules, first match wins (allow `npm test*`, block `git push --force*`).
- `tools.restrictedFolders`: folders like `~/secrets` where every action asks, in every mode.
- `/forget-approvals`: clears remembered file and folder grants.

Users: people running agents unattended who want hard stops, or who are tired of approving safe commands from a phone.

## What users get today
- Paseo: a mode picker (Full Access, Write Approval, Always Ask) passed to OMP as `--approval-mode`, plus approval cards. No per-tool or per-command rules.
- Plugin: the Configuration tab shows these keys as read-only JSON; only scalar and 7 routing keys are editable.
- Otherwise: hand-edit YAML on the daemon host.

Full Access, the default for omp agents, is OMP's yolo mode, which skips its built-in guard against commands like `rm -rf /`. User rules are the only guardrail there.

## Works with the built-in provider?
**Rules: yes.** The plugin writes them with `omp config set` on the daemon host. New sessions pick them up, running agents after a reload (OMP docs say hosts reload live; not tested). Deny, ask and restricted-folder rules still apply in Full Access. Prompts reach Paseo: bash, edit and write as permission cards, other tools as a question card (read from Paseo source).

**Forget approvals: no.** Saved grants exist only in OMP's "ask and remember" mode, which no Paseo mode launches. Session-only grants die with the process.

## Value: medium
The only middle ground between approving everything and nothing, and it works in Full Access, where risk is highest. But it is set-once and already viewable.

## Best surface and size: M
A "Tool policy" card in the Configuration tab: ordered bash rules with reorder, a folder list, per-tool rows. Adds three structured keys to the existing routing editor. No pill.

## Risks and costs
- **Allow beats the mode picker.** A saved `bash: allow` makes Always Ask run bash unasked. Show the effective result.
- **Stale on live agents.** A new Block rule may not guard a running agent until reload. Say so.
- **False safety.** Bash rules skip `eval`, are not a sandbox, and match only `*` wildcards. Offer an `eval` policy too.
- **Ask breaks subagents.** They cannot answer prompts, so matching calls fail. Warn.
- **Drift.** No OMP dry-run command exists (`omp --help`), so a pattern tester would copy its matching. Skip it.

**Recommendation:** Expose as above. Skip Forget approvals. No Paseo change needed.

**Unverified:** live reload into a running agent, how the question card looks, whether `omp config set` rejects malformed rules.

Other items: `tools.approvalMode` is editable in the plugin, but Paseo's launch flag overrides it (from code, not run).

## Paseo check (2026-11-05)
- Paseo already has: three omp modes only, Full Access, Write Approval, Always Ask, mapped to `--approval-mode yolo|write|always-ask` (`providers/omp/provider-config.ts:39-57`, v0.15.0 to v0.15.2). Mode flags are appended after any custom command (`runtime.ts:101-139`), so a profile cannot change the mode. Provider `disallowedTools` is merged (`provider-config.ts:159`) but never passed to OMP. A custom omp profile can add `--config <overlay.yml>` holding `tools.approval` or `bash.patterns` (omp 18.13.1), by hand in `config.json`. `docs/permissions.md` covers daemon access, not tool rules. No registry plugin found for OMP tool rules.
- Not in Paseo: per-tool, per-command or folder rules for any provider.
- Effect on the decision: recommendation unchanged (A).
- Unverified: whether rules in a `--config` overlay apply the same as `config.yml` rules.
