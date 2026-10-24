# Repository development instructions

Before working in a plugin directory, read that directory's `AGENTS.md` and follow it before running commands.

## Writing plugin code

Before writing or changing plugin code, read the `plugin-development` skill (`.agents/skills/plugin-development`) and fetch the upstream Paseo docs it links: `docs/plugins.md`, `docs/coding-standards.md` and `docs/design.md`. Always read them; do not work from memory.

## Protect live Paseo instances

Treat the default Paseo daemon and `~/.paseo` as production user state.

- Never run daemon or plugin lifecycle commands against the default host during development.
- Runtime, integration, and UI verification must use an isolated daemon, an isolated home, and explicit `--home` and `--host` arguments.
- Follow each plugin's local `AGENTS.md` for its exact test workflow.

## Shipping a change

Use the `deliver` skill (`.agents/skills/deliver`) to take an issue to a merged PR. It owns the isolated-daemon helper, the Astra consult and review gates, and the release rules.
