# Repository development instructions

Before working in a plugin directory, read that directory's `AGENTS.md` and follow it before running commands.

## Writing plugin code

Before writing or changing plugin code, read the `plugin-development` skill (`.agents/skills/plugin-development`) and fetch the upstream Paseo docs it links: `docs/plugins.md`, `docs/coding-standards.md` and `docs/design.md`. Always read them; do not work from memory.

## Protect live Paseo instances

Treat the default Paseo daemon and `~/.paseo` as production user state.

- Never run daemon or plugin lifecycle commands against the default host during development.
- Runtime, integration, and UI verification must use an isolated daemon, an isolated home, and explicit `--home` and `--host` arguments.
- Follow each plugin's local `AGENTS.md` for its exact test workflow.

## Leave the demo daemon running

When a change has runtime or UI behavior, finish with the isolated daemon still up, the plugin loaded from the checkout, and something to try already in place (a seeded scenario, not an empty state). Do not run `down` or `daemon stop` at the end of the task. A human tests it next.

- Bind it to the Tailscale address so it opens from another device. `dev-daemon.sh up` does this; `paseo-omp` follows its own `AGENTS.md`.
- Before yielding, confirm it is still up: `plugin ls` shows `running` with no error. A daemon started in a sandboxed runner can die when the call ends; restart it if so.
- Report the URL, where to click, what is seeded, and the exact command that stops it.
- Stop it only when the human says they are done, or to replace it with a fresh one.

## Shipping a change

Use the `deliver` skill (`.agents/skills/deliver`) to take an issue to a merged PR. It owns the isolated-daemon helper, the Astra consult and review gates, and the release rules.
