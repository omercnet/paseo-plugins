# Changelog

## Unreleased

### Changed

* Fast-forward the clean, checked-out local base branch before creating a branch-off worktree.
* Warn and skip the local branch update when the source checkout is dirty instead of blocking workspace creation.
* Show a workspace-header indicator when a worktree is behind the source branch's remote-tracking ref.

## [1.2.0](https://github.com/omercnet/paseo-plugins/compare/fresh-worktrees-v1.1.1...fresh-worktrees-v1.2.0) (2026-09-18)


### Features

* **release:** publish plugins to npm ([#80](https://github.com/omercnet/paseo-plugins/issues/80)) ([3c93048](https://github.com/omercnet/paseo-plugins/commit/3c93048cfefda97d8c2bc1631e3428fb64bdad09))


### Bug Fixes

* **fresh-worktrees:** prepare for Paseo 0.9 ([#84](https://github.com/omercnet/paseo-plugins/issues/84)) ([17e45c2](https://github.com/omercnet/paseo-plugins/commit/17e45c2b3687949340339bcc0146563be6e9c631))

## [1.1.1](https://github.com/omercnet/paseo-plugins/compare/fresh-worktrees-v1.1.0...fresh-worktrees-v1.1.1) (2026-09-13)


### Bug Fixes

* **fresh-worktrees:** prevent freshness RPC storms ([#28](https://github.com/omercnet/paseo-plugins/issues/28)) ([6244ebe](https://github.com/omercnet/paseo-plugins/commit/6244ebec4dee63694fa16a376877453510d9364f))

## [1.1.0](https://github.com/omercnet/paseo-plugins/compare/fresh-worktrees-v1.0.0...fresh-worktrees-v1.1.0) (2026-09-10)


### Features

* **fresh-worktrees:** keep local base branch current ([#9](https://github.com/omercnet/paseo-plugins/issues/9)) ([2ebd062](https://github.com/omercnet/paseo-plugins/commit/2ebd0620d4356103c2a162b503103090b7289add))

## 1.0.0 (2026-09-10)


### Bug Fixes

* upgrade plugins to Paseo 0.8.0 ([c6b4e40](https://github.com/omercnet/paseo-plugins/commit/c6b4e4081fc9527de0ca6183a3903ff5ec4f93c4))
* upgrade plugins to Paseo 0.8.0 ([d7ad454](https://github.com/omercnet/paseo-plugins/commit/d7ad4540d2e1875bdf4a4d21f76ded25cac2f3dc))
