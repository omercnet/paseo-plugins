# Support

## Ownership

`@omercnet` maintains the `paseo-omp` package, its release artifacts, and the translation between Paseo's provider protocol and OMP's `rpc-ui` protocol. Support is best effort; no response-time or compatibility SLA is promised.

Report plugin packaging, provider behavior, migration, and cutover failures in the [paseo-plugins issue tracker](https://github.com/omercnet/paseo-plugins/issues). Use the [OMP RPC compatibility template](https://github.com/omercnet/paseo-plugins/issues/new?template=omp-rpc-compatibility.yml) for native protocol changes.

After the failure is isolated:

- report an OMP CLI or `rpc-ui` implementation defect to [Oh My Pi](https://github.com/can1357/oh-my-pi/issues);
- report a Paseo plugin SDK, loader, or provider-protocol defect to [Paseo](https://github.com/getpaseo/paseo/issues);
- keep adaptation, packaging, and cross-project compatibility work in this repository.

Do not put credentials, private repository paths, session transcripts, or unredacted RPC payloads in an issue. Report vulnerabilities through this repository's GitHub Security Advisory flow instead of a public issue.

## Supported versions

- Paseo: `^0.8.1` on both the daemon and every app loading the client entry.
- OMP: `18.1.15` is the oldest release in the required real-binary regression job. The hard runtime contract is `rpc-ui` protocol v2, not the version string alone.
- Typed approvals: optional. When both peers negotiate `typedToolApprovals: 1`, the plugin uses typed tool permissions. Otherwise it retains the bounded generic extension-question flow.

See [TESTING.md](TESTING.md#omp-rpc-compatibility-intake) for the schema-drift intake and regression process.
