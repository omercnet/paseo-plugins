# Paseo OMP plugin

Community OMP integration for Paseo. The direct provider owns the production `omp` identity and registers no compatibility alias.

## Install and update

Paseo plugins are trusted, unsandboxed code. Review this plugin and its production dependencies before installing it on the daemon host.

The daemon and every Paseo app that loads the client entry must satisfy Paseo `^0.8.1`. OMP `18.1.15` is the oldest release exercised by the real-binary regression job; compatible builds must negotiate `rpc-ui` protocol v2.

Install the default branch from the public monorepo, then confirm the runtime is healthy:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp
paseo plugin ls paseo-omp
```

Git installations run the manifest's frozen production dependency install. They track the default branch unless `--ref paseo-omp-v<version>` pins a release tag. Update a tracked installation with:

```bash
paseo plugin update paseo-omp
paseo plugin ls paseo-omp
```

A failed build or incompatible update leaves the previously installed revision active.

For a reviewed local checkout:

```bash
git clone https://github.com/omercnet/paseo-plugins.git
cd paseo-plugins/paseo-omp
bun install --frozen-lockfile --production
paseo plugin install "$PWD"
```

Release assets contain the same installable directory. Verify the adjacent SHA-256 file, extract the archive, install its frozen production dependencies, and pass the extracted `paseo-omp` directory to `paseo plugin install`.

## Provider profile migration

Paseo 0.8 passes plugin-specific configuration through each agent's `providerOptions`. Move the executable, environment, and OMP parameters from the former `agents.providers.omp` entry without changing their field names:

```json
{
  "provider": "omp",
  "providerOptions": {
    "command": ["/opt/omp/bin/omp"],
    "env": {
      "OPENAI_API_KEY": "..."
    },
    "params": {
      "sessionDir": "/var/lib/omp/sessions",
      "rpcTimeoutMs": 60000,
      "smolModel": "openai/gpt-5-mini",
      "slowModel": "anthropic/claude-opus-5",
      "planModel": "openai/gpt-5.4"
    }
  }
}
```

| Legacy `agents.providers.omp` field | Production `omp` plugin migration |
| --- | --- |
| `command` | `providerOptions.command` |
| `env` | `providerOptions.env` |
| `params.sessionDir` | `providerOptions.params.sessionDir` |
| `params.rpcTimeoutMs` | `providerOptions.params.rpcTimeoutMs` |
| `params.smolModel` / `slowModel` / `planModel` | Same keys under `providerOptions.params` |
| `models` / `additionalModels` | Provider profile `models` / `additionalModels`; core applies them to the discovered plugin catalog |
| `disallowedTools` | Provider profile `disallowedTools`; core forwards its bounded generic deny-list to the OMP launch |

`command` replaces the complete executable prefix. Session launch environment values override `providerOptions.env`. `sessionDir` becomes OMP's `--session-dir`; role models become `--smol`, `--slow`, and `--plan`. `rpcTimeoutMs` applies to startup, RPC requests, catalog discovery, and availability probes.

Provider options are strict and normalized once by Paseo before availability, cache-key lookup, discovery, session listing, and launch. Unknown fields fail configuration validation. Profile `settings` and provider options contribute to the provider-owned catalog cache key; configured models replace or extend the resulting catalog in the host.

Non-persisted Paseo sessions use OMP's `--no-session`. An ephemeral native session has no resumable handle, so a later runtime failure fails visibly and requires a new Paseo session. Persistent recovery retains the complete launch template while replacing only the model and thinking level confirmed by OMP.

`full`, `write`, and `ask` modes are advertised only when Paseo negotiates provider permission support. OMP's trusted typed approval frames become `kind: "tool"` permissions when both sides opt in to `typedToolApprovals: 1`; builds without that capability retain the bounded generic extension-question flow. Approval mode changes still require a new session.

For text-only models, image inputs are materialized into a private, size-bounded temporary directory and removed when the turn, session, or provider connection ends. This relies on the direct provider process and its OMP child sharing the daemon host filesystem; remote execution belongs behind a transport that owns file transfer.

The plugin uses only public contracts. Development dependencies remain pinned to the last published Paseo 0.8.0 packages until 0.8.1 is released; the manifest is the runtime compatibility authority.

## Compatibility

This release requires Paseo `^0.8.1` on the daemon and every app that loads its client entry. That core release removes the bundled OMP registration, adapts legacy OMP persistence handles for plugin providers, and includes direct nested-subagent ancestry support.

OMP `18.1.15` is the oldest version tested end to end. The direct provider's hard compatibility gate is `rpc-ui` protocol v2: metadata-free legacy ready frames and v1-only runtimes are rejected before a provider session opens because they cannot support the advertised persistence and conversation-rewind capabilities. Typed tool approvals remain capability-gated and fall back as described above.

## Coordinated release and rollback

This cutover is atomic across repositories: Paseo 0.8.1 removes the bundled `omp` registration and accepts legacy bundled OMP persistence handles, while this plugin registers `omp` and requires Paseo `^0.8.1`.

Agents created under the former preview identity are intentionally not aliased. Import their native OMP transcript after the cutover to create an `omp` agent.

Release in this order:

1. Publish the plugin artifact, but do not activate it on an older daemon.
2. Release Paseo 0.8.1 with the bundled registration removed.
3. Upgrade the daemon and install or update this plugin in the same maintenance window.
4. Verify the provider snapshot contains exactly one `omp` entry, then resume an existing OMP agent and import one native OMP session.

Pre-0.8.1 cores reject this plugin before registration because they do not satisfy or recognize its manifest requirement. A mis-versioned core that still reserves the bundled `omp` ID rejects installation with `cannot register builtin provider ID "omp"`; the plugin never falls back to a second identity or overrides the bundled adapter.

To roll back before the cutover is accepted, disable or remove this plugin first, then restore the pre-0.8.1 core so its bundled `omp` registration is the sole owner. Do not leave the production plugin enabled while downgrading. Existing agents keep provider `omp`; the 0.8.1 adapter preserves their legacy native handle while the plugin converts that handle to its versioned OMP session ID for resume. Before either direction of the release, run the package/core integration test from a source checkout:

```sh
PASEO_LEGACY_CORE_ROOT=/path/to/paseo-legacy \
PASEO_CUTOVER_CORE_ROOT=/path/to/paseo-cutover \
  bun run test:integration:core
```

## Support

See [SUPPORT.md](SUPPORT.md) for ownership, escalation boundaries, supported versions, security reporting, and the repeatable OMP RPC compatibility intake process.
