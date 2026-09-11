# OMP provider parity audit

Audit baseline: plugin `d00d34eb7f90c6e29624d6c18bc32d19da883e07`; Paseo core `f4b209be4d81d25a6143d12d374d797d485e8faa`.

Classifications:

- **Equivalent**: same consumer-observable behavior is implemented by `omp-plugin`.
- **Unsupported**: the bundled adapter also has no meaningful native OMP operation.
- **Protocol**: Paseo core owns the behavior for every public provider.
- **Blocked**: parity needs the linked narrow public API or core change; the plugin fails visibly or provides the documented partial behavior.

## Evidence matrix

| Inventory behavior | Classification | Evidence |
| --- | --- | --- |
| Binary availability and version diagnostics | **Blocked** (`omp-provider.20.1`) | `server/provider-diagnostics.ts` safely resolves and probes `omp --version`/`--help`; `tests/provider-diagnostics.test.ts` covers missing, unrunnable, timeout, malformed, compatibility, and cleanup outcomes. The generic provider status still equates a successful plugin connection with availability. |
| Catalog discovery | **Equivalent** | `server/provider/catalog.ts::discoverOmpCatalog`; `tests/provider.test.ts` “discovers real models and all approval modes”. |
| Catalog cache identity | **Blocked** (`omp-provider.20.2`) | Public `catalog` input has only `cwd`; provider options and registered settings cannot participate in `getCatalogCacheKey`. |
| Default mode | **Equivalent** | Catalog reports `defaultMode: full`; `full` is always available, while bundled `write`/`ask` modes are advertised only after `permission` negotiation. Covered by `tests/provider.test.ts` and `tests/provider-options.test.ts`. |
| Create session | **Equivalent** | `OmpProviderSession.open`; ordered `session.opened`, committed `session.config`, and `session.ready` regression. |
| Resume session | **Equivalent** | Opaque native ID validation, cwd authorization, configured `providerOptions.params.sessionDir`, exact resume, replay-before-ready, and recovery tests in `tests/provider.test.ts`. |
| List sessions | **Equivalent** for OMP/env-configured roots; profile-scoped discovery **Blocked** (`omp-provider.20.2`); preview detail **Blocked** (`omp-provider.20.4`) | `session.list` recursively discovers bounded cwd-scoped descriptors, and `tests/session-descriptors.test.ts` covers explicit roots. Public list requests cannot carry per-profile provider options or distinct first/last prompt previews. |
| Import session | **Protocol** | `session.list` plus persistence replay feeds the generic plugin-provider import path; host `plugin-provider.ts::importSession` owns import storage and timeline adoption. |
| Archive/unarchive | **Unsupported** | OMP has no native archive operation. Neither adapter mutates OMP transcripts; Paseo still archives its own agent record. |
| Working directory | **Equivalent** | Absolute cwd validation, launch forwarding, resume ownership checks, session-list scoping, and host-tool cwd tests. |
| Environment propagation | **Equivalent** | `config-normalization.ts` overlays session env on profile env; `omp-rpc.ts::buildOmpEnvironment` allowlists inherited runtime/provider variables and rejects loader/path injection. |
| System prompts | **Protocol** and **Equivalent** | Core combines agent and daemon prompts before `session.open`; plugin forwards one bounded `--append-system-prompt`. Profile/recovery tests preserve it. |
| Persisted sessions | **Equivalent** | Versioned opaque persistence, transcript reservation, replay, process recovery, and cleanup quarantine regressions in `tests/provider.test.ts`. |
| Ephemeral sessions | **Equivalent** | `persist: false` maps to `--no-session`; runtime loss fails visibly instead of inventing a resume handle. |
| Internal sessions | **Protocol** and **Equivalent** | Metadata generation requests `persistSession: false`; the generic plugin host maps that to `config.persist: false`, then OMP receives `--no-session`. |
| Text prompts | **Equivalent** | Bounded multipart text joins and native prompt lifecycle coverage in `tests/provider.test.ts`. |
| Image prompts | **Equivalent** | Valid native image models receive image blocks; text-only models receive private content-addressed local files with an aggregate cap and turn/session/failure cleanup. The file path is valid because the direct provider and OMP child share the daemon host. |
| Structured attachments | **Equivalent** | Forge change requests/issues, legacy GitHub forms, text, reviews, and uploaded files render to bounded OMP prompt text; regression in `tests/provider.test.ts`. |
| Optimistic message correlation | **Equivalent** | Native entry lookup, repeated-text occurrence ownership, steering correlation, replay-boundary dedupe, and exactly-one `session.prompt_result` regressions. |
| Streaming assistant text | **Equivalent** | `OmpTimelineProjector` publishes stable complete snapshots with frame coalescing and bounded retained bytes. |
| Streaming reasoning | **Equivalent** | Indexed thinking blocks map to stable `reasoning` items and share stream bounds. |
| `contentIndex` ordering | **Equivalent** | Stable 0→1→0 updates, sparse-index rejection, and 64-block bounds are tested in `tests/provider.test.ts`. |
| Tool lifecycle | **Equivalent** | Running/update/terminal snapshots, mapped shell/read/edit/write/search/fetch/subagent details, ID reuse defense, and terminal cleanup are covered. |
| Todo lifecycle | **Equivalent** | Todo tool results and reminder/auto-clear events reduce to one stable `omp:todos` item; malformed inputs degrade safely. |
| Compaction events | **Equivalent** | Manual and automatic operations retain IDs, distinguish retry/skipped/canceled/failed states, flush streams, and refresh usage. |
| Custom messages | **Equivalent** | Displayable custom and bash-execution messages map to typed or fallback items; `display: false` remains hidden. |
| Advisor messages | **Equivalent** | Advisor notes preserve severity/attribution in stable tool-call blocks; `advisor_yielded` emits completion notice. |
| System notices | **Equivalent** | Native notices and safe passive UI notifications map to bounded notification items; hidden custom notices remain hidden. |
| Ask interactions | **Equivalent** | Select/confirm/input/editor questions, option descriptions, fixed-only rejection, bounded freeform input, native sentinel/follow-up submission, cancellation, timeout, and turn ownership are covered by permission regressions. |
| Typed tool permission presentation | **Blocked** (`omp-provider.20.5`) | Free-text `Allow tool:` titles remain bounded/redacted generic questions because OMP supplies no authenticated typed frame or provenance. Functional approval remains available without trusting spoofable display text. |
| Slash command catalog | **Equivalent** | Native commands and aliases refresh authoritatively; the bundled `compact`, `autocompact`, `handoff`, `steer`, and `follow-up` commands are always published. |
| Manual `/compact` | **Equivalent** | Uses native `compact`, exposes one loading/completed operation, keeps long requests alive, refreshes usage, and supports interruption. |
| `/autocompact` | **Equivalent** | `on`, `off`, and state-backed `toggle` use native `set_auto_compaction`; invalid or unavailable state fails visibly. |
| `/handoff` | **Equivalent** | Structured command calls native `handoff` with optional instructions and owns a provider turn until native assistant/tool/permission/terminal events settle. |
| `/follow-up` | **Equivalent** | Structured command sends native `follow_up` and owns a provider turn rather than publishing an immediate synthetic completion. |
| Native steering | **Equivalent** | `delivery: steer` and `/steer` use native steering, correlate one user row, preserve active-turn ownership, and reject stale/terminal targets. |
| Interrupt | **Equivalent** | Native abort, exactly-one terminal event, in-flight tool/child retirement, permission cleanup, and concurrent-close serialization are covered. |
| Model selection | **Equivalent** | Catalog-backed opaque public IDs map to native provider/model IDs; committed state is re-read after open/configure/recovery. |
| Thinking selection | **Equivalent** | Model-specific effort lists, defaults, runtime changes, invalid selections, and recovery are covered. |
| Mode selection | **Equivalent** | `full`/`write`/`ask` map to `yolo`/`write`/`always-ask`; catalogs and opens expose interactive modes only when `permission` was negotiated, and live changes retain the bundled “new session” constraint. |
| Retry fallback events | **Equivalent** | Fallback telemetry renders bounded status items and triggers committed model/thinking refresh without trusting event strings as state. |
| Context and token usage | **Equivalent** | Periodic, post-compaction, fallback, terminal, timeout, and stale-generation samples publish `session.usage`. |
| Native host tools | **Equivalent** | Paseo's caller-scoped MCP endpoint is converted to OMP host tools with workspace identity, progress, cancellation, bounded results, and ownership cleanup. |
| Configured MCP servers | **Equivalent** | stdio/http/SSE transports are opened by the plugin host process, namespaced, paginated, bounded, and passed through OMP's native host-tool API. |
| Subagents | **Equivalent** | Live lifecycle/progress/events create provider-owned child sessions; subscription failure removes the negotiated capability. |
| Nested child timelines | **Equivalent** | Child/grandchild ancestry, stable IDs, live restart, cold transcript replay, terminal states, and cumulative replay bounds are covered. |
| Conversation rewind | **Equivalent** | Only conversation scope is advertised; active-turn/stale-token rejection and branch replay are tested. |
| Native branch transition | **Equivalent** | New native IDs atomically replace persistence/reservation ownership; indeterminate post-branch failures close and quarantine the session. |
| Custom executable command | **Equivalent** | Strict `providerOptions.command` replaces the executable prefix and survives recovery. |
| Custom environment | **Equivalent** | Strict `providerOptions.env` is merged below launch env, survives recovery, and is filtered from public output. |
| Provider parameters | **Equivalent** | `sessionDir`, `rpcTimeoutMs`, and `smol`/`slow`/`plan` model roles map to native arguments and survive recovery; cold resume authorization scans the normalized configured `sessionDir`. |
| Configured model replacement/additions | **Blocked** (`omp-provider.20.2`) | Public plugin catalogs cannot receive profile options or host-applied `models`/`additionalModels`; these fields fail visibly at open. |
| Generic denied tools | **Blocked** (`omp-provider.20.3`) | Public `toolPolicy` has exact MCP preapproval only and cannot represent bundled `disallowedTools`; the field fails visibly. |
| Strict provider option validation before launch | **Blocked** (`omp-provider.20.2`) | The plugin validates strictly at `session.open`; core currently accepts an arbitrary JSON record before then. |
| Registered plugin settings in provider discovery | **Blocked** (`omp-provider.20.2`) | Public server settings have no read/change subscription available to provider registration or catalog discovery. |
| Terminal-started OMP session hooks | **Unsupported** | The bundled terminal hook registry contains Claude, Codex, and OpenCode only; OMP exposes no registered terminal activity hook to preserve. |
| Metadata-generation flows | **Protocol** and **Equivalent** | Generic structured generation selects plugin models from catalog metadata and creates non-persisted sessions; provider responses use the existing parse/validation retry loop. |

## Integration boundary tests

Run the real Docker host/container ownership boundary test with:

```sh
bun run test:integration:docker
```

The script starts the MCP server as a host process, calls it from a Bun container, executes a host tool, and verifies the returned host PID, host working directory, caller agent ID, and workspace ID. Set `PASEO_OMP_DOCKER_IMAGE` to override the default `oven/bun:1.4.0` image.

Run the equivalent Windows-host/WSL boundary with:

```sh
bun run test:integration:wsl
```

The WSL script skips when `wsl.exe` or WSL Bun is unavailable. Set `PASEO_OMP_REQUIRE_WSL=1` to make either condition fatal, as CI does. `PASEO_OMP_WSL_BUN` may override the default `$HOME/.bun/bin/bun` path inside WSL.

## Audit verification

- `bun run check`: clean across 72 files.
- `bun run typecheck`: clean.
- `bun test`: 393 tests passed with 1,658 assertions.
- `bun run package:release /tmp/paseo-omp-audit.zip`: release archive built successfully.
- Real `omp/18.1.15` smoke: protocol v2 catalog returned 11 models; an ephemeral `ask` session opened and closed; a connection without `permission` exposed only `full`, while a permission-capable connection exposed `full`, `write`, and `ask`; all five bundled out-of-band commands were published.
