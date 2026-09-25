# Changelog

## [1.0.1](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v1.0.0...paseo-omp-v1.0.1) (2026-09-25)


### Bug Fixes

* **paseo-omp:** require Paseo 0.9.2 provider fixes ([#177](https://github.com/omercnet/paseo-plugins/issues/177)) ([ddf9098](https://github.com/omercnet/paseo-plugins/commit/ddf9098f38397dec2105a666c295b0d919fe4092))

## [1.0.0](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.4.0...paseo-omp-v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170))

### Features

* **paseo-omp:** add host inherited environment settings ([#159](https://github.com/omercnet/paseo-plugins/issues/159)) ([b3c80d9](https://github.com/omercnet/paseo-plugins/commit/b3c80d991d1b72de872afdd32e2a531e01569b13))
* require Paseo ^0.9.0 for all plugins ([#170](https://github.com/omercnet/paseo-plugins/issues/170)) ([04acfca](https://github.com/omercnet/paseo-plugins/commit/04acfcabcf8140edbd3a98681a72cabef7bb74ba))


### Bug Fixes

* **paseo-omp:** harden OMP session recovery ([#132](https://github.com/omercnet/paseo-plugins/issues/132)) ([d89a9fe](https://github.com/omercnet/paseo-plugins/commit/d89a9feab367deea2b4629593fac9c6b867884a4))
* **paseo-omp:** observe owned agent directory ([#163](https://github.com/omercnet/paseo-plugins/issues/163)) ([e475dc7](https://github.com/omercnet/paseo-plugins/commit/e475dc7a4355d56b842eb751fc9e008725b4402f))
* **paseo-omp:** preserve prompt and tool stream ordering ([#148](https://github.com/omercnet/paseo-plugins/issues/148)) ([b667e86](https://github.com/omercnet/paseo-plugins/commit/b667e86af45768ab7459aec4beb8e0b4ea52e312))
* **paseo-omp:** preserve Windows process tree during cleanup ([#152](https://github.com/omercnet/paseo-plugins/issues/152)) ([e0a5483](https://github.com/omercnet/paseo-plugins/commit/e0a548323ab7e900eefddb4b33e7c3b3d6f1d582))

## [0.4.0](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.3.0...paseo-omp-v0.4.0) (2026-09-19)


### Features

* **paseo-omp:** add guided model role picker ([#108](https://github.com/omercnet/paseo-plugins/issues/108)) ([23be6ff](https://github.com/omercnet/paseo-plugins/commit/23be6ff4f8dd7aad8c331b08e50ce28820be4c56))
* **paseo-omp:** add support diagnostics help report ([#120](https://github.com/omercnet/paseo-plugins/issues/120)) ([b567c87](https://github.com/omercnet/paseo-plugins/commit/b567c87a7a0a0e7cdb6da111e667ba1a15a4f651))


### Bug Fixes

* **paseo-omp:** accept bounded tool metadata ([#110](https://github.com/omercnet/paseo-plugins/issues/110)) ([102c6bf](https://github.com/omercnet/paseo-plugins/commit/102c6bfde945100784a7b5e69a5648520dbc5816))
* **paseo-omp:** align environment preflight limits ([#113](https://github.com/omercnet/paseo-plugins/issues/113)) ([e93d12e](https://github.com/omercnet/paseo-plugins/commit/e93d12e84c250f87e93e96f980122361c51f1e4d))
* **paseo-omp:** avoid Windows cleanup race ([#123](https://github.com/omercnet/paseo-plugins/issues/123)) ([15b3818](https://github.com/omercnet/paseo-plugins/commit/15b3818044433b0a701068b76ff5187a41b4cf02))
* **paseo-omp:** branch directly from rewind tokens ([#114](https://github.com/omercnet/paseo-plugins/issues/114)) ([2ff4e6b](https://github.com/omercnet/paseo-plugins/commit/2ff4e6b6b48aff3ac13f0be82ebed8c513597a4b))
* **paseo-omp:** degrade oversized host tool results ([#111](https://github.com/omercnet/paseo-plugins/issues/111)) ([3e9b35f](https://github.com/omercnet/paseo-plugins/commit/3e9b35fc1e2685c1597f5b8e616c1d7455911908))
* **paseo-omp:** isolate subagent replay failures ([#118](https://github.com/omercnet/paseo-plugins/issues/118)) ([1161560](https://github.com/omercnet/paseo-plugins/commit/1161560ecfad830d1141a3956e0ae0a183b6b5d6))
* **paseo-omp:** preserve large replay output ([#117](https://github.com/omercnet/paseo-plugins/issues/117)) ([6bdd879](https://github.com/omercnet/paseo-plugins/commit/6bdd879bafa99bccacc6476f030b6d10c669d1c5))
* **paseo-omp:** preserve nested subagent links ([#105](https://github.com/omercnet/paseo-plugins/issues/105)) ([41b3b87](https://github.com/omercnet/paseo-plugins/commit/41b3b8760cb88be2381f723e400f71469cb1685c))
* **paseo-omp:** preserve transcript when image replay fails ([#112](https://github.com/omercnet/paseo-plugins/issues/112)) ([b982226](https://github.com/omercnet/paseo-plugins/commit/b9822269faadf36918781b243959b76fbcfea4f9))
* **paseo-omp:** report protocol violations safely ([#119](https://github.com/omercnet/paseo-plugins/issues/119)) ([c63c244](https://github.com/omercnet/paseo-plugins/commit/c63c24423b8ef5e999688c9a8c931a6bf5a0d514))
* **paseo-omp:** tolerate optional catalog metadata ([#115](https://github.com/omercnet/paseo-plugins/issues/115)) ([2dbd8f6](https://github.com/omercnet/paseo-plugins/commit/2dbd8f6934757c8ee5b04ec1cc0f2b1f256d2051))

## [0.3.0](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.2.1...paseo-omp-v0.3.0) (2026-09-18)


### Features

* **paseo-omp:** add first-class MCP management ([#64](https://github.com/omercnet/paseo-plugins/issues/64)) ([5a8fefa](https://github.com/omercnet/paseo-plugins/commit/5a8fefa9148e8d01f0461aa4a90619ec6ae2c2fa))
* **paseo-omp:** add workspace-scoped OMP management ([#59](https://github.com/omercnet/paseo-plugins/issues/59)) ([2807aec](https://github.com/omercnet/paseo-plugins/commit/2807aec6217ed2d52f8b4666f0a41a688109f8f5))
* **paseo-omp:** make composer pills configurable ([#76](https://github.com/omercnet/paseo-plugins/issues/76)) ([28e7501](https://github.com/omercnet/paseo-plugins/commit/28e75011a06a11cdc963187aa4106dfc21d561e6))
* **release:** publish plugins to npm ([#80](https://github.com/omercnet/paseo-plugins/issues/80)) ([3c93048](https://github.com/omercnet/paseo-plugins/commit/3c93048cfefda97d8c2bc1631e3428fb64bdad09))


### Bug Fixes

* **paseo-omp:** advertise nested subsession capability ([#62](https://github.com/omercnet/paseo-plugins/issues/62)) ([fcb4e82](https://github.com/omercnet/paseo-plugins/commit/fcb4e8243e9559d70f26ac6945e2f3c0bf05d575))
* **paseo-omp:** bound model catalogs and retain safe failure diagnostics ([#73](https://github.com/omercnet/paseo-plugins/issues/73)) ([e70afb7](https://github.com/omercnet/paseo-plugins/commit/e70afb72be782446e7ff585bad40940c7231bdc5))
* **paseo-omp:** correlate terminal events by request ([#81](https://github.com/omercnet/paseo-plugins/issues/81)) ([41f756e](https://github.com/omercnet/paseo-plugins/commit/41f756e9bebf5cbc275e5cbd3657c37d45a18997))
* **paseo-omp:** fail closed on unowned later-turn terminal events ([#69](https://github.com/omercnet/paseo-plugins/issues/69)) ([072cd09](https://github.com/omercnet/paseo-plugins/commit/072cd09e38e450376bcd3f4c7b5eae9a670b56b5))
* **paseo-omp:** preserve prompt scheduling error fidelity ([#67](https://github.com/omercnet/paseo-plugins/issues/67)) ([1c6d549](https://github.com/omercnet/paseo-plugins/commit/1c6d549fddca48be8fd86b4dd2c5faea526c8ac0))
* **paseo-omp:** reconcile incomplete terminal outcomes ([#68](https://github.com/omercnet/paseo-plugins/issues/68)) ([854f4e6](https://github.com/omercnet/paseo-plugins/commit/854f4e6daddf905c671bb39a94d06a2de0c6d51d))
* **paseo-omp:** replay failed turns from native transcript ([#79](https://github.com/omercnet/paseo-plugins/issues/79)) ([4a13b77](https://github.com/omercnet/paseo-plugins/commit/4a13b778a9ba413b61fe0cc85878d3c333c161d2))
* **paseo-omp:** scope providers and auxiliary state to named profiles ([#74](https://github.com/omercnet/paseo-plugins/issues/74)) ([b265ad3](https://github.com/omercnet/paseo-plugins/commit/b265ad317a47230ec76dba799197443664492729))
* **paseo-omp:** settle concurrent startup races ([#70](https://github.com/omercnet/paseo-plugins/issues/70)) ([9d4e6ef](https://github.com/omercnet/paseo-plugins/commit/9d4e6efb26041f9c88ab4ed6c02a9526520b83e9))
* **paseo-omp:** show immutable approval mode ([#66](https://github.com/omercnet/paseo-plugins/issues/66)) ([4c586dc](https://github.com/omercnet/paseo-plugins/commit/4c586dc7d012127ee7570077a0d12cc0d6415bd4))
* **paseo-omp:** support Paseo 0.9 beta ([#103](https://github.com/omercnet/paseo-plugins/issues/103)) ([0444d52](https://github.com/omercnet/paseo-plugins/commit/0444d52078a52befa62bb52f44545f22ab10e8c7))
* **paseo-omp:** support unkeyed terminal events ([#89](https://github.com/omercnet/paseo-plugins/issues/89)) ([a00a831](https://github.com/omercnet/paseo-plugins/commit/a00a83158993fdf648fc10e06f1d8f8ebc62fa6a))

## [0.2.1](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.2.0...paseo-omp-v0.2.1) (2026-09-15)


### Bug Fixes

* **paseo-omp:** handle oversized pasted images ([#55](https://github.com/omercnet/paseo-plugins/issues/55)) ([4b6ed7d](https://github.com/omercnet/paseo-plugins/commit/4b6ed7d3015f1f85dcc13a9dd29061efef5f22c7))
* **paseo-omp:** preserve buffered terminal ownership evidence ([#54](https://github.com/omercnet/paseo-plugins/issues/54)) ([b49400e](https://github.com/omercnet/paseo-plugins/commit/b49400e09d73cd67a23986f52c17bfc1f23cd297))
* **paseo-omp:** steer auto messages during active turns ([#61](https://github.com/omercnet/paseo-plugins/issues/61)) ([b36002b](https://github.com/omercnet/paseo-plugins/commit/b36002bbc5b108cd525dd9c356fbdb89d6a9f3e6))

## [0.2.0](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.2...paseo-omp-v0.2.0) (2026-09-14)


### Features

* **paseo-omp:** add config workspace shell ([#48](https://github.com/omercnet/paseo-plugins/issues/48)) ([1c0126b](https://github.com/omercnet/paseo-plugins/commit/1c0126b51bd3c8ceccacf7758fc14270cd67440e))
* **paseo-omp:** add opt-in output redaction ([#44](https://github.com/omercnet/paseo-plugins/issues/44)) ([0b0cea1](https://github.com/omercnet/paseo-plugins/commit/0b0cea1501230437fe4d6390b67ca25ee2079c93))
* **paseo-omp:** browse complete runtime settings catalog ([#49](https://github.com/omercnet/paseo-plugins/issues/49)) ([ef68cd7](https://github.com/omercnet/paseo-plugins/commit/ef68cd754fa3aad4a15bcdc8649f8c7dcdcde79e))
* **paseo-omp:** edit scalar settings in sidebar ([#50](https://github.com/omercnet/paseo-plugins/issues/50)) ([78da43f](https://github.com/omercnet/paseo-plugins/commit/78da43fd155ed06e29faef507156399b55cf3439))
* **paseo-omp:** support explicit env passthrough ([#39](https://github.com/omercnet/paseo-plugins/issues/39)) ([e22b3b4](https://github.com/omercnet/paseo-plugins/commit/e22b3b448f218bdecfcb3a168c14fa32051a6392))


### Bug Fixes

* **omp:** preserve safe published URLs ([#42](https://github.com/omercnet/paseo-plugins/issues/42)) ([4530430](https://github.com/omercnet/paseo-plugins/commit/4530430a02bee076f8940c376401d3266ce17499))
* **paseo-omp:** align prompt attachment rendering ([#41](https://github.com/omercnet/paseo-plugins/issues/41)) ([4b708c8](https://github.com/omercnet/paseo-plugins/commit/4b708c897b4af4cd6673e7581f736e95843b545b))
* **paseo-omp:** expose native Paseo tools ([#52](https://github.com/omercnet/paseo-plugins/issues/52)) ([3b52adf](https://github.com/omercnet/paseo-plugins/commit/3b52adff1de6329fa9f0bc4a1dcea339166e3974))
* **paseo-omp:** label direct MCP tool calls ([#53](https://github.com/omercnet/paseo-plugins/issues/53)) ([e09b1fd](https://github.com/omercnet/paseo-plugins/commit/e09b1fd2c05cb45422e7d0633e8b638d0841b931))
* **paseo-omp:** preserve structured tool results ([#46](https://github.com/omercnet/paseo-plugins/issues/46)) ([9e5fe98](https://github.com/omercnet/paseo-plugins/commit/9e5fe989e57e100f67285257cada3242218eee58))
* **paseo-omp:** render WebP images across clients ([#51](https://github.com/omercnet/paseo-plugins/issues/51)) ([397cb2d](https://github.com/omercnet/paseo-plugins/commit/397cb2d1e660e43e22312ecf9f054d77afcddc6e))
* **paseo-omp:** stop speculative stream redaction ([#40](https://github.com/omercnet/paseo-plugins/issues/40)) ([539cb61](https://github.com/omercnet/paseo-plugins/commit/539cb61db0b904b8130319c7887852f991c50aba))

## [0.1.2](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.1...paseo-omp-v0.1.2) (2026-09-13)


### Bug Fixes

* **paseo-omp:** serialize persistent session registration ([#35](https://github.com/omercnet/paseo-plugins/issues/35)) ([03d38bc](https://github.com/omercnet/paseo-plugins/commit/03d38bc7e4a3d00ec54190e2b234a459bbdc55ae))
* **paseo-omp:** settle late child dispatches ([#34](https://github.com/omercnet/paseo-plugins/issues/34)) ([0746f11](https://github.com/omercnet/paseo-plugins/commit/0746f11fd94f15028fd624ac7a99ac8ebd88b63d))

## [0.1.1](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.0...paseo-omp-v0.1.1) (2026-09-13)


### Bug Fixes

* **paseo-omp:** preserve Plexus plugin credentials ([#27](https://github.com/omercnet/paseo-plugins/issues/27)) ([0674ef1](https://github.com/omercnet/paseo-plugins/commit/0674ef1d3d66efa37ec9d2da9a19dd57472c2cdd))
* **paseo-omp:** wait for session registration ([#30](https://github.com/omercnet/paseo-plugins/issues/30)) ([82e901e](https://github.com/omercnet/paseo-plugins/commit/82e901e4bb0e66cafeb572c4bd92e0461b57a647))

## 0.1.0 (2026-09-13)


### Features

* **paseo-omp:** add first OMP provider plugin ([#19](https://github.com/omercnet/paseo-plugins/issues/19)) ([f6f3e5e](https://github.com/omercnet/paseo-plugins/commit/f6f3e5e224bf8537f85305d79ea5d1bcf5849549))

## Changelog

## Unreleased

### Features

* Add the permanent `omp-plugin` direct provider, OMP workspace tools, diagnostics, versioned persistence, and nested-subagent support.
* Add Release Please packaging, Git installation, compatibility policy, and release rollback guidance.
* Add a digest-pinned official Paseo Docker canary with deterministic mock, configured MCP, and optional local Ollama inference.
* Document the deduplicated Paseo core OMP issue audit, verified plugin fixes, host-owned concerns, and remaining alpha gaps.
* Add the OMP sidebar configuration editor with revision-checked scalar writes, structured collection display, and documentation of provider-profile options including names-only inherited environment settings.
* Add official OMP documentation links and an OMP-native plugin manager with status, user-scoped lifecycle actions, upgrades, write-only non-secret scalar configuration, and presence-only secret handling.

### Bug Fixes

* Cancel pending generic permissions before interrupting OMP so the host receives a terminal cancellation.
* Rebuild the native branch watermark during replay so a post-rewind prompt retains terminal ownership.
* Label `xd://` and MCP timeline calls with their registered human-readable title instead of the generic `write` transport or technical route name.
* Support host-wide session discovery when Paseo opens the unscoped import sheet, preventing its provider failure path from crashing affected 0.8 daemons.
* Recover degraded or compacted `agent_end` outcomes from complete streamed assistant evidence while continuing to fail closed on partial evidence.
* Preserve `PLEXUS_API_KEY` when launching OMP so Plexus extension providers can attach their configured bearer header.
* Serialize concurrent persistent-session registration so startup restoration waits instead of returning transient provider failures.
* Expose caller-scoped Paseo orchestration tools under their native names so OMP skills can invoke `list_profiles`, `create_agent`, and related tools without CLI fallback.
* Render validated WebP timeline images on capable clients, show a local fallback when decoding fails, hide machine-facing coordinate annotations, and request PNG/JPEG output from OMP for cross-client compatibility.

### Security

* Split release metadata from least-privilege artifact publishing, gate publication on exact-commit CI, and attest release artifacts.
* Make release archives self-contained, restrict source inputs to tracked allowlisted files, and verify offline installation plus contained extraction.
* Disable dependency lifecycle scripts during Git installation and verify both plugin entries from a fresh checkout.
* Document native-output fidelity, optional best-effort configured-value replacement, its limits, and the host-owned redaction boundary.
