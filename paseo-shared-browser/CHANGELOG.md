# Changelog

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
