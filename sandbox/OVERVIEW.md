Sandbox runs one project in its own Docker container. The container holds a complete Paseo daemon, so the project's workspaces, agents, terminals and Git commands all execute inside it instead of on your machine. Paseo shows the project in the normal sidebar as a connected host, and its agents appear under the Subagents track of any agent that starts them.

Open **Sandboxes** in the sidebar, enter a project (`owner/repo` on GitHub or an https URL) and press Create. The plugin builds the runtime image the first time, starts the container, clones the project inside it, registers the container as a host and opens the project. Stop keeps the project data. Remove deletes the container and everything stored in it.

The plugin only provisions. Each sandbox is saved as an ordinary connected host, so its connection status, label and metadata can be inspected and edited in the Connected hosts plugin, or with `paseo host`. Starting a sandbox refreshes only its connection and re-enables it; it never rewrites a label or metadata you changed.

## Setup

Requires Paseo 0.13 and Docker on the machine that runs the Paseo daemon. The daemon user must be able to run `docker`. The first sandbox builds a runtime image of about 2.6 GB from the official Paseo image plus the Claude Code, Codex and OpenCode CLIs, so it needs network access and a few minutes.

Credentials are a one-time setup. Save what your agents need under Settings, Sandbox credentials (the Sandboxes screen links there):

- **Claude subscription token** from `claude setup-token`. It is valid for one year, and the plugin warns 30 days before it expires.
- **Anthropic API key**, **OpenAI API key for Codex** and **OpenAI API key for OpenCode**.
- **GitHub token** for cloning private repositories and pushing over https.
- Any other environment variable, such as a different provider's key.

Or share this host's own logins instead of saving values (Settings, Shared logins, off by default). Each switch covers one tool: Claude, Codex, OpenCode or GitHub.

- **Claude, Codex and OpenCode** mount the tool's folder from this host read-write, so the sandbox and the host are one client of one login, like two agents on the same machine. A refreshed token is written back where the host sees it. Hooks, skills, plugins, commands and settings files that exist in those folders are mounted read-only. That list is best effort, not a boundary: a sandbox agent can still read and change the rest of the folder, including history, and on Claude the MCP tokens kept beside the login. Turn it on only for sandboxes you trust. Linux hosts only, and the folder must be owned by uid 1000, the user agents run as inside the sandbox.
- **GitHub** runs `gh auth token` on this host when a sandbox starts and passes the result as `GITHUB_TOKEN`. It has every scope your `gh` login has. It is read again at each start but is not watched, so after a new `gh auth login`, restart the sandbox.
- While a login is shared, the matching saved values are ignored, because the tool would otherwise prefer them to the shared login: the Claude token and Anthropic key for Claude, the OpenAI key for OpenCode, the Codex API key (signing it in would overwrite the host's `auth.json`) and the GitHub token.
- Folder paths come from the daemon's environment and are fixed when the container is created. After changing `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME` and restarting the daemon, remove and recreate the sandbox. Paths with a comma or quote are refused.

Every sandbox receives the saved values when it starts. Changing a value marks running sandboxes as using older credentials, and Restart applies it without losing project data.

## What it reads, sends and stores

Credentials and sandbox records live in a private file under the daemon's Paseo home, `plugin-data/sandbox/state.json`, readable only by the daemon user. They are never sent to the app, never shown again after saving, and are written only to the sandboxes that start afterwards. The daemon also stores each sandbox's random connection password, as Paseo does for any connected host.

The app reaches a sandbox through Paseo's relay over TLS with end-to-end encryption and that password. The container publishes no ports, mounts only its own volume unless you share a host login, has no Docker socket, drops all but four Linux capabilities and runs agents as a non-root user.

## Limits

- Docker is the only sandbox provider. A container limits what an agent can reach on your machine, but it is not a hard security boundary, and agents inside have outbound network access and the credentials you saved.
- Containers have no CPU, memory or process limits, and the default Docker network lets them reach the host's LAN.
- A saved value is visible to anyone who can run `docker inspect` on the daemon host, and to every process inside that sandbox.
- A ChatGPT, Claude or OpenCode login that rotates tokens must not be copied: two holders of one refresh token can log each other out. Share the host's login with the switches above (one file, one lineage), or sign in inside one sandbox: `docker exec -it -u paseo paseo-sandbox-<id> codex login`. That login persists in that sandbox's volume.
- On macOS Claude keeps its login in the Keychain, not in a folder, so there is nothing to mount.
- The image has no `gh` CLI, so pull request status and creation are unavailable inside a sandbox. Agents can still push with the GitHub token.
- A rejected or revoked key shows up as an error in the agent's conversation. Only the Claude token has a known lifetime.
- Clients that were already open when a sandbox was removed can keep showing its projects until their cached host data is cleared.
