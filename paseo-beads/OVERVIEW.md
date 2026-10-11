Paseo Beads shows a read-only work queue from Beads for each workspace. Active issues are sorted into Ready, In progress, Blocked and Other lanes, with search, filters and a detail view showing description, acceptance criteria, dependencies and dependents. It adds a **Beads** Explorer panel and a Command Center item. On Paseo 0.11 and newer it also adds a **Ready beads** sidebar row that counts ready work across the host's workspaces, plus a linkable screen for a single bead.

The plugin runs the `bd` CLI with `--readonly` in the workspace directory on the daemon host. It never reads or writes Beads storage directly, and it cannot create, edit, close or assign issues.

Setup:

- The `bd` CLI, version 1.0 or newer, on the daemon's `PATH`.
- A Beads project initialized in the workspace. The panel reports a missing `bd` or an uninitialized project.

Limits:

- Shows at most 500 issues per workspace and warns when counts may be incomplete.
- The **Ready beads** count covers the first 200 workspaces and can lag while the app is in the background.
- Requires Paseo ^0.9.0, ^0.10.0 or ^0.11.0. The sidebar row and bead screen need 0.11.
