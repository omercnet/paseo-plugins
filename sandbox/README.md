# Sandbox

A Paseo plugin that runs a project's workspaces, agents and terminals inside a Docker container with its own Paseo daemon. See [OVERVIEW.md](OVERVIEW.md) for behavior and limits.

## How it works

Paseo 0.13 connected hosts do the heavy lifting. The plugin starts a container from `runtime/Dockerfile`, reads its relay pairing link, and registers it with `paseo.hosts.add`. Paseo then routes the sidebar project, agents, terminals, files and Git for that host. The plugin writes no remote file, terminal or provider code, and no host-management UI: the Connected hosts plugin shows and edits the registered hosts.

```text
controller daemon                          sandbox container (one per project)
  plugin: sandbox  --docker run/exec-->     Paseo daemon + claude, codex, opencode, omp, git
  hosts.add(relay link + password)  <--TLS relay, E2EE-->  /home/paseo (named volume)
```

## Sandbox providers

`server/provider.ts` is the whole interface. A provider turns a `SandboxSpec` (key, env, revision) into a running daemon and answers `status`, `exec`, `stop` and `destroy`. Handles are opaque strings that only the issuing provider reads, so `server/service.ts`, the store and the UI never see a container id. `server/docker/provider.ts` is the only implementation; it reaches Docker through an injected `DockerCli`, so its unit tests run against an in-memory Docker. One implementation is a deliberate seam, requested ahead of the E2B provider.

To add a provider, implement the interface and pass it to `createSandboxService` in `index.server.ts`. Its contract:

- `up` is idempotent, resolves once the daemon answers, and recreates the sandbox when `spec.revision` changed while keeping stored data.
- `exec` runs as the unprivileged sandbox user and accepts stdin.
- Data lives only under `/home/paseo`. Removing the sandbox removes that data, and stopping it never does.

## Runtime image

`runtime/Dockerfile` adds only the agent CLIs and a Git credential helper to the official `ghcr.io/getpaseo/paseo` image, pinned by version and digest. A standalone base cannot be smaller: the Paseo daemon package alone is about 600 MB. The file's header lists the runtime contract any other sandbox format must meet. No secret is baked in; credentials arrive through the environment, and Codex is signed in through stdin.

The plugin bundle cannot read sibling files, so `server/docker/image.ts` embeds the Dockerfile. After editing it, run `npm run embed:dockerfile`; a test fails when they differ. The image tag is derived from the file, so an updated plugin builds a new image once.

## Credentials

Settings are readable by every client, so credentials never go there. `server/store.ts` keeps them in `$PASEO_HOME/plugin-data/sandbox/state.json` (0600) and the RPCs return names and dates only. Evidence behind the delivery choices:

| Credential | Delivery | Checked |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | environment | `claude auth status` reports `oauth_token` and `api_key` |
| `CODEX_API_KEY` | `codex login --with-api-key` on stdin | Paseo's Codex provider ignores the variable and sends a stored login |
| `OPENAI_API_KEY`, `GITHUB_TOKEN`, custom | environment | OpenCode lists keys from the environment; Git reads the token through the credential helper |

Shared host logins (`server/host-logins.ts`) are the alternative to saving a value. Claude, Codex, OpenCode and OMP are bind-mounted from the host (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `$XDG_DATA_HOME/opencode`, `PI_CODING_AGENT_DIR` or `~/.omp/agent`) because their logins rotate: one live file keeps one token lineage, where a copy would fork it. Entries a host agent would run or obey (hooks, skills, settings, `config.toml`) are overlaid read-only, which is a best-effort list and not a boundary. Missing folders on the list are created empty on the host first (Docker would otherwise create a nested mount target as a root-owned folder in the shared directory), missing files are skipped. GitHub is passed as a value from `gh auth token` because that token is not rotated. OMP is mounted at `/home/paseo/.omp-agent` with `PI_CODING_AGENT_DIR` pointing there, not at `~/.omp/agent`: Docker creates a missing mount parent as root, and omp could not then write `~/.omp/run`. OMP is a bun program, so the image installs `bun` beside it, and the sandbox daemon enables Paseo's OMP provider, which ships off. The other built-in Paseo providers (Copilot, Pi, Antigravity, Muse) are not installed in the image. A shared login suppresses the matching saved value, since `codex login` or `codex logout` in the sandbox would rewrite the host's `auth.json`. The real-Docker test mutation-checks both the overlay and that suppression.

Nothing here was verified against a paid endpoint; checks used fake keys and observed which one each CLI sent.

## Develop

```sh
bun install
cd sandbox
npm run check && npm run typecheck && npm test
```

`npm test` runs the unit tests against in-memory fakes. `npm run test:e2e:local` runs `tests/integration/*.local.e2e.test.ts` against real Docker: it builds the runtime image on first use (a few minutes, needs network), then starts, restarts, recreates and removes real containers and clones a public project. It fails, rather than skips, when Docker is unavailable. CI does not run it.

Verify against an isolated daemon, never the default one, from the repository root:

```sh
.agents/skills/deliver/scripts/dev-daemon.sh up sandbox
.agents/skills/deliver/scripts/dev-daemon.sh down sandbox
```

Remove leftovers with `docker rm -f` and `docker volume rm` on names starting `paseo-sandbox-`.

## Layout

- `shared/`: RPC contracts and the credential presets.
- `server/provider.ts`: the sandbox-provider interface. `server/docker/`: the Docker implementation (`provider.ts`, `cli.ts`, generated `image.ts`).
- `server/service.ts`: create, start, stop, remove, pairing, cloning and host registration. `server/hosts.ts` is the slice of connected hosts it uses.
- `server/credentials.ts`, `server/store.ts`, `server/host-logins.ts`: saved credentials, shared host logins, the sandbox environment and the private state file. `server/pairing.ts`, `server/repository.ts`: relay connection string and project URL parsing.
- `client/`: the Sandboxes screen, the credentials section shown in Settings, and the sidebar item.
