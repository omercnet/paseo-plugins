# Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its package before installing it on the daemon host.

## Requirements

- Paseo daemon and apps: `>=0.9.0 <0.10.0`; the 0.9 floor provides the supported plugin copy and external-link APIs, nested provider-subagent ancestry, and spawning-tool links
- OMP: `18.1.15` or newer is the supported floor
- OMP RPC: protocol v2 must negotiate successfully

The first public build is an alpha. Alpha releases are compatibility previews and may require deleting and re-importing agents created by an earlier preview.

## Install or update from npm on Paseo 0.9

Paseo 0.9.0 can acquire the published package directly from npm on the daemon host:

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
