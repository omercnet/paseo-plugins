# Sandbox

A Paseo plugin that runs a project's workspaces, agents and terminals inside a Docker container with its own Paseo daemon. See [OVERVIEW.md](OVERVIEW.md) for behavior and limits.

## How it works

Paseo 0.13 connected hosts do the heavy lifting. The plugin starts a container from `runtime/Dockerfile`, reads its relay pairing link, and registers it with `paseo.hosts.add`. Paseo then routes the sidebar project, agents, terminals, files and Git for that host. The plugin writes no remote file, terminal or provider code, and no host-management UI: the Connected hosts plugin shows and edits the registered hosts.

```text
controller daemon                          sandbox container (one per project)
  plugin: sandbox  --docker run/exec-->     Paseo daemon + claude, codex, opencode, git
  hosts.add(relay link + password)  <--TLS relay, E2EE-->  /home/paseo (named volume)
```

## Sandbox providers

`server/provider.ts` is the whole interface. A provider turns a `SandboxSpec` (key, env, revision) into a running daemon and answers `status`, `exec`, `stop` and `destroy`. Handles are opaque strings that only the issuing provider reads, so `server/service.ts`, the store and the UI never see a container id. `server/docker.ts` is the only implementation.

To add a provider, implement the interface and pass it to `createHandlers` in `index.server.ts`. Its contract:

- `up` is idempotent, resolves once the daemon answers, and recreates the sandbox when `spec.revision` changed while keeping stored data.
- `exec` runs as the unprivileged sandbox user and accepts stdin.
- Data lives only under `/home/paseo`. Removing the sandbox removes that data, and stopping it never does.

## Runtime image

`runtime/Dockerfile` adds only the agent CLIs and a Git credential helper to the official `ghcr.io/getpaseo/paseo` image, pinned by version and digest. A standalone base cannot be smaller: the Paseo daemon package alone is about 600 MB. The file's header lists the runtime contract any other sandbox format must meet. No secret is baked in; credentials arrive through the environment, and Codex is signed in through stdin.

The plugin bundle cannot read sibling files, so `server/docker-image.ts` embeds the Dockerfile. After editing it, run `npm run embed:dockerfile`; a test fails when they differ. The image tag is derived from the file, so an updated plugin builds a new image once.

## Credentials

Settings are readable by every client, so credentials never go there. `server/store.ts` keeps them in `$PASEO_HOME/plugin-data/sandbox/state.json` (0600) and the RPCs return names and dates only. Evidence behind the delivery choices:

| Credential | Delivery | Checked |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | environment | `claude auth status` reports `oauth_token` and `api_key` |
| `CODEX_API_KEY` | `codex login --with-api-key` on stdin | Paseo's Codex provider ignores the variable and sends a stored login |
| `OPENAI_API_KEY`, `GITHUB_TOKEN`, custom | environment | OpenCode lists keys from the environment; Git reads the token through the credential helper |

Nothing here was verified against a paid endpoint; checks used fake keys and observed which one each CLI sent.

## Develop

```sh
bun install
cd sandbox
npm run check && npm run typecheck && npm test
```

`npm test` runs the unit tests with fakes. `npm run test:integration` runs `tests/integration/*.itest.ts` against real Docker: it builds the runtime image on first use (a few minutes, needs network), then starts, restarts, recreates and removes real containers and clones a public repository. It fails, rather than skips, when Docker is unavailable. CI does not run it.

Verify against an isolated daemon, never the default one:

```sh
.agents/skills/deliver/scripts/dev-daemon.sh up sandbox
.agents/skills/deliver/scripts/dev-daemon.sh down sandbox
```

Remove leftovers with `docker rm -f` and `docker volume rm` on names starting `paseo-sandbox-`.

## Layout

- `shared/`: RPC contracts and the credential presets.
- `server/provider.ts`, `server/docker.ts`: provider interface and Docker implementation.
- `server/service.ts`: create, start, stop, remove, pairing, cloning and host registration.
- `server/store.ts`, `server/pairing.ts`: private state file and relay connection string.
- `client/`: the Sandboxes screen, the credentials section and the sidebar item.
