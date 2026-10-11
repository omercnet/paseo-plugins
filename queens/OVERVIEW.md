Queens is a logic puzzle you can play while agents work. Place one queen in every row, column and colored region, with no two queens touching, even diagonally. It adds a **Queens** sidebar surface and Command Center entry, plus a **Queens** pill in each agent's composer that opens a playable popover (a sheet on mobile).

## Setup and network

Requires Paseo 0.9, 0.10 or 0.11, and the package declares Node 24 or later for the daemon host.

Puzzle data is fetched from a revision-pinned GitHub Gist on `gist.githubusercontent.com`. The daemon downloads only the size and difficulty you open, verifies it against a SHA-256 digest and keeps it for the session. The first open of each puzzle group needs network access. The fetched content is puzzle data, not code.

Progress, hint use and completion records are saved in host-scoped plugin settings, so the sidebar surface and the composer game share one saved game.
