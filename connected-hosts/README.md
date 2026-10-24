# Connected hosts

A Paseo plugin that manages the hosts saved on a daemon from the app: add, edit, disable, enable and remove, with live connection status. See [OVERVIEW.md](OVERVIEW.md) for behavior.

## Screenshots

![Connected hosts screen with an online and an unreachable host](https://raw.githubusercontent.com/omercnet/paseo-plugins/pr-assets-connected-hosts/connected-hosts-screen.jpg)

![Edit host form with a write-only connection field](https://raw.githubusercontent.com/omercnet/paseo-plugins/pr-assets-connected-hosts/connected-hosts-edit.jpg)

It is client only. Everything goes through `usePaseo().hosts` (`list`, `observe`, `add`, `update`, `remove`), so there is no server entry and no plugin RPC.

## Develop

```sh
bun install
cd connected-hosts
npm run check && npm run typecheck && npm test
```

Verify against an isolated daemon, never the default one:

```sh
.agents/skills/deliver/scripts/dev-daemon.sh up connected-hosts
.agents/skills/deliver/scripts/dev-daemon.sh down connected-hosts
```

## Layout

- `index.client.tsx`: registers the screen, the sidebar row and the Command Center action.
- `client/hosts.ts`: metadata parsing, add and update builders (an update sends only changed fields), and the live directory hook.
- `client/screen.tsx`: host cards, the add and edit form, and the remove confirmation.
- `client/sidebar.tsx`: the sidebar row.
- `tests/`: unit tests for the builders, the directory message handling and the entry.
