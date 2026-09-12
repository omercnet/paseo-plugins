# Paseo OMP plugin

Community OMP integration for Paseo. The direct provider is currently registered as `omp-plugin` while Paseo still bundles the `omp` provider.

## Provider profile migration

Paseo 0.8 passes plugin-specific configuration through each agent's `providerOptions`. Move the executable, environment, and OMP parameters from the former `agents.providers.omp` entry without changing their field names:

```json
{
  "provider": "omp-plugin",
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

| Legacy `agents.providers.omp` field | `omp-plugin` migration |
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

`full`, `write`, and `ask` modes are advertised only when Paseo negotiates provider permission support. OMP's trusted typed approval frames become `kind: "tool"` permissions when both sides opt in to `typedToolApprovals: 1`; older OMP builds retain the bounded generic extension-question flow. Approval mode changes still require a new session.

For text-only models, image inputs are materialized into a private, size-bounded temporary directory and removed when the turn, session, or provider connection ends. This relies on the direct provider process and its OMP child sharing the daemon host filesystem; remote execution belongs behind a transport that owns file transfer.

The plugin uses only public contracts. Development dependencies remain pinned to Paseo 0.8.0 until the accepted core APIs are released; compatibility typing does not add file dependencies or unpublished package versions.

## Compatibility

This release requires Paseo `^0.8.1`. Provider-owned OMP child sessions rely on direct nested-subagent ancestry support introduced after Paseo 0.8.0.

The direct provider requires an OMP build that negotiates `rpc-ui` protocol v2. Metadata-free legacy ready frames and v1-only runtimes are rejected before a provider session opens because they cannot support the advertised persistence and conversation-rewind capabilities.
