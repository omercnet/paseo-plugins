# Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its production dependencies before installing it on the daemon host.

## Requirements

- Paseo daemon and apps: `>=0.9.0-beta.1 <0.10.0`; the 0.9 floor provides the supported plugin copy and external-link APIs, nested provider-subagent ancestry, and spawning-tool links
- OMP: `18.1.15` or newer is the supported floor
- OMP RPC: protocol v2 must negotiate successfully

The first public build is an alpha. Alpha releases are compatibility previews and may require deleting and re-importing agents created by an earlier preview.

## Install or update from npm on Paseo 0.9

Paseo 0.9.0-beta.1 can acquire the published package and its production dependencies directly from npm on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-omp@<version>
paseo plugin ls paseo-omp
```

Check for the registry's current `latest` version and approve the proposed update, or select an exact version explicitly:

```bash
paseo plugin update paseo-omp
paseo plugin update paseo-omp --version <new-version>
```

The daemon uses its own npm registry and authentication configuration. npm acquisition installs the artifact's production dependencies before preparation; because npm artifacts omit `package-lock.json`, the preparation helper leaves that tree unchanged. A Git checkout with the committed lockfile runs frozen `npm ci --omit=dev --ignore-scripts`. A failed download, preparation, compatibility check, or activation keeps the installed revision active.

## Install a Git release on Paseo 0.9

Install the matching reviewed Git tag:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref paseo-omp-v<version>
paseo plugin ls paseo-omp
```

### Update a Git installation on Paseo 0.9

An ordinary update reviews the remote repository's current default HEAD. To move directly to another reviewed tag or commit, select it explicitly:

```bash
paseo plugin update paseo-omp
paseo plugin update paseo-omp --ref paseo-omp-v<new-version>
```

The install-time `--ref` does not constrain later updates. Paseo 0.9 stages and validates the selected revision before replacing the active installation, so plugin settings remain intact and a failed update leaves the previous revision running.


## Install a local checkout

```bash
git clone https://github.com/omercnet/paseo-plugins.git
cd paseo-plugins/paseo-omp
npm ci --ignore-scripts
paseo plugin install "$PWD"
```

After editing a directory installation:

```bash
npm run check
npm run typecheck
paseo plugin reload paseo-omp
paseo plugin ls paseo-omp
```

## Track a branch

Tracking `main` executes future dependency and plugin updates with the daemon user's privileges:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref main
```

On Paseo 0.9, preview and approve the remote default HEAD with `paseo plugin update paseo-omp`, or select `main` explicitly with `paseo plugin update paseo-omp --ref main`. A failed build or compatibility check leaves the previous revision active.
