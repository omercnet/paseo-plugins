# Item 32: Hide secrets from the model

## What it is
OMP can swap secrets for placeholders (like `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`) before text goes to the model provider, and restore the real value when the model uses it in a tool call. Switch: `secrets.enabled`, off by default. It auto-detects env vars named like KEY/TOKEN/SECRET/PASSWORD, passwords in connection URLs, and common token shapes (GitHub, OpenAI, Anthropic, AWS, Slack, Stripe, JWT, PEM). Optional extra entries live in `~/.omp/agent/secrets.yml` or `<project>/.omp/secrets.yml` as `{type: plain|regex, content, mode: obfuscate|replace, replacement, friendlyName}`.

Users: anyone running agents on repos with `.env` files or real credentials, or under a "no secrets to the LLM vendor" policy. Most people never turn it on.

## What users get today
- The plugin's typed settings editor groups the `secrets.` prefix under Tools (`omp-settings.ts`), so `secrets.enabled` is likely already a toggle on the OMP screen. How it renders was not checked (unverified).
- Nothing edits `secrets.yml` or explains what the switch does.
- Paseo shows the restored local text, so users cannot see what the model received.

## Works with the built-in provider?
Yes. It is config and file only, read at session start; no RPC command needed. A `secrets.yml` editor is a daemon-side YAML read/write like other config tabs. Changes apply to new sessions.

## Value: low to medium
- Real safety value, but mostly through the on/off switch. Auto-detection covers common leaks, so custom entries are rare.
- A list editor puts secret values through Paseo's UI, daemon and remote network path for a niche need. People with custom entries can edit YAML.
- You cannot edit a value you cannot see, so a never-echo editor is just add and delete.
- No visible feedback that it is working: placeholders do not show in the timeline.
- Limits: system prompts, static tool definitions and images are not redacted; encrypted replay is opaque. Best effort, not a guarantee.

## Best surface and size
No pill. Smallest useful step (S): in the settings editor, describe `secrets.enabled` ("hides keys, tokens and passwords from the model provider; custom rules in secrets.yml") with the file paths and caveats. Optional (M): read-only count of entries per level, values never shown. Full editor: M to L, not recommended.

## Risks and costs
- Secret values in plugin code, logs, support report and transport; must never be logged or sent to the client.
- YAML round trips must keep comments and mirror OMP validation (bad entries are skipped silently).
- Schema drift (`friendlyName`, `flags`, regex literal syntax).
- False confidence.

## Recommendation
Skip the editor. Do the S step. Revisit a read-only count only if users ask.

## Unverified
Current UI rendering of `secrets.enabled`; that the built-in provider passes the setting through unchanged (expected, OMP reads it itself).

## Cross-item note
Items 35 and 40 share the Tools settings group and could carry this toggle's copy.

## Paseo check (2026-11-05)
- Paseo already has: nothing that redacts secrets before the model. No redaction code under `packages/server/src/server/agent` (searched "redact"), no setting in `public-docs/configuration.md` or `security.md` (security.md is about daemon access). The built-in omp provider launches OMP with the user's config, so `secrets.enabled` from `config.yml` applies (`providers/omp/runtime.ts:92-125` adds no override). No registry plugin found for secret redaction.
- Not in Paseo: any switch, explanation or `secrets.yml` handling.
- Effect on the decision: recommendation unchanged (A).
- Unverified: that the timeline shows restored values (expected, since OMP restores them before tool events).
