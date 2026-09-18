# Support

## Ownership

`@omercnet` maintains the `paseo-omp` package, its release artifacts, and the translation between Paseo's provider protocol and OMP's `rpc-ui` protocol. Support is best effort; no response-time or compatibility SLA is promised.

Report plugin packaging, installation, provider behavior, and compatibility failures in the [paseo-plugins issue tracker](https://github.com/omercnet/paseo-plugins/issues). Use the [OMP RPC compatibility template](https://github.com/omercnet/paseo-plugins/issues/new?template=omp-rpc-compatibility.yml) for native protocol changes.

After the failure is isolated:

- report an OMP CLI or `rpc-ui` implementation defect to [Oh My Pi](https://github.com/can1357/oh-my-pi/issues);
- report a Paseo plugin SDK, loader, or provider-protocol defect to [Paseo](https://github.com/getpaseo/paseo/issues);
- keep adaptation, packaging, and cross-project compatibility work in this repository.

Do not put credentials, private repository paths, session transcripts, or unredacted RPC payloads in an issue. Report vulnerabilities through the [private GitHub Security Advisory form](https://github.com/omercnet/paseo-plugins/security/advisories/new), not a public issue.

## Supported versions

- Paseo: `>=0.8.0 <0.10.0` on both the daemon and every app loading the client entry. The pinned SDK and controlled canary use `0.9.0-beta.1`, the first release that preserves nested provider-subagent ancestry and spawning-tool links. Paseo 0.8.x remains supported for other provider operations.
- OMP: `18.1.15` is the oldest supported release. The required full Docker canary passes with 18.1.15 and 18.2.0; the hard runtime contract remains `rpc-ui` protocol v2, not the version string alone.
- Plugin release channel: alpha. Backward compatibility is best effort until stable `0.1.0`; every known migration requirement must be stated in the release notes.
- Typed approvals: optional. When both peers negotiate `typedToolApprovals: 1`, the plugin uses typed tool permissions. Otherwise it retains the bounded generic extension-question flow.

## Known limitations

- `omp` and `omp-plugin` are independent provider identities. Agents, provider settings, and persisted handles do not migrate automatically between them.
- Do not open the same underlying OMP session concurrently through both providers. Reservation tracking is provider-local and cannot coordinate ownership with Paseo's bundled adapter.
- OMP 18.1.15 does not advertise typed tool approvals. The plugin uses its bounded generic permission fallback until both peers negotiate `typedToolApprovals: 1`.
- OMP releases through 18.2.x may omit the originating prompt `requestId` from `agent_end`. A matching ID is authoritative when present, and a mismatch is discarded before changing turn state. For an unkeyed later-turn terminal, the plugin uses a bounded ordered fallback: the accepted prompt must not be known local-only, a fresh native user entry must correlate to it, current-turn assistant activity must follow that entry, OMP must report idle and non-compacting, and no permission, tool, steer, or child-session work may remain. Ambiguous candidates are ignored while OMP is active; once OMP is confirmed idle, unresolved ambiguity fails only the Paseo turn and keeps the OMP process available. This deliberately accepts a residual same-agent risk: a sufficiently delayed unkeyed event with indistinguishable ordered evidence can still be misattributed. It is safer than accepting any idle `agent_end`, while remaining usable with released OMP builds that cannot provide request identity.
- Timeline correlation rebuilds an invalid watermark from a complete pre-prompt `get_branch_messages` snapshot, not replayed model context or an evicting identity cache. Snapshots are limited to 1,024 entries and 4 MiB; duplicate IDs, surplus exact-text matches, unavailable history, and exceeded bounds leave users uncorrelated rather than claiming an old entry. Repeated accepted prompts within a turn consume matching branch occurrences in order.
- Configured MCP servers are supported and bridged into OMP. Paseo's own orchestration tools appear under their native names when the daemon's **Enable Paseo tools** / `daemon.mcp.injectIntoAgents` setting is enabled; other MCP servers remain namespaced. Exact Paseo `toolPolicy` preapproval cannot be represented by OMP `set_host_tools` and therefore fails session startup closed. `disallowedTools` applies only to recognized native OMP built-ins; unknown names are rejected and MCP tools are not silently filtered through it.
- `qwen2.5:0.5b` is provided only for free exploratory inference. It may ignore exact-output instructions and is not a deterministic protocol or tool-use oracle; use `canary-mock/Deterministic Canary` for assertions.
- The deterministic mock does not implement OMP's compaction-summary contract, so `/compact` reports `OMP compaction failed` in the canary; compaction remains covered by protocol fixtures.
- `/handoff` reports `OMP command failed` in the controlled canary even with deterministic role models configured; treat handoff as unavailable there until its native prerequisite is isolated.
- On official Paseo 0.8.0, requesting a live approval-mode change that the plugin rejects can trigger the daemon's unhandled-rejection restart path. Create a new `full`, `write`, or `ask` session instead of changing mode in place.
- Paseo 0.8 clients do not expose the platform-owned plugin URL opener and transform timeline items after Overview grouping. Use a 0.9.0-beta.1 app for external documentation/device-authorization actions and for reliable image-card transformation of every source tool call.
- Native Fast mode and a first-class plan mode are not exposed. `/handoff` is implemented but is not reproducible in the controlled canary without its native OMP workflow prerequisites.
- Terminal-started OMP sessions are discoverable and importable but are not registered automatically through a terminal hook.
- Paseo clients do not own OMP sessions. Mobile or desktop disconnects remain subject to Paseo's reconnect grace while the daemon-owned provider and OMP child continue independently; reconnecting can reveal an existing turn but does not transfer or sever runtime ownership.
- OMP tool output reaching RPC stdout is strictly parsed and bounded, but channel purity ultimately depends on OMP keeping non-protocol output off stdout.

The deduplicated comparison with every known OMP report in `getpaseo/paseo` is maintained in [docs/core-provider-issue-audit.md](docs/core-provider-issue-audit.md).

See [TESTING.md](TESTING.md#omp-rpc-compatibility-intake) for the schema-drift intake and regression process.
