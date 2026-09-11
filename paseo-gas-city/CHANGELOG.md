# Changelog

## [0.1.0](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v0.0.1...paseo-gas-city-v0.1.0) (2026-09-11)


### Features

* **gas-city:** add operator control-plane plugin ([#15](https://github.com/omercnet/paseo-plugins/issues/15)) ([42b17ce](https://github.com/omercnet/paseo-plugins/commit/42b17ce9e894f8c39c02be2cdc288cac78fb0124))

## 0.0.1 (2026-09-11)

### Features

- add global supervisor and workspace Factory views for cities, rigs, sessions, convoys, events, and operator attention
- map Paseo workspaces to Gas City rigs through explicit overrides or longest ancestor paths
- add safe, bounded RPC adapters for discovery, observation, dispatch, and session actions
- keep remote endpoints and mutations opt-in, with explicit confirmation required for every mutation
- add Command Center entries and a workspace `/sling` command
- adopt Gas City's Reading Room visual language and publish sidebar-free desktop and compact screenshots

### Compatibility

- target the Gas City v1.4.1 HTTP control plane
- defer a native Paseo session bridge until Gas City exposes correlated prompt and reply identifiers
