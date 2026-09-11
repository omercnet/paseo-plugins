# Changelog

## 0.0.1 (2026-09-11)

### Features

- add a read-only, workspace-scoped Beads Explorer panel and Command Center entry
- group active issues into Ready frontier, In progress, Blocked, and Other lanes using an
  authoritative `bd list --ready` snapshot
- add virtualized issue lists, search, and All, P0–P1, and Assigned filters
- add responsive issue details with context, acceptance criteria, dependencies, and dependents
- bound CLI output and RPC payloads while keeping unexpected CLI details out of client-facing errors
- add descriptive accessibility labels and focus restoration for compact list/detail navigation
- poll list and selected detail data every 10 seconds through read-only `bd` CLI calls
- report unavailable, uninitialized, empty, failed, missing-detail, and truncated states
