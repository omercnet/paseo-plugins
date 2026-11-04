# Paseo OMP development

## Protect the user's Paseo instance

The Paseo instance that launched the current agent is production user state. During development:

- NEVER run plugin install, reload, enable, disable, update, or remove commands against the CLI default host.
- NEVER use the default `~/.paseo` home for plugin testing.
- NEVER run a bare `paseo reload`, `paseo restart`, `paseo daemon stop`, or `paseo daemon restart`.
- Unit tests and static checks do not need a daemon. Run them directly.
- Any runtime, integration, or UI check MUST use a dedicated Paseo daemon with its own home and an explicit host on every plugin command.

Omitting `--host` from a plugin command or `--home` from a daemon lifecycle command is unsafe, even when `PASEO_HOST` or `PASEO_HOME` appears to be set.

## Launch the dedicated development daemon

Run this workflow from the `paseo-omp` directory.

1. Install dependencies and typecheck before loading the plugin:

   ```sh
   bun install
   npm run typecheck
   ```

2. Use the worktree-local, ignored home at `$PWD/.paseo-dev`. Create `.paseo-dev/config.json` with:

   ```json
   {
     "version": 1,
     "pluginsEnabled": true,
     "features": {
       "webUi": {
         "enabled": true
       }
     },
     "daemon": {
       "listen": "<tailscale-ip>:0",
       "relay": {
         "enabled": false
       }
     }
   }
   ```

   Use `tailscale ip -4` for `<tailscale-ip>` so a human can open the demo from another device, and `127.0.0.1` only when there is no Tailscale address. `:0` asks the OS for an unused port. Do not copy configuration, plugins, agents, workspaces, or credentials from `~/.paseo`.

   Give OMP its own agent directory as well, or UI checks edit your real `~/.omp` (MCP servers, logins, settings). A fresh directory has no model, and a bare `omp --mode rpc` refuses to start without one, so the Accounts and MCPs tabs show `omp exited with code 1`. Seed one local stub model:

   ```sh
   OMP_DEMO_DIR=$(mktemp -d)
   printf 'providers:\n  localtest:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: not-a-real-key\n    api: openai-completions\n    models:\n      - id: stub\n        name: Stub\n        input: [text]\n        contextWindow: 8000\n        maxTokens: 1000\n' > "$OMP_DEMO_DIR/models.yml"
   printf 'modelRoles:\n  default: localtest/stub\n' > "$OMP_DEMO_DIR/config.yml"
   ```

   Pre-seed `$OMP_DEMO_DIR/mcp.json` or other state with whatever the change needs a human to try. The plugin passes `PI_CODING_AGENT_DIR` through but not provider API keys, so the stub model is the only way in.

3. Start only that home with the project-pinned Paseo CLI. The config owns the listen, relay, web UI, and plugin settings:

   ```sh
   PI_CODING_AGENT_DIR="$OMP_DEMO_DIR" npx --no-install paseo daemon start --home "$PWD/.paseo-dev"
   npx --no-install paseo daemon status --home "$PWD/.paseo-dev" --json
   ```

4. Read the actual `listen` value from the status response and keep it as `DEV_HOST`. Use the literal value with `--host` on every plugin command. Do not rely on `PASEO_HOST`.

   Inspect the configured plugin first:

   ```sh
   npx --no-install paseo plugin ls paseo-omp --host "$DEV_HOST" --json
   ```

   If it is absent, install the current checkout. If it exists, require its source to be `directory` and its resolved `path` to equal the current `$PWD`; only then reload it:

   ```sh
   npx --no-install paseo plugin install "$PWD" --host "$DEV_HOST"
   # or, only after confirming the configured path matches this checkout:
   npx --no-install paseo plugin reload paseo-omp --host "$DEV_HOST"
   npx --no-install paseo plugin ls paseo-omp --host "$DEV_HOST" --json
   ```

   A mismatched path or Git source is not this development checkout. Remove that entry from the dedicated host with an explicit `--host`, install `$PWD`, and inspect it again. Do not continue until the isolated instance reports `status: "running"`, no error, and the expected directory path.

5. Exercise UI behavior at `http://$DEV_HOST/`. For provider behavior, explicitly select the plugin provider ID `omp-plugin`; selecting the bundled `omp` provider does not test this code. Create and inspect the test agent only on `DEV_HOST`, and verify its recorded provider is `omp-plugin`. Confirm error paths as well as the successful path.

6. Leave the daemon running when you finish, with the plugin installed from `$PWD` and the demo state seeded, so a human can test it. Confirm `plugin ls` still reports `status: "running"` as your last command, then report `http://$DEV_HOST/`, where to click, what is seeded, and the stop command. Run it only when the human says they are done, or to replace the daemon with a fresh one:

   ```sh
   npx --no-install paseo daemon stop --home "$PWD/.paseo-dev"
   ```

Before any daemon or plugin lifecycle command, inspect the command and verify its explicit `--home` or `--host` still points to `.paseo-dev`. The Docker canary in `canary/` is also isolated and remains the preferred full end-to-end regression environment.
