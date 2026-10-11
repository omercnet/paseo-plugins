# Changelog

## [1.2.1](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v1.2.0...paseo-gas-city-v1.2.1) (2026-10-08)


### Bug Fixes

* **plugins:** ship OVERVIEW.md in published packages ([640f9a4](https://github.com/omercnet/paseo-plugins/commit/640f9a4d7bd6dbad226c4ee1ebaa199abfc62776))

## [1.2.0](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v1.1.0...paseo-gas-city-v1.2.0) (2026-10-03)


### Features

* **gas-city:** sidebar health row, city popover and per-city screens on Paseo 0.11 ([#252](https://github.com/omercnet/paseo-plugins/issues/252)) ([f87fc12](https://github.com/omercnet/paseo-plugins/commit/f87fc12ffbb39e41c2ea4185cf706f3be99f1092))
* **plugins:** declare Paseo 0.11 compatibility ([#248](https://github.com/omercnet/paseo-plugins/issues/248)) ([f983a8b](https://github.com/omercnet/paseo-plugins/commit/f983a8bf2025f009c178c15183d6cfac0b2024dd))

## [1.1.0](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v1.0.1...paseo-gas-city-v1.1.0) (2026-10-01)


### Features

* **plugins:** support Paseo 0.10.1 ([#221](https://github.com/omercnet/paseo-plugins/issues/221)) ([9d71ea0](https://github.com/omercnet/paseo-plugins/commit/9d71ea09eaa9ed67429813ed3e2de2567c14c825))

## [1.0.1](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v1.0.0...paseo-gas-city-v1.0.1) (2026-09-28)


### Bug Fixes

* **plugins:** prepare for Paseo 0.10 beta ([#186](https://github.com/omercnet/paseo-plugins/issues/186)) ([0294fd0](https://github.com/omercnet/paseo-plugins/commit/0294fd0fd7ad5101e724d4196a49ac27783b5483))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/paseo-gas-city-v0.2.0...paseo-gas-city-v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170))

### Features

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170)) ([04acfca](https://github.com/omercnet/paseo-plugins/commit/04acfcabcf8140edbd3a98681a72cabef7bb74ba))

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
