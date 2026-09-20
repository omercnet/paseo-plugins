# Queens

A cross-platform Queens logic game for Paseo. Play from the global sidebar or open the compact composer mini-game while agents work in the background.

## Screenshots

These screenshots use synthetic workspace and agent names on an isolated Paseo daemon.

### Full game

![Queens full game with an 8×8 puzzle](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/queens/docs/images/queens-wide.png)

### Compact 14×14 board

![Queens compact layout with a 14×14 hard puzzle](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/queens/docs/images/queens-compact.png)

### Composer mini-game

![Queens composer pill and playable popover](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/queens/docs/images/queens-composer.png)

## What it does

- Provides a global **Queens** sidebar surface and Command Center entry.
- Adds a **Queens** composer pill to every active agent.
- Opens a playable anchored popover on wide layouts and a compact sheet on mobile.
- Supports 5×5 through 14×14 boards at Beginner, Easy, Medium, and Hard levels.
- Stores progress, completion records, selected size, and difficulty in host-scoped settings.
- Shares progress and undo history between the full surface and composer mini-game.
- Shows the number of running agents and notifies you when they all become idle.

## How to play

Place exactly one queen in every row, column, and colored region. Queens may not touch, including diagonally.

- Tap or click once to place or remove an X.
- Double-tap or double-click to place or remove a queen.
- Drag from an empty square to mark multiple Xs.
- Drag from an X to erase multiple Xs.
- Use **Hint**, **Undo**, and **Reset** when needed.

## Puzzle catalog

The catalog contains 97,184 curated puzzles across 40 size and difficulty combinations. Puzzle layouts, classifications, and solutions are sourced from the public [Queens Ultimate](https://queensultimate.com/) puzzle corpus.

The compact groups live in an unlisted, revision-pinned [GitHub Gist](https://gist.github.com/omercnet/652af12e2640979ba7fb5dc5adddde42). The Paseo daemon fetches only the selected group, verifies its SHA-256 digest, and caches it for the session. Opening a size and difficulty for the first time therefore requires network access to `gist.githubusercontent.com`.

The importer validates every public index and source chunk, then writes the 40 upload payloads and a manifest to `/tmp/queens-curated-gist` by default:

```bash
npm run import:puzzles
```

After uploading those files to an unlisted Gist, regenerate the pinned runtime manifest with the immutable Gist revision:

```bash
QUEENS_GIST_ID=<gist-id> \
QUEENS_GIST_REVISION=<revision-sha> \
npm run import:puzzles
```

## Install

### Paseo 0.9 beta

Install the published npm package on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-queens
```

Update an npm installation:

```bash
paseo plugin update queens --check
paseo plugin update queens
```

### Paseo 0.8

Install from this monorepo:

```bash
paseo plugin install omercnet/paseo-plugins:queens
```

Or install a local checkout by absolute path on the daemon host:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/queens
```

Open **Queens** from the sidebar or Command Center. Open any agent session to use the composer mini-game.

## Develop

Use an isolated Paseo home and explicit host. Never reload this development checkout against your default daemon.

```bash
npm ci
npm run check
npm run typecheck
npm test

paseo daemon config set daemon.listen 127.0.0.1:6802 --home /tmp/queens-dev
paseo daemon config set daemon.relay.enabled false --home /tmp/queens-dev
paseo daemon config set features.webUi.enabled true --home /tmp/queens-dev
paseo daemon config set pluginsEnabled true --home /tmp/queens-dev
paseo daemon start --home /tmp/queens-dev
paseo plugin install "$PWD" --host 127.0.0.1:6802
```

Release Please owns package versions, changelog generation, component tags, and GitHub releases.

## Requirements

- Paseo `^0.8.0` or `^0.9.0-beta.1`
- Plugins enabled on the target daemon
- React Native-compatible Paseo client on web, desktop, iOS, or Android

## License

MIT. See [LICENSE](./LICENSE).
