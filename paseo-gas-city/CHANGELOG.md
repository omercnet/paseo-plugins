# Changelog

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
