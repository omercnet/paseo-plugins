# OMP feature research (2026-11)

A sweep of OMP's features, asking for each one: does it help Paseo users, and can this plugin show it for agents on Paseo's **built-in `omp` provider** (not only the plugin's own `omp-plugin` provider, which is planned for deprecation)?

Kept for future reference. The notes describe OMP 18.x and Paseo 0.15.x as of November 2026; check them against current versions before relying on a detail.

## Files

- [`bucket-list.md`](bucket-list.md): the starting list of 55 OMP features.
- [`items/`](items/): one note per researched item (53). Each says what the feature is, what users get today, whether it works with the built-in provider, the options, and a "Paseo check" of what Paseo already covers.
- [`SUMMARY.md`](SUMMARY.md): the recommendations before decisions were made.
- [`DECISIONS.md`](DECISIONS.md): the maintainer's answer for each item.
- [`GAPS.md`](GAPS.md): what needs a change in Paseo or OMP, and the bugs filed upstream.

## What shipped

| Item | Feature | PR |
|---|---|---|
| 01 | Rule-fired notice in the timeline | #504 |
| 22 | Rules tab, per-rule on/off switch, test a snippet, "View rule" link from the notice, firing counts | #506, #529, #531, #532, #533 |
| 21, 27 | Skills tab, with managed-skill badge and delete | #512 |
| 28 | Extensions tab (extensions, hooks, custom tools) | #514 |
| 46 | Security tab (stored scan results, read-only) | #523 |
| 47 | LSP diagnostics card | #510 |
| 49 | Generated image card with Download | #513 |
| 41 | `ast_edit` preview as a read-only diff card | #519 |
| 45 | Screenshots row for `eval` images | #525 |
| 11 | Spending cap fields | #507 |
| 32 | Clear wording for `secrets.enabled` | #511 |
| 40 | Optional-tool switches grouped in Configuration | #515 |
| 35 | Tool policy card | #518 |
| 33 | `lsp.json` and `dap.json` editor | #527 |
| 52 | Local models card | #528 |
| 23 | Subagent dropdown and switches in the routing editor | #516 |
| 30 | Marketplace catalogs in the OMP plugins tab | #508 |
| 54 | Update check and Update button in Diagnostics | #509 |
| 25 | Prompt-file warning in Diagnostics | #517 |
| 31 | `models.yml` check and Refresh models in Diagnostics | #520 |
| 50 | Magic keywords paragraph in Help | #526 |

Item 61 (a Sessions pill) shipped in #502 and was removed in #505: it duplicated Paseo's own session list and Import session.

Skipped items are listed in `DECISIONS.md`; most were skipped because Paseo already covers them.
