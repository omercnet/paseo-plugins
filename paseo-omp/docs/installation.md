# Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its production dependencies before installing it on the daemon host.

## Requirements

- Paseo daemon and apps: `^0.8.0`
- OMP: `18.1.15` or newer is the supported floor
- OMP RPC: protocol v2 must negotiate successfully

The first public build is an alpha. Alpha releases are compatibility previews and may require deleting and re-importing agents created by an earlier preview.

## Install a release

Prefer a reviewed release tag over a moving branch:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref paseo-omp-v<version>
paseo plugin ls paseo-omp
```

A tag-pinned installation does not advance through `paseo plugin update`. To upgrade, record the current installation, then replace it with the new tag in one maintenance window:

```bash
paseo plugin ls paseo-omp --json > paseo-omp-before-update.json
paseo plugin remove paseo-omp
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref paseo-omp-v<new-version>
```

Removal deletes plugin-scoped settings and briefly makes `omp-plugin` unavailable. It does not modify Paseo's bundled `omp` provider or native OMP transcripts. Roll back by repeating the remove/add sequence with the recorded tag or commit.

## Install a release archive

Release ZIPs contain the production dependency tree and install offline. Authenticate provenance before installation:

```bash
gh attestation verify paseo-omp-v<version>.zip --repo omercnet/paseo-plugins
sha256sum --check paseo-omp-v<version>.zip.sha256
unzip paseo-omp-v<version>.zip
paseo plugin install "$PWD/paseo-omp"
```

The checksum detects accidental corruption; the GitHub attestation authenticates the artifact.

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

Tracking `main` executes future dependency and plugin updates with the daemon user's privileges. Record the installed commit before each update:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref main
paseo plugin ls paseo-omp --json > paseo-omp-before-update.json
paseo plugin update paseo-omp
```

A failed Git build or incompatible update leaves the previous revision active. Remove and re-add the recorded commit to roll back.
