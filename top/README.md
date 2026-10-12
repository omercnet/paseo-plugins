# Top

A Paseo plugin that shows CPU, memory, disk and disk I/O of a host in the sidebar footer, and which agent sessions are responsible. See [OVERVIEW.md](OVERVIEW.md) for behavior.

## Screenshots

![Top screen with host resource gauges and per-session load](https://raw.githubusercontent.com/omercnet/paseo-plugins/pr-assets-top/top-screen.jpg)

## Develop

```sh
bun install
cd top
npm run check && npm run typecheck && npm test
```

Verify against an isolated daemon, never the default one:

```sh
.agents/skills/deliver/scripts/dev-daemon.sh up top
.agents/skills/deliver/scripts/dev-daemon.sh down top
```

## Layout

- `shared/usage.ts`: the `top.usage` RPC contract and history constants.
- `server/usage.ts`: CPU, memory, disk and I/O readers, and the sampler with its history ring.
- `server/processes.ts`: `/proc` scan and attribution of processes to agent sessions.
- `server/names.ts`: joins agent and workspace names onto sessions.
- `index.server.ts`: wires the sampler to the RPC.
- `client/`, `index.client.tsx`: footer row, Top screen, dials and session list.
- `tests/`: unit tests; process tests run against a fake `/proc` tree.
