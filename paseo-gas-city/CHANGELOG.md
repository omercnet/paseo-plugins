# Changelog

## [0.2.0](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v0.1.0...paseo-gas-city-v0.2.0) (2026-09-18)


### Features

* **release:** publish plugins to npm ([#80](https://github.com/omercnet/paseo-plugins/issues/80)) ([3c93048](https://github.com/omercnet/paseo-plugins/commit/3c93048cfefda97d8c2bc1631e3428fb64bdad09))


### Bug Fixes

* **gas-city:** support Paseo 0.9 beta settings ([#102](https://github.com/omercnet/paseo-plugins/issues/102)) ([dd4ccda](https://github.com/omercnet/paseo-plugins/commit/dd4ccda0d85e4160c9ad39d5a9045fb690ed5510))
* **gas-city:** support Paseo 0.9 beta settings ([#91](https://github.com/omercnet/paseo-plugins/issues/91)) ([15c9a97](https://github.com/omercnet/paseo-plugins/commit/15c9a970ce5fccd7a09ed4284b8aa2d37c43b464))

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
