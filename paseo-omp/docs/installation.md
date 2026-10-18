# Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its package before installing it on the daemon host.

## Requirements

- Paseo daemon and apps: `^0.12.0`; background-workspace discovery (`includeBackground`) requires the `features.backgroundWorkspaces` host feature, which first ships in 0.12
- OMP: `18.1.15` or newer is the supported floor
- OMP RPC: protocol v2 must negotiate successfully

The plugin is stable. Review the release notes for any migration requirements before upgrading; supported versions and known limitations are documented in [Support](../SUPPORT.md).

## Install or update from npm

Paseo can acquire the published package directly from npm on the daemon host:

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
