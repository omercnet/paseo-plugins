# Changelog

## [3.1.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v3.0.2...paseo-context-mode-v3.1.0) (2026-10-28)


### Features

* add listing icon to plugin manifests ([#418](https://github.com/omercnet/paseo-plugins/issues/418)) ([2e7aadd](https://github.com/omercnet/paseo-plugins/commit/2e7aaddac381bb2a5c596f95b1f9b7b8aee89cb2))

## [3.0.2](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v3.0.1...paseo-context-mode-v3.0.2) (2026-10-27)


### Bug Fixes

* **deps:** support Paseo 0.14.0-beta.1 ([0f019e0](https://github.com/omercnet/paseo-plugins/commit/0f019e054992660f589c14894c4382d51325dc31))

## [3.0.1](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v3.0.0...paseo-context-mode-v3.0.1) (2026-10-24)


### Bug Fixes

* **plugins:** accept Paseo 0.13 in the plugin manifest range ([bdb9435](https://github.com/omercnet/paseo-plugins/commit/bdb943595515ab7f21a93c66cffeb6844bacdcdb))

## [3.0.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v2.0.2...paseo-context-mode-v3.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* **context-mode:** requires Paseo ^0.12.0. The includeBackground option throws on older hosts.

### Bug Fixes

* **context-mode:** show the composer pill in background workspaces ([#349](https://github.com/omercnet/paseo-plugins/issues/349)) ([605b573](https://github.com/omercnet/paseo-plugins/commit/605b573fff8d6b15a6033bcfd4e464dcdb7b8a97))

## [2.0.2](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v2.0.1...paseo-context-mode-v2.0.2) (2026-10-15)


### Bug Fixes

* **context-mode:** run panel probes against a plugin-owned storage root ([#334](https://github.com/omercnet/paseo-plugins/issues/334)) ([344001e](https://github.com/omercnet/paseo-plugins/commit/344001e424d58aac79e2fa7f869ef465ca8070be))

## [2.0.1](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v2.0.0...paseo-context-mode-v2.0.1) (2026-10-12)


### Bug Fixes

* **context-mode:** treat agent or workspace from another host as unscoped ([#318](https://github.com/omercnet/paseo-plugins/issues/318)) ([0b17694](https://github.com/omercnet/paseo-plugins/commit/0b17694a87cc2eb5ad631d65e2e8f05561d90503))

## [2.0.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.2.4...paseo-context-mode-v2.0.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* the affected plugins no longer load on Paseo 0.9 or 0.10. Screen and sidebar IDs, params and settings are unchanged.

### Features

* require Paseo 0.11 and drop legacy surface navigation ([#286](https://github.com/omercnet/paseo-plugins/issues/286)) ([a46fe9e](https://github.com/omercnet/paseo-plugins/commit/a46fe9ee910c2cc485043d53c67dacf49bab402b))

## [1.2.4](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.2.3...paseo-context-mode-v1.2.4) (2026-10-11)


### Bug Fixes

* **context-mode:** cover configured providers in Savings and Knowledge ([#311](https://github.com/omercnet/paseo-plugins/issues/311)) ([bcb9ded](https://github.com/omercnet/paseo-plugins/commit/bcb9dedf31ecf74acb1cb6d1f0f9e1dca48a23ef))
* **context-mode:** inject into providers derived via extends ([#306](https://github.com/omercnet/paseo-plugins/issues/306)) ([459f12a](https://github.com/omercnet/paseo-plugins/commit/459f12a6ff181e67dfd178b2d1e27cad05c4413e))

## [1.2.3](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.2.2...paseo-context-mode-v1.2.3) (2026-10-09)


### Bug Fixes

* **packaging:** lock npm runtime dependencies with npm-shrinkwrap.json ([#300](https://github.com/omercnet/paseo-plugins/issues/300)) ([1b0755c](https://github.com/omercnet/paseo-plugins/commit/1b0755c9097681cdc167fb26bd2d1c3cc5e72830))

## [1.2.2](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.2.1...paseo-context-mode-v1.2.2) (2026-10-08)


### Bug Fixes

* **plugins:** ship OVERVIEW.md in published packages ([640f9a4](https://github.com/omercnet/paseo-plugins/commit/640f9a4d7bd6dbad226c4ee1ebaa199abfc62776))

## [1.2.1](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.2.0...paseo-context-mode-v1.2.1) (2026-10-07)


### Bug Fixes

* **context-mode:** derive PaseoApi type from host plugin client ([#288](https://github.com/omercnet/paseo-plugins/issues/288)) ([5cb9797](https://github.com/omercnet/paseo-plugins/commit/5cb9797df720f341deb8a0a8542ef617f89dc102))
* **ui:** raise context-mode eyebrow contrast and fix radar empty-queue copy ([#290](https://github.com/omercnet/paseo-plugins/issues/290)) ([ed16e30](https://github.com/omercnet/paseo-plugins/commit/ed16e30efe09aef0c4ebdee9b6d69d25e0e3cb2e))

## [1.2.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.1.0...paseo-context-mode-v1.2.0) (2026-10-03)


### Features

* **context-mode:** Paseo 0.11 screen, scoped Knowledge pill and sidebar health row ([#255](https://github.com/omercnet/paseo-plugins/issues/255)) ([3607735](https://github.com/omercnet/paseo-plugins/commit/36077351f942405451995d31e7b853c5100b59f7))
* **plugins:** declare Paseo 0.11 compatibility ([#248](https://github.com/omercnet/paseo-plugins/issues/248)) ([f983a8b](https://github.com/omercnet/paseo-plugins/commit/f983a8bf2025f009c178c15183d6cfac0b2024dd))

## [1.1.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.0.1...paseo-context-mode-v1.1.0) (2026-10-01)


### Features

* **plugins:** support Paseo 0.10.1 ([#221](https://github.com/omercnet/paseo-plugins/issues/221)) ([9d71ea0](https://github.com/omercnet/paseo-plugins/commit/9d71ea09eaa9ed67429813ed3e2de2567c14c825))

## [1.0.1](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v1.0.0...paseo-context-mode-v1.0.1) (2026-09-28)


### Bug Fixes

* **plugins:** prepare for Paseo 0.10 beta ([#186](https://github.com/omercnet/paseo-plugins/issues/186)) ([0294fd0](https://github.com/omercnet/paseo-plugins/commit/0294fd0fd7ad5101e724d4196a49ac27783b5483))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/paseo-context-mode-v0.1.0...paseo-context-mode-v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170))

### Features

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170)) ([04acfca](https://github.com/omercnet/paseo-plugins/commit/04acfcabcf8140edbd3a98681a72cabef7bb74ba))

## 0.1.0 (2026-09-22)


### Features

* **context-mode:** add provider-aware integration ([#136](https://github.com/omercnet/paseo-plugins/issues/136)) ([304db0a](https://github.com/omercnet/paseo-plugins/commit/304db0a36627d62224cd16f1003e838f82427a2e))
