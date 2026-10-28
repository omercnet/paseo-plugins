# Changelog

## Unreleased

### Migration

- migrate the plugin to the Paseo 0.8 runtime-entry layout
- move client modules under `client/` and shared code under `shared/`
- switch to first-class `parentAgentId` handling with bounded cycles
- add an explicit pending-permission modal with Allow and Deny actions
- pin Paseo plugin packages to `0.8.0-beta.1`

## [4.1.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v4.0.1...agent-crew-v4.1.0) (2026-10-28)


### Features

* add listing icon to plugin manifests ([#418](https://github.com/omercnet/paseo-plugins/issues/418)) ([2e7aadd](https://github.com/omercnet/paseo-plugins/commit/2e7aaddac381bb2a5c596f95b1f9b7b8aee89cb2))

## [4.0.1](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v4.0.0...agent-crew-v4.0.1) (2026-10-27)


### Bug Fixes

* **agent-crew:** allow nudging idle-released closed agents ([#413](https://github.com/omercnet/paseo-plugins/issues/413)) ([c81ee3b](https://github.com/omercnet/paseo-plugins/commit/c81ee3b362155e5cb9416b351ecb27a7c1ab7bfb))
* **deps:** support Paseo 0.14.0-beta.1 ([0f019e0](https://github.com/omercnet/paseo-plugins/commit/0f019e054992660f589c14894c4382d51325dc31))

## [4.0.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v3.0.0...agent-crew-v4.0.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* **agent-crew:** agent-crew now requires Paseo 0.13. The manifest range is ^0.13.0 because useTabState and the unified client UI entry do not exist on 0.12.

### Features

* **agent-crew:** require Paseo 0.13 and persist panel state ([#382](https://github.com/omercnet/paseo-plugins/issues/382)) ([04c91a9](https://github.com/omercnet/paseo-plugins/commit/04c91a942f447b2469b759f28720761a64502214))

## [3.0.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v2.0.0...agent-crew-v3.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* **agent-crew:** requires Paseo ^0.12.0. The includeBackground option throws on older hosts.

### Bug Fixes

* **agent-crew:** include background workspaces ([#348](https://github.com/omercnet/paseo-plugins/issues/348)) ([3e590c1](https://github.com/omercnet/paseo-plugins/commit/3e590c13567604981d231658951d45cd09d35bf4))

## [2.0.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v1.2.1...agent-crew-v2.0.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* the affected plugins no longer load on Paseo 0.9 or 0.10. Screen and sidebar IDs, params and settings are unchanged.

### Features

* require Paseo 0.11 and drop legacy surface navigation ([#286](https://github.com/omercnet/paseo-plugins/issues/286)) ([a46fe9e](https://github.com/omercnet/paseo-plugins/commit/a46fe9ee910c2cc485043d53c67dacf49bab402b))

## [1.2.1](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v1.2.0...agent-crew-v1.2.1) (2026-10-08)


### Bug Fixes

* **plugins:** ship OVERVIEW.md in published packages ([640f9a4](https://github.com/omercnet/paseo-plugins/commit/640f9a4d7bd6dbad226c4ee1ebaa199abfc62776))

## [1.2.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v1.1.0...agent-crew-v1.2.0) (2026-10-03)


### Features

* **agent-crew:** add steer choice and active crews sidebar row ([#261](https://github.com/omercnet/paseo-plugins/issues/261)) ([8a0856f](https://github.com/omercnet/paseo-plugins/commit/8a0856f9c18f85b4d29145450d8b634541af78b5))
* **plugins:** declare Paseo 0.11 compatibility ([#248](https://github.com/omercnet/paseo-plugins/issues/248)) ([f983a8b](https://github.com/omercnet/paseo-plugins/commit/f983a8bf2025f009c178c15183d6cfac0b2024dd))

## [1.1.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v1.0.1...agent-crew-v1.1.0) (2026-10-01)


### Features

* **plugins:** support Paseo 0.10.1 ([#221](https://github.com/omercnet/paseo-plugins/issues/221)) ([9d71ea0](https://github.com/omercnet/paseo-plugins/commit/9d71ea09eaa9ed67429813ed3e2de2567c14c825))

## [1.0.1](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v1.0.0...agent-crew-v1.0.1) (2026-09-28)


### Bug Fixes

* **plugins:** prepare for Paseo 0.10 beta ([#186](https://github.com/omercnet/paseo-plugins/issues/186)) ([0294fd0](https://github.com/omercnet/paseo-plugins/commit/0294fd0fd7ad5101e724d4196a49ac27783b5483))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v0.3.0...agent-crew-v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170))

### Features

* **agent-crew:** add opt-in Explorer auto-open ([#146](https://github.com/omercnet/paseo-plugins/issues/146)) ([@tensorcopy](https://github.com/tensorcopy)) ([b4e43a0](https://github.com/omercnet/paseo-plugins/commit/b4e43a00b86a29533d73b18f9bb100bcc46584b9))
* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170)) ([04acfca](https://github.com/omercnet/paseo-plugins/commit/04acfcabcf8140edbd3a98681a72cabef7bb74ba))


### Bug Fixes

* **agent-crew:** observe owned directories ([#160](https://github.com/omercnet/paseo-plugins/issues/160)) ([a89e2e2](https://github.com/omercnet/paseo-plugins/commit/a89e2e2a0082dcd42d3d44585089206047c98918))

## [0.3.0](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v0.2.3...agent-crew-v0.3.0) (2026-09-18)


### Features

* **release:** publish plugins to npm ([#80](https://github.com/omercnet/paseo-plugins/issues/80)) ([3c93048](https://github.com/omercnet/paseo-plugins/commit/3c93048cfefda97d8c2bc1631e3428fb64bdad09))


### Bug Fixes

* **agent-crew:** support Paseo 0.9 beta ([#90](https://github.com/omercnet/paseo-plugins/issues/90)) ([d2d3114](https://github.com/omercnet/paseo-plugins/commit/d2d3114bfcca63e0c184e9be4843a941a1fb56b6))

## [0.2.3](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v0.2.2...agent-crew-v0.2.3) (2026-09-10)


### Bug Fixes

* upgrade plugins to Paseo 0.8.0 ([c6b4e40](https://github.com/omercnet/paseo-plugins/commit/c6b4e4081fc9527de0ca6183a3903ff5ec4f93c4))
* upgrade plugins to Paseo 0.8.0 ([d7ad454](https://github.com/omercnet/paseo-plugins/commit/d7ad4540d2e1875bdf4a4d21f76ded25cac2f3dc))

## [0.2.2](https://github.com/omercnet/paseo-agent-crew/compare/v0.2.1...v0.2.2) (2026-09-08)


### Bug Fixes

* derive client API types from host SDK ([#7](https://github.com/omercnet/paseo-agent-crew/issues/7)) ([ffdfacf](https://github.com/omercnet/paseo-agent-crew/commit/ffdfacf9e4f0bd43f84e973176b2b2ffd7fe6350))

## [0.2.1](https://github.com/omercnet/paseo-agent-crew/compare/v0.2.0...v0.2.1) (2026-09-08)


### Bug Fixes

* clean up Paseo 0.8 migration ([#5](https://github.com/omercnet/paseo-agent-crew/issues/5)) ([02912fb](https://github.com/omercnet/paseo-agent-crew/commit/02912fbb73956420ae8315bceea7025e71dd7a71))

## [0.2.0](https://github.com/omercnet/paseo-agent-crew/compare/v0.1.0...v0.2.0) (2026-09-08)


### Features

* migrate agent crew to paseo 0.8 ([#3](https://github.com/omercnet/paseo-agent-crew/issues/3)) ([3014f1c](https://github.com/omercnet/paseo-agent-crew/commit/3014f1c2f1afb8187cb2ac0e86f2b442bb805911))

## 0.1.0 (2026-09-02)

### Features

- add the workspace-wide Agent Crew Explorer panel
- organize managed agents into collapsible cross-workspace delegation trees
- add status filters, search, navigation, and guarded agent controls
