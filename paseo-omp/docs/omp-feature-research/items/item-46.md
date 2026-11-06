# Item 46: Security scan results

## What it is
OMP has an optional `security_scan` tool. The agent plans a security review of a repo, a path, a diff or the working tree, runs it in a background session, and stores the result: a scan record, findings with severity, a coverage report, a Markdown report and a SARIF file. Phases run queued, preparing, reviewing, publishing, completed (or partial, cancelled, failed). A `validate` action lets the agent mark a finding validated or rejected. A second set of actions imports scans from a ChatGPT-account cloud service. Results are readable through `security://` URLs.

Who and when: a developer who turned it on and wants an audit before a release. It is off by default (`security.enabled = false`). Native scans need a stored OAuth login (or Bedrock), so API-key-only users cannot run it at all.

## What users get today
- The agent runs the tool and reports findings in chat as text. Paseo shows the tool calls as plain rows.
- The plugin has no security view. The only trace is `security_scan` in the tool-name list used by our own provider.
- The on/off switch is already editable in the Configuration tab (see item 40).

## Works with the built-in provider?
Partly. The plugin can read OMP's files on the daemon host, so it could list scans and findings from the scan store. The exact store path is only described as "project-keyed under OMP's security state root", so it is unverified. It cannot start, cancel or validate scans, because those are tool calls inside a live session and the built-in provider has no command for that. The agent can do all of that itself when asked. SARIF download needs a way to hand files to remote clients, which is unsolved (same blocker as item 06).

## Value: low
- Off by default, OAuth-gated, and used rarely (pre-release audits).
- The agent already summarizes findings, and `/` prompts like "show the last scan" work in chat.
- A findings list nobody can act on repeats the Sessions-pill lesson. Acting (validate, start, cancel) needs live RPC we do not have.
- Severity counts are nice, but poor return for an opt-in tool.

## Best surface if ever built
A read-only "Security" section in the workspace OMP panel: latest scan phase, counts by severity, finding titles. No pill. Size S to M, plus unverified path discovery. Only worth it if users ask and Paseo can deliver files (for SARIF).

## Risks and costs
- Depends on OMP's private store layout (drift risk).
- Findings are sensitive (vulnerability details); showing them in a remote UI widens exposure, and files are mode 0600 on purpose.
- Maintenance for a rarely enabled feature.

## Recommendation: skip for now
Revisit only if (a) users report using scans regularly, and (b) Paseo gets file delivery for remote clients. The enable switch is covered by item 40.

Cross-item: item 06 has the same file-delivery problem.
