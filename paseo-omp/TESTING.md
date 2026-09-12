# OMP provider parity audit

Validated against Paseo 0.8.1 release-candidate cutover commit `761b0b4729bc748a122f784602c15bd81293100b`, rollback baseline `f4b209be4d81d25a6143d12d374d797d485e8faa`, and OMP native contract commit `11694d5d3b`.

Classifications:

- **Equivalent**: same consumer-observable behavior is implemented by the production `omp` plugin provider.
- **Unsupported**: OMP has no meaningful native operation for this behavior.
- **Protocol**: Paseo core owns the behavior for every public provider.
- **Blocked**: parity needs the linked narrow public API or core change; the plugin fails visibly or provides the documented partial behavior.

## Evidence matrix

| Inventory behavior | Classification | Evidence |
| --- | --- | --- |
| Binary availability and version diagnostics | **Equivalent** | Provider refresh calls the bounded `checkAvailability` hook with normalized profile options and the host deadline. `server/provider-diagnostics.ts` distinguishes missing, unrunnable, incompatible, and available runtimes without exposing probe output. |
| Catalog discovery | **Equivalent** | `server/provider/catalog.ts::discoverOmpCatalog` launches with the normalized profile command, environment, parameters, workspace, and timeout settings. |
| Catalog cache identity | **Equivalent** | `getCatalogCacheKey` hashes normalized `providerOptions`, profile `settings`, scope, working directory, and the effective default command. Core applies configured `models` and `additionalModels` per profile. |
| Default mode | **Equivalent** | Catalog reports `defaultMode: full`; `full` is always available, while bundled `write`/`ask` modes are advertised only after `permission` negotiation. Covered by `tests/provider.test.ts` and `tests/provider-options.test.ts`. |
| Create session | **Equivalent** | `OmpProviderSession.open`; ordered `session.opened`, committed `session.config`, and `session.ready` regression. |
| Resume session | **Equivalent** | Versioned plugin persistence plus Paseo 0.8.1's bounded core migration envelope preserve existing `provider: "omp"` agents and their legacy `nativeHandle`; the plugin validates the native ID, authorizes cwd against the configured `providerOptions.params.sessionDir`, resumes exactly, and replays before ready. Covered by `tests/persistence-cutover.test.ts`, `tests/provider.test.ts`, and the local-core case in `tests/provider-conformance.test.ts`. |
| List sessions | **Equivalent** | `session.list` consumes profile-scoped `providerOptions` and `settings`, scans the configured session root, and returns separate bounded first- and last-user-prompt previews. |
| Import session | **Protocol** and **Equivalent** | `session.list` plus persistence replay feeds the generic plugin-provider import path. Paseo 0.8.1 wraps a pre-cutover native file handle in the core migration envelope; the plugin extracts only its native ID and reauthorizes that ID and cwd under the configured session root before launch. |
| Archive/unarchive | **Unsupported** | OMP has no native archive operation. Neither adapter mutates OMP transcripts; Paseo still archives its own agent record. |
| Working directory | **Equivalent** | Absolute cwd validation, launch forwarding, resume ownership checks, session-list scoping, and host-tool cwd tests. |
| Environment propagation | **Equivalent** | `config-normalization.ts` overlays session env on profile env; `omp-rpc.ts::buildOmpEnvironment` allowlists inherited runtime/provider variables and rejects loader/path injection. |
| System prompts | **Protocol** and **Equivalent** | Core combines agent and daemon prompts before `session.open`; plugin forwards one bounded `--append-system-prompt`. Profile/recovery tests preserve it. |
| Persisted sessions | **Equivalent** | Versioned opaque persistence, legacy native-handle migration, transcript reservation, replay, process recovery, and cleanup quarantine regressions are covered in `tests/persistence-cutover.test.ts`, `tests/provider.test.ts`, and the package/core integration run. |
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
| Typed tool permission presentation | **Equivalent** | OMP `typedToolApprovals: 1` is negotiated reciprocally; strict native request/cancel/response frames are correlated exactly once and mapped from trusted shell/edit/write identity to bounded, redacted `kind: "tool"` permissions. Older OMP builds retain generic extension questions. |
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
| Configured model replacement/additions | **Protocol** and **Equivalent** | Paseo applies profile `models` replacement and `additionalModels` overlays to the profile-specific plugin catalog. |
| Generic denied tools | **Equivalent** | Core forwards a bounded, deduplicated `deniedTools` list; the plugin turns recognized OMP built-ins into an explicit launch allow-list before the process starts and rejects unknown names rather than silently under-enforcing. |
| Strict provider option validation before launch | **Equivalent** | The provider registers `OmpProviderOptionsSchema`; core normalizes once and forwards the same value through availability, cache identity, discovery, listing, and launch. |
| Profile settings in provider discovery | **Equivalent** | Core forwards profile settings to catalog, cache-key, and session-list operations; the provider includes them in cache identity without claiming unsupported live OMP settings. |
| Terminal-started OMP session hooks | **Unsupported** | The bundled terminal hook registry contains Claude, Codex, and OpenCode only; OMP exposes no registered terminal activity hook to preserve. |
| Metadata-generation flows | **Protocol** and **Equivalent** | Generic structured generation selects plugin models from catalog metadata and creates non-persisted sessions; provider responses use the existing parse/validation retry loop. |

## Integration boundary tests

The coordinated package/core cutover test requires distinct checkouts of the pinned pre-cutover and cutover Paseo revisions:

```sh
PASEO_LEGACY_CORE_ROOT=/path/to/paseo-legacy \
PASEO_CUTOVER_CORE_ROOT=/path/to/paseo-cutover \
  bun run test:integration:core
```

The runner builds both checkouts, packages and extracts this plugin, and loads each checkout's own `PluginService` and provider registry. It proves the legacy core still owns bundled `omp` and rejects the package, the cutover core no longer owns `omp` and accepts the plugin registration, and disabling the plugin before rollback leaves the legacy core able to restore bundled `omp`. The provider conformance suite runs against the cutover checkout's compiled adapter, including legacy native-handle resume, import to a canonical native session ID, close, and subsequent resume while preserving the original JSONL handle for rollback.

Run this test before release and rollback. Linux CI checks out `f4b209be4d81d25a6143d12d374d797d485e8faa` and `761b0b4729bc748a122f784602c15bd81293100b` directly; mutable branches and tags are not accepted. The integration reads each checkout's package version and passes that exact value to its plugin service and session host.

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

The Linux `paseo-omp real OMP 18.1.15` CI job downloads the pinned `omp-linux-x64` release asset, verifies SHA-256 `747518a41fbb32ac47491b4677a7a921d0d9e5977ae006c358d6836813149adc`, and runs `PASEO_OMP_REAL_E2E=1 bun test tests/provider.real.e2e.test.ts`. The test uses the real OMP binary and a local deterministic OpenAI-compatible model endpoint, so catalog and text-plus-Bash execution are mandatory without repository secrets.

## OMP RPC compatibility intake

Treat every upstream `rpc-ui` change as explicit compatibility work. Do not widen a Zod schema with `passthrough`, `unknown`, or an optional field merely to accept a new frame.

1. Open an issue with the [OMP RPC compatibility template](https://github.com/omercnet/paseo-plugins/issues/new?template=omp-rpc-compatibility.yml). Record exact OMP, plugin, Paseo daemon, and Paseo app versions; the negotiated protocol and capabilities; the smallest reproduction; and sanitized frame shapes. Never attach credentials, private paths, prompts, or transcripts.
2. Reproduce against both the reported OMP revision and the pinned minimum-tested `omp/18.1.15` binary. Classify the change as additive optional, additive required, removed or renamed, type or semantic change, or negotiation change.
3. Compare the affected ready, request, response, or event shape with the strict schemas in `server/provider/omp-rpc.ts`. Decide whether the plugin can support both contracts without ambiguity. A breaking contract requires an explicit compatibility decision and changelog entry, not silent coercion.

Required drift is release-blocking. If OMP adds a mandatory frame, removes or renames a required method or field, or changes an existing field's meaning, keep the strict parser and make session startup or the active request fail visibly. Do not silently discard the frame, make the requirement optional, or route around negotiation. Resume release work only after both sides have an explicit compatible contract, fixtures, focused regressions, and a real-binary result.
4. Add the changed frame to `tests/fixtures/fake-omp.ts`, then add a focused regression for acceptance, rejection, negotiation, cancellation, and bounds as applicable. Capability changes must cover both reciprocal negotiation and the absent-capability fallback. Typed approval drift must retain the generic extension-question path when `typedToolApprovals: 1` is not negotiated.
5. Run `bun test tests/omp-rpc.test.ts tests/provider.test.ts`, `bun run test:coverage`, and `PASEO_OMP_REAL_E2E=1 bun test tests/provider.real.e2e.test.ts` with the candidate OMP binary. If host protocol behavior changes, also run the pinned core cutover integration.
6. Update the minimum-tested version only after the real-binary job is pinned to that release and its SHA-256, the compatibility issue links the evidence, and the README, support matrix, CI job name, fixture version, and changelog agree.

The plugin maintainer owns triage and adaptation. Escalate an isolated OMP implementation defect upstream and an isolated Paseo SDK or provider-protocol defect to Paseo, while keeping the cross-project regression in this repository.

## Release publication

`release-please.yml` only creates release metadata and forwards the created `paseo-omp` tag and commit SHA to `publish-paseo-omp.yml`. The metadata job never checks out or executes repository code. The publisher has no pull-request permission, resolves the tag independently, and waits for a successful `CI` push run whose `head_sha` is exactly the tagged commit before checkout or execution.

The publisher builds the self-contained ZIP, writes its corruption-detection checksum, creates a signed GitHub build-provenance attestation for both files, rechecks that the tag still resolves to the gated SHA, and uploads with `--clobber`. To recover an interrupted upload, dispatch **Publish Paseo OMP** with the existing `paseo-omp-v<version>` tag; the same identity and CI gates apply, so reruns are idempotent.

The SHA-256 file is not a signature. Consumers authenticate the archive with `gh attestation verify` and may use the checksum only to detect accidental transfer or storage corruption.

## Audit verification

- `bun run check`: clean across 80 files.
- `bun run typecheck`: clean.
- `bun test`: 443 passed, 4 env-gated scenarios skipped, with 2,153 assertions.
- `bun test tests/provider-conformance.test.ts`: 16 host-boundary conformance tests passed, 1 local-core cutover case skipped without `PASEO_CUTOVER_CORE_ROOT`, with 399 assertions. Coverage includes `prompt.command`, `session.configure`, typed and fallback permission allow/deny/cancel paths, registry-driven reload/removal, verified stubborn-descendant cleanup, and 64 sequential turns plus 10 interrupt races with post-turn barriers.
- `PASEO_OMP_REAL_E2E=1 bun test tests/provider.real.e2e.test.ts`: both installed `omp/18.1.15` catalog and hermetic real-binary text/Bash scenarios passed with 13 assertions.
- `bun run test:coverage`: 443 passed and 4 env-gated scenarios skipped with 2,153 assertions; aggregate source coverage is 95.80% functions and 97.88% lines. Every measured source file clears the unchanged 85% function and 90% line thresholds. Generated `dist/**` trees are excluded.
- `bun run package:release`: `dist/paseo-omp-v0.0.0.zip` built from tracked allowlisted source plus its closed production/compiler dependency set; the full suite checked archive contents, contained extraction, and both packaged entries.
- `bun run test:integration:install`: the self-contained archive imported dependencies and compiled with an empty cache and unreachable registry/proxy, while a fresh Git-style checkout ran its declared dependency build.
- `PASEO_LEGACY_CORE_ROOT=/path/to/paseo-legacy PASEO_CUTOVER_CORE_ROOT=/path/to/paseo-cutover bun run test:integration:core`: the `0.7.2` rollback core and actual `0.8.1` cutover commit `761b0b4729bc748a122f784602c15bd81293100b` built; packaged install/rollback and plugin conformance passed, 18 tests with 412 assertions.
- Matching core adapter suites (`provider.test.ts`, `plugin-provider.test.ts`, `provider-registry.test.ts`, `provider-snapshot-manager.test.ts`, and `plugins/index.posix.test.ts`): 172 passed.
- `bun run test:integration:docker`: host/container ownership boundary verified.
- `bun run test:integration:wsl`: locally skipped because `wsl.exe` is unavailable; Windows CI sets `PASEO_OMP_REQUIRE_WSL=1`, so this boundary remains required there.
- `mise x actionlint@1.7.12 -- actionlint .github/workflows/*.yml`: passed.
- `zizmor .github/workflows`: no findings (offline audit; six repository-wide suppressions remain).
- Release Please 17.1.2 `config.json` and `manifest.json` schema validation: passed for `release-please-config.json` and `.release-please-manifest.json`.
