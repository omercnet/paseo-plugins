# Changelog

## [4.0.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v3.0.0...shared-browser-v4.0.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* **paseo-shared-browser:** the plugin now requires Paseo 0.13 (requirements.paseo is ^0.13.0); it no longer loads on Paseo 0.12.

### Features

* **paseo-shared-browser:** require Paseo 0.13 and persist panel state ([#384](https://github.com/omercnet/paseo-plugins/issues/384)) ([9195eec](https://github.com/omercnet/paseo-plugins/commit/9195eecbd4ae8b932aaa6e245519663b4115336d))


### Bug Fixes

* **paseo-shared-browser:** bound video smoke polling by time, not RPC count ([#389](https://github.com/omercnet/paseo-plugins/issues/389)) ([1e54070](https://github.com/omercnet/paseo-plugins/commit/1e5407079e2bb993b0f2661b8b1263995ed505aa))
* **paseo-shared-browser:** keep video smoke consumer visible so frames present ([#387](https://github.com/omercnet/paseo-plugins/issues/387)) ([0e88f0e](https://github.com/omercnet/paseo-plugins/commit/0e88f0e4860e573e584e0a2d923ad1730e7bd8a0))

## [3.0.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v2.0.1...shared-browser-v3.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* **paseo-shared-browser:** requires Paseo ^0.12.0. The includeBackground option throws on older hosts.

### Bug Fixes

* **deps:** update dependency agent-browser to v0.39.1 ([#328](https://github.com/omercnet/paseo-plugins/issues/328)) ([ff5a9d9](https://github.com/omercnet/paseo-plugins/commit/ff5a9d977e40abfbf4762f791f8ede37d1cb5d9f))
* **paseo-shared-browser:** show the composer pill in background workspaces ([#352](https://github.com/omercnet/paseo-plugins/issues/352)) ([dc1cfda](https://github.com/omercnet/paseo-plugins/commit/dc1cfdaa7af6ffc0a8a5e22c53e869df7f5a37d6))

## [2.0.1](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v2.0.0...shared-browser-v2.0.1) (2026-10-13)


### Bug Fixes

* **paseo-shared-browser:** bump runtime protocol so stale supervisors are not reused ([#323](https://github.com/omercnet/paseo-plugins/issues/323)) ([581b135](https://github.com/omercnet/paseo-plugins/commit/581b135f13d4c58a30bb25136115a57d1b3415c6))

## [2.0.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.2.2...shared-browser-v2.0.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* the affected plugins no longer load on Paseo 0.9 or 0.10. Screen and sidebar IDs, params and settings are unchanged.

### Features

* **paseo-shared-browser:** add tab-scoped input and opt-in video ([#274](https://github.com/omercnet/paseo-plugins/issues/274)) (@RyanEwen) ([ba97d79](https://github.com/omercnet/paseo-plugins/commit/ba97d794d4c82f3ccd38c102e05d797874c75ddd))
* require Paseo 0.11 and drop legacy surface navigation ([#286](https://github.com/omercnet/paseo-plugins/issues/286)) ([a46fe9e](https://github.com/omercnet/paseo-plugins/commit/a46fe9ee910c2cc485043d53c67dacf49bab402b))


### Bug Fixes

* **paseo-shared-browser:** preserve tab order and confirm closes ([#280](https://github.com/omercnet/paseo-plugins/issues/280)) (@RyanEwen) ([ac7ca1c](https://github.com/omercnet/paseo-plugins/commit/ac7ca1c918785f00ded17af43cb09657b232ff56))
* **paseo-shared-browser:** preserve video input freshness and decoding ([#275](https://github.com/omercnet/paseo-plugins/issues/275)) (@RyanEwen) ([4a5c74e](https://github.com/omercnet/paseo-plugins/commit/4a5c74e943d485a3872fcf8466ef86f79daea1f4))
* **paseo-shared-browser:** regenerate npm-shrinkwrap for agent-browser 0.38.2 ([#314](https://github.com/omercnet/paseo-plugins/issues/314)) ([54f64d8](https://github.com/omercnet/paseo-plugins/commit/54f64d8941147ab35f5587192dd72ab5e3be5cb0))

## [1.2.2](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.2.1...shared-browser-v1.2.2) (2026-10-09)


### Bug Fixes

* **packaging:** lock npm runtime dependencies with npm-shrinkwrap.json ([#300](https://github.com/omercnet/paseo-plugins/issues/300)) ([1b0755c](https://github.com/omercnet/paseo-plugins/commit/1b0755c9097681cdc167fb26bd2d1c3cc5e72830))

## [1.2.1](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.2.0...shared-browser-v1.2.1) (2026-10-08)


### Bug Fixes

* **plugins:** ship OVERVIEW.md in published packages ([640f9a4](https://github.com/omercnet/paseo-plugins/commit/640f9a4d7bd6dbad226c4ee1ebaa199abfc62776))

## [1.2.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.1.0...shared-browser-v1.2.0) (2026-10-03)


### Features

* **paseo-shared-browser:** inject MCP into OMP on Paseo 0.11 and add sidebar footer row ([#258](https://github.com/omercnet/paseo-plugins/issues/258)) ([09593b9](https://github.com/omercnet/paseo-plugins/commit/09593b9afb30627b9714ced00deb0168e2781f58))
* **plugins:** declare Paseo 0.11 compatibility ([#248](https://github.com/omercnet/paseo-plugins/issues/248)) ([f983a8b](https://github.com/omercnet/paseo-plugins/commit/f983a8bf2025f009c178c15183d6cfac0b2024dd))


### Bug Fixes

* **paseo-shared-browser:** ignore pre-settlement frames after input ([#264](https://github.com/omercnet/paseo-plugins/issues/264)) ([2ca1674](https://github.com/omercnet/paseo-plugins/commit/2ca16748862fbe220a1caf62a165240632e42f89))
* **paseo-shared-browser:** map pointer input to actual frame dimensions ([#263](https://github.com/omercnet/paseo-plugins/issues/263)) ([7e5aa5b](https://github.com/omercnet/paseo-plugins/commit/7e5aa5b764edd019e055b41d7bd7eedfe5c7f65e))
* **paseo-shared-browser:** resync viewport when fallback frame size disagrees ([#266](https://github.com/omercnet/paseo-plugins/issues/266)) ([842155f](https://github.com/omercnet/paseo-plugins/commit/842155ff7a3d80d61525a0f0f8afb979a65b79fa))

## [1.1.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.0.2...shared-browser-v1.1.0) (2026-10-01)


### Features

* **plugins:** support Paseo 0.10.1 ([#221](https://github.com/omercnet/paseo-plugins/issues/221)) ([9d71ea0](https://github.com/omercnet/paseo-plugins/commit/9d71ea09eaa9ed67429813ed3e2de2567c14c825))

## [1.0.2](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.0.1...shared-browser-v1.0.2) (2026-09-28)


### Bug Fixes

* address Astra review findings ([#207](https://github.com/omercnet/paseo-plugins/issues/207)) ([04a2ac5](https://github.com/omercnet/paseo-plugins/commit/04a2ac5eeef51c0be3f6308fe39c155e237ceda9))
* resolve shared browser and OMP regressions ([#200](https://github.com/omercnet/paseo-plugins/issues/200)) ([fbf59bb](https://github.com/omercnet/paseo-plugins/commit/fbf59bb98d0740ba27c4eba7856d3d9079bf4bc4))

## [1.0.1](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v1.0.0...shared-browser-v1.0.1) (2026-09-28)


### Bug Fixes

* **plugins:** prepare for Paseo 0.10 beta ([#186](https://github.com/omercnet/paseo-plugins/issues/186)) ([0294fd0](https://github.com/omercnet/paseo-plugins/commit/0294fd0fd7ad5101e724d4196a49ac27783b5483))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.4.2...shared-browser-v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170))

### Features

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170)) ([04acfca](https://github.com/omercnet/paseo-plugins/commit/04acfcabcf8140edbd3a98681a72cabef7bb74ba))


### Bug Fixes

* **shared-browser:** follow owned agent directory ([#164](https://github.com/omercnet/paseo-plugins/issues/164)) ([9892e6e](https://github.com/omercnet/paseo-plugins/commit/9892e6e28b71cf0b1db6d0f6048bba122eb0587d))

## [0.4.2](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.4.1...shared-browser-v0.4.2) (2026-09-19)


### Bug Fixes

* **paseo-shared-browser:** keep Electron running as Node for the MCP launcher ([#130](https://github.com/omercnet/paseo-plugins/issues/130)) ([d4b06e0](https://github.com/omercnet/paseo-plugins/commit/d4b06e0e78630a3786fb6f071138d0b773fad915))

## [0.4.1](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.4.0...shared-browser-v0.4.1) (2026-09-19)


### Bug Fixes

* **paseo-shared-browser:** support macOS and Windows runtimes ([#121](https://github.com/omercnet/paseo-plugins/issues/121)) ([ef26e5c](https://github.com/omercnet/paseo-plugins/commit/ef26e5c6c7021bace43f19f5304df342ec8867e1))

## [0.4.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.3.1...shared-browser-v0.4.0) (2026-09-18)


### Features

* **release:** publish plugins to npm ([#80](https://github.com/omercnet/paseo-plugins/issues/80)) ([3c93048](https://github.com/omercnet/paseo-plugins/commit/3c93048cfefda97d8c2bc1631e3428fb64bdad09))


### Bug Fixes

* **shared-browser:** support Paseo 0.9 beta ([#86](https://github.com/omercnet/paseo-plugins/issues/86)) ([3af209f](https://github.com/omercnet/paseo-plugins/commit/3af209f3a8fa347ba7dc05c300061a682d809f88))

## [0.3.1](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.3.0...shared-browser-v0.3.1) (2026-09-15)


### Bug Fixes

* **shared-browser:** support system Chromium on Linux ARM64 ([#58](https://github.com/omercnet/paseo-plugins/issues/58)) ([f9c3dcb](https://github.com/omercnet/paseo-plugins/commit/f9c3dcb1031840c7cd0aed4a70f984d9d9bd24c1))

## [0.3.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.2.2...shared-browser-v0.3.0) (2026-09-12)


### Features

* **shared-browser:** adopt agent-browser runtime ([#18](https://github.com/omercnet/paseo-plugins/issues/18)) ([09623f3](https://github.com/omercnet/paseo-plugins/commit/09623f34f2b93943c19f809a865813fa37f467bd))


### Bug Fixes

* **shared-browser:** skip MCP injection for OMP ([#21](https://github.com/omercnet/paseo-plugins/issues/21)) ([ee2db08](https://github.com/omercnet/paseo-plugins/commit/ee2db08243640600c5592debe72f680446fa26d0))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.2.2...shared-browser-v1.0.0) (2026-09-12)

### ⚠ BREAKING CHANGES

* replace the browser runtime in place with plugin-owned `agent-browser` 0.37.1 and a detached daemon-host supervisor; deployments must provide the packaged runtime and a compatible Chromium executable, with Linux ARM64 deployments supplying native Chromium through `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE`

### Bug Fixes

* leave OMP agent creation unchanged because the provider rejects external MCP servers

### Features

* preserve workspace browser processes across client disconnects and plugin reloads during a 120-second orphan grace, while retaining per-workspace profiles and tearing down active runtimes when workspace archive events are received
* add daemon-local runtime overrides through `PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY` and `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE`

## [0.2.2](https://github.com/omercnet/paseo-plugins/compare/shared-browser-v0.2.1...shared-browser-v0.2.2) (2026-09-10)


### Bug Fixes

* upgrade plugins to Paseo 0.8.0 ([c6b4e40](https://github.com/omercnet/paseo-plugins/commit/c6b4e4081fc9527de0ca6183a3903ff5ec4f93c4))
* upgrade plugins to Paseo 0.8.0 ([d7ad454](https://github.com/omercnet/paseo-plugins/commit/d7ad4540d2e1875bdf4a4d21f76ded25cac2f3dc))

## [0.2.1](https://github.com/omercnet/paseo-shared-browser/compare/v0.2.0...v0.2.1) (2026-09-08)


### Bug Fixes

* address Paseo 0.8 migration review feedback ([#10](https://github.com/omercnet/paseo-shared-browser/issues/10)) ([15d2515](https://github.com/omercnet/paseo-shared-browser/commit/15d25157503b7fb70d02c5e420522764250cab62))

## [0.2.0](https://github.com/omercnet/paseo-shared-browser/compare/v0.1.1...v0.2.0) (2026-09-08)

### Features

* migrate shared browser to Paseo 0.8 ([#8](https://github.com/omercnet/paseo-shared-browser/issues/8)) ([36f27ab](https://github.com/omercnet/paseo-shared-browser/commit/36f27abc5dab4a16c9770d6296916631965af333))
## [0.1.1](https://github.com/omercnet/paseo-shared-browser/compare/v0.1.0...v0.1.1) (2026-09-07)

### Bug Fixes

* include README screenshots in release archives ([#6](https://github.com/omercnet/paseo-shared-browser/issues/6)) ([a231db4](https://github.com/omercnet/paseo-shared-browser/commit/a231db4b20e9c52ebe8624ad69e34e907037ac0a))

## 0.1.0 (2026-09-07)

### Features

* share one live Chromium session per Paseo workspace ([b1e9fac](https://github.com/omercnet/paseo-shared-browser/commit/b1e9fac5021746cf2dc09f7bfb9ccf0cb3b82e5d))

### Bug Fixes

* keep format check off the generated changelog ([#4](https://github.com/omercnet/paseo-shared-browser/issues/4)) ([2219adf](https://github.com/omercnet/paseo-shared-browser/commit/2219adf3c11591a88dc54b899dece76003f313c4))
