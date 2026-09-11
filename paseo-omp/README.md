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

`full`, `write`, and `ask` modes are advertised only when Paseo negotiates provider permission support. OMP approvals and extension questions are bridged as generic question permissions; approval mode changes still require a new session.

For text-only models, image inputs are materialized into a private, size-bounded temporary directory and removed when the turn, session, or provider connection ends. This relies on the direct provider process and its OMP child sharing the daemon host filesystem; remote execution belongs behind a transport that owns file transfer.

Provider options are strict. Unknown fields and malformed values fail session creation. The legacy `models`, `additionalModels`, and `disallowedTools` fields fail even when present as empty arrays.

## Paseo 0.8 public API blockers

Full legacy profile parity requires these narrow additions to the public plugin-provider API:

1. Carry normalized provider options, or an equivalent provider configuration identity, into both catalog discovery and `getCatalogCacheKey`. Catalog requests currently contain only scope, working directory, and force. A session therefore validates its selected model against the catalog returned by its own configured OMP runtime and fails before selection when they disagree (`omp-provider.20.2`).
2. Let provider registrations declare a strict `providerOptions` schema. Paseo 0.8 validates only an arbitrary JSON record, so this plugin must defer strict validation until `session.open` (`omp-provider.20.2`).
3. Apply configured `models` and `additionalModels` to plugin-provider catalogs, and permit an explicit configured profile to derive from a plugin provider without conflicting with its registered ID. Paseo 0.8 does neither (`omp-provider.20.2`).
4. Add generic tool deny-list semantics to the provider contract. The existing public `toolPolicy` supports exact MCP preapproval only and cannot represent legacy `disallowedTools` (`omp-provider.20.3`).
5. Expose a server-side read and change-subscription API for definitions registered through `registerSettings`. Registration currently creates host storage and RPC handlers, but provider registration and catalog discovery cannot consume those values (`omp-provider.20.2`).
6. Add provider availability and diagnostic hooks so a plugin provider can report a missing, unrunnable, or incompatible native binary in the normal provider status (`omp-provider.20.1`).
7. Preserve separate first- and last-prompt previews in public provider session listings (`omp-provider.20.4`).
8. Add authenticated native tool-approval frames or verified provenance before promoting OMP approval prompts to typed tool permissions (`omp-provider.20.5`). Free-text `Allow tool:` titles are intentionally treated as untrusted generic questions.

Until these APIs exist, unsupported fields fail visibly. The plugin does not read Paseo internal files or import private server modules.
# Paseo OMP

Paseo plugin for OMP workspace tools and the direct `rpc-ui` provider preview.

## Compatibility

This release requires Paseo `^0.8.1`. Provider-owned OMP child sessions rely on direct nested-subagent ancestry support introduced after Paseo 0.8.0.

The direct provider requires an OMP build that negotiates `rpc-ui` protocol v2. Metadata-free legacy ready frames and v1-only runtimes are rejected before a provider session opens because they cannot support the advertised persistence and conversation-rewind capabilities.
