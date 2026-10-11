PR Radar adds a screen and a sidebar row that list the open pull requests linked to your Paseo workspaces, grouped by what needs your attention: **Needs you** (your pull requests with blockers, and review requests whose checks have finished), **Being handled** (work with an active Paseo agent), **Waiting externally** (running checks, pending reviews, external authors) and **Ready** (your mergeable pull requests). It combines each workspace's pull request status from Paseo with your GitHub identity, so it can tell your pull requests from ones you are asked to review. If the GitHub lookup fails, it does not mark rows as needing you.

## Setup

The GitHub CLI (`gh`) must be installed and authenticated on the machine running the Paseo daemon.

## Reads and sends

- Reads workspaces, agents and their linked pull requests from your Paseo host.
- Runs `gh` on the daemon host, using your `gh` credentials, to get your login, search your authored and review-requested open pull requests, and read review, mergeability and check status from GitHub.
- Remembers each pull request's last-seen state on the daemon host to show what changed since you last marked updates as seen.
- On "needs you" rows, an action sends a prompt to an existing agent in the linked workspace or starts a new agent there with one of your configured agent profiles. If there is no workspace but a local project exists, it creates a checkout of the pull request first. The prompt asks the agent to review the pull request or fix its blocker, and not to merge.
