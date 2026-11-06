# Item 54: `omp gc` (free disk space) and `omp update` (update button)

## What it is
Two host maintenance commands.

- `omp gc`: storage garbage collection for `~/.omp`. Dry-run by default, `--apply` to act, `--json` output. Phases: sweep unreferenced blobs, archive cold sessions, checkpoint database WAL files, prune stale markers and old debug reports (`--stale`), filesystem compression of idle sessions (`--compress`, APFS/NTFS only). Verified via `omp gc --help` and a dry-run on an isolated agent dir (omp 18.13.1).
- `omp update`: checks for and installs a new OMP release. `--check` is read-only, `--canary`/`--stable` switch channels. Verified: `omp update --check` printed "Current version: 18.13.1 / New version available: 18.16.0".

Who: anyone running Paseo for weeks. Transcripts and blobs grow with every agent run, and the daemon host is often a remote box nobody opens a shell on. Updates matter because Paseo's OMP support is tied to the installed version.

## What users get today
The Diagnostics tab shows the installed version (`provider-diagnostics.ts` probes `omp --version`) but never says whether it is outdated. Nothing in Paseo or the plugin reports OMP disk usage or runs gc. Both need a terminal on the daemon host.

## Works with the built-in provider?
Yes. Both are plain CLI commands on the daemon host, no RPC into a session. The plugin already runs a bounded `omp --version` probe server-side; `omp update --check` and `omp gc --json` fit the same pattern.

## Value
- Update check: medium. Cheap, answers "am I behind?" next to a version users already look at. The install step is weaker: install method (npm, brew, installer) decides whether self-update works, and an update swaps the binary under running agents. Unverified: self-update on every install method.
- gc: low to medium. Real on long-lived hosts, but only a dry-run byte report is useful; blind "free disk space" is risky. Archiving cold sessions may make them non-resumable (unverified; compress stays resumable per docs).

## Best surface
Diagnostics tab, next to the version row. No pill, no panel.
1. "Update available: 18.16.0" line from `omp update --check`, refreshed by the existing Refresh button, plus an Update button with a confirm dialog (running agents keep the old binary until restarted). Size S.
2. Optional Storage row: `omp gc --json` dry run (blobs and WAL only), show reclaimable bytes, "Clean up" runs `--apply` with the same flags. Size S to M. Never pass archive, stale or compress.

## Risks and costs
- Update: binary swap during live sessions; install-method mismatch; keep canary CLI only. Cache the network check.
- gc: deletes files behind Paseo's back; never archive sessions; handle `gc.lock` contention. Flags are OMP internals and may drift.

## Recommendation
Expose the update check and Update button on the Diagnostics tab now (S). Defer gc until a user reports disk pressure; if added, dry-run first, blobs and WAL only.
