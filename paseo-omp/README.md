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
| `models` / `additionalModels` | Blocked by the catalog API; rejected visibly |
| `disallowedTools` | Blocked by missing generic deny-list semantics; rejected visibly |

`command` replaces the complete executable prefix. Session launch environment values override `providerOptions.env`. `sessionDir` becomes OMP's `--session-dir`; role models become `--smol`, `--slow`, and `--plan`. `rpcTimeoutMs` applies to both startup and RPC requests.

Non-persisted Paseo sessions use OMP's `--no-session`. An ephemeral native session has no resumable handle, so a later runtime failure fails visibly and requires a new Paseo session. Persistent recovery retains the complete launch template while replacing only the model and thinking level confirmed by OMP.

Only `full` mode is advertised. `write` and `ask` remain gated until the provider handles and advertises interactive permission events; advertising either mode before that integration would leave approval requests unanswered.

Provider options are strict. Unknown fields and malformed values fail session creation. The legacy `models`, `additionalModels`, and `disallowedTools` fields fail even when present as empty arrays.

## Paseo 0.8 public API blockers

Full legacy profile parity requires these narrow additions to the public plugin-provider API:

1. Carry normalized provider options, or an equivalent provider configuration identity, into both catalog discovery and `getCatalogCacheKey`. Catalog requests currently contain only scope, working directory, and force. A session therefore validates its selected model against the catalog returned by its own configured OMP runtime and fails before selection when they disagree.
2. Let provider registrations declare a strict `providerOptions` schema. Paseo 0.8 validates only an arbitrary JSON record, so this plugin must defer strict validation until `session.open`.
3. Apply configured `models` and `additionalModels` to plugin-provider catalogs, and permit an explicit configured profile to derive from a plugin provider without conflicting with its registered ID. Paseo 0.8 does neither.
4. Add generic tool deny-list semantics to the provider contract. The existing public `toolPolicy` supports exact MCP preapproval only and cannot represent legacy `disallowedTools`.
5. Expose a server-side read and change-subscription API for definitions registered through `registerSettings`. Registration currently creates host storage and RPC handlers, but provider registration and catalog discovery cannot consume those values.

Until these APIs exist, unsupported fields fail visibly. The plugin does not read Paseo internal files or import private server modules.
