# Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its package before installing it on the daemon host.

## Requirements

- Paseo daemon and apps: `^0.9.2 || ^0.10.0 || ^0.11.0`; the 0.9.2 floor includes the plugin-provider request, reload-cleanup, and daemon-shutdown fixes required for reliable OMP provider operation, and 0.10.1 is verified against the public plugin contracts
- OMP: `18.1.15` or newer is the supported floor
- OMP RPC: protocol v2 must negotiate successfully

The first public build is an alpha. Alpha releases are compatibility previews and may require deleting and re-importing agents created by an earlier preview.

## Install or update from npm

Paseo 0.9.2 and 0.10.1 can acquire the published package directly from npm on the daemon host:

```bash
paseo plugin install npm:@omercnet/paseo-omp@<version>
paseo plugin ls paseo-omp
```

Check for the registry's current `latest` version and approve the proposed update, or select an exact version explicitly:

```bash
paseo plugin update paseo-omp
paseo plugin update paseo-omp --version <new-version>
```

The daemon uses its own npm registry and authentication configuration. A failed download, compatibility check, or activation keeps the installed revision active.
