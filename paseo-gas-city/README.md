# Paseo Gas City

A Paseo control plane for observing and operating Gas City supervisors. It adds a global Gas City
surface and a workspace-scoped Factory panel.

## Screenshots

These screenshots use a temporary local Gas City v1.4.1 fixture. They contain no private project
or session data.
Wide captures omit Paseo's host navigation so the plugin surface remains the focus.

### Wide overview

![Gas City supervisor, city status, sessions, convoys, and work](docs/images/paseo-gas-city-wide-overview.webp)

### Work and event feed

![Gas City sessions, work, and recent event feed](docs/images/paseo-gas-city-wide-events.webp)

### Guarded dispatch

![Observe-only Gas City dispatch confirmation](docs/images/paseo-gas-city-dispatch-confirmation.webp)

### Compact layout

![Gas City compact mobile layout](docs/images/paseo-gas-city-compact-overview.webp)

## What it does

- Discovers the configured supervisor and shows its cities, health, version, and diagnostics.
- Shows city-wide status and recent events, plus rig-filtered sessions and work. Convoys without
  upstream rig attribution remain visible in mapped workspace views.
- Maps a Paseo workspace to a Gas City rig by explicit override or longest ancestor path.
- Provides **Open Gas City**, **Configure Gas City**, and workspace **Open Gas City Factory** commands.
- Provides `/sling <bead-id> [agent-role]` to prefill a confirmed dispatch from a workspace.
- When mutations are enabled, supports confirmed bead dispatch plus wake, message, submit, stop,
  suspend, close, and kill session actions.

## Configure

Gas City settings are host-scoped and shared by every Paseo client connected to that daemon:

- **Supervisor endpoint** defaults to `http://127.0.0.1:8372`.
- **Allow remote endpoint** opts into daemon-side requests to a non-loopback host.
- **Enable mutations** unlocks confirmed dispatch and session controls; observation remains available
  while it is off.
- **Refresh interval** and **event limit** control dashboard polling and bounded event pages.
- **Workspace mappings** override automatic longest-ancestor rig matching when a workspace is
  ambiguous or lives outside its rig path.

Settings are a safety and routing configuration, not a credential vault. Put authentication and
network access controls in front of Gas City itself.

## Safety defaults

The default endpoint is `http://127.0.0.1:8372`. Non-loopback endpoints are rejected unless **Allow
remote endpoint** is enabled. Mutations are disabled by default, and mutation RPCs require explicit
confirmation even after they are enabled. These controls are an interactive safety interlock, not
an authorization boundary; Gas City remains responsible for access control. Responses, lists, and
strings are bounded and validated before they reach the UI.

Paseo plugins are trusted, unsandboxed code. Review the source before installing it on the daemon
host. Enabling a remote endpoint sends requests to that host from the Paseo daemon.

## Requirements and limitations

- Paseo `^0.8.0` with plugins enabled.
- A reachable Gas City v1.4.1 supervisor exposing its HTTP API.
- HTTP or HTTPS endpoints only. Credentials, query strings, and fragments are rejected.
- Automatic workspace mapping requires the workspace path to be inside exactly one discovered rig;
  ambiguous or unrelated paths need an explicit mapping.
- The dashboard polls at the configured interval. Supervisor events are a head snapshot, city event
  pages expose continuation cursors, and bounded or partial responses are marked truncated.
- **Open in Paseo is unavailable with Gas City v1.4.1.** `POST
  /v0/city/{cityName}/session/{id}/messages` returns a request ID and city event cursor, but
  `/v0/city/{cityName}/session/{id}/stream` emits transcript events with no request, message, or
  turn correlation ID. A provider would therefore be unable to assign a reply to a Paseo prompt
  safely when the session produces independent output.

## Install

From GitHub:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-gas-city
```

Update an existing Git installation with:

```bash
paseo plugin update gas-city
```

From a local checkout on the Paseo daemon host:

```bash
git clone https://github.com/omercnet/paseo-plugins.git
cd paseo-plugins/paseo-gas-city
bun install --frozen-lockfile
paseo plugin install "$PWD"
```

Start or confirm the Gas City supervisor before opening the plugin:

```bash
gc start /path/to/city
gc status /path/to/city --json
paseo plugin ls
```

`paseo plugin ls` must report `gas-city` as `running` with no load error.

Open **Gas City** from the sidebar or Command Center. Configure the supervisor endpoint and optional
workspace mappings under **Gas City settings**. In a workspace, open the **Factory** panel for the
mapped rig.

## Develop

```bash
bun install
bun run check
bun run typecheck
bun test
bun run test:coverage
bun run verify:package
```

Build and verify the distributable archives with:

```bash
bun run verify:package
bun run package:release
```

Release Please maintains the package version, changelog, component tag, and GitHub release. Tags use
`paseo-gas-city-v<version>`. The release workflow re-runs checks, typechecking, coverage, and package
verification before uploading the ZIP asset and its SHA-256 checksum.

The package is `@omercnet/paseo-gas-city` at version `0.0.1`. The supported distribution paths are
the Git source above and the versioned GitHub release ZIP.
