# Configuration

Open the global **OMP** sidebar to browse and edit machine-wide state, or open the workspace **OMP** panel from the workspace tab or Explorer to manage project-scoped state. Scalar edits in the global surface use OMP's native `config set` and `config reset` commands. The same view provides bounded row editors for `modelRoles`, `retry.fallbackChains`, `cycleOrder`, `task.agentModelOverrides`, `task.agentServiceTierOverrides`, `task.agentPrewalk`, and `task.agentAdvisor` when OMP includes them in its native settings catalog. Workspace edits create validated overrides in `<workspace>/.omp/config.yml`; removing an override restores the effective global or default value. Other arrays and records, and all credentials, remain read-only.

The **Plugin** tab documents and manages host-wide inherited environment names and the session limit, plus the supported `omp-plugin` profile launch options. Paseo's public plugin API does not expose the effective provider options for active launches, so the tab does not claim profile values are active. Choose **OMP Plugin** when creating an agent. Model, mode, thinking level, system prompt, persistence, MCP servers, workspace, and agent environment use Paseo's standard provider controls.

## Provider profile launch overrides

Advanced profile-specific launch overrides belong in an `omp-plugin` provider profile. The provider options schema is strict; unknown fields fail validation.

```json
{
  "provider": "omp-plugin",
  "providerOptions": {
    "command": ["/opt/omp/bin/omp"],
    "params": {
      "sessionDir": "/var/lib/omp/sessions",
      "rpcTimeoutMs": 60000,
      "smolModel": "openai/gpt-5-mini",
      "slowModel": "anthropic/claude-opus-5",
      "planModel": "openai/gpt-5.4"
    }
  }
}
```

| Option | Purpose |
| --- | --- |
| `command` | Complete OMP executable and argument prefix. |
| `env` | Non-secret process overrides applied below the session launch environment. |
| `inheritEnv` | Additional daemon environment variable names copied only when OMP starts. Host-wide names are configured in **OMP → Plugin**; values are never stored in a profile or displayed in the sidebar. |
| `outputRedaction` | `none` (default) preserves native output. `configured-values` performs best-effort literal replacement only for explicitly supplied configured credential values from profile/session credential environment fields and configured MCP headers or environment. |
| `params.sessionDir` | Native OMP session directory supplied through `--session-dir`. Used consistently by discovery, import, resume, and launch. |
| `params.rpcTimeoutMs` | Startup, request, catalog, and availability timeout, from 1 ms through 10 minutes. |
| `params.smolModel` | Native selector supplied through `--smol`. |
| `params.slowModel` | Native selector supplied through `--slow`. |
| `params.planModel` | Native selector supplied through `--plan`. |

Paseo's generic provider profile fields remain available:

| Profile field | Behavior |
| --- | --- |
| `models` | Replaces the discovered model list. |
| `additionalModels` | Extends the discovered model list. |
| `disallowedTools` | Restricts only the known native OMP built-ins accepted by this plugin. It becomes an explicit OMP allow-list; unknown names fail closed rather than being ignored. It does not filter MCP host tools. |
| `paseoTools` | Enables or restricts which caller-scoped Paseo orchestration tools the daemon includes before they reach OMP as MCP host tools. |

These options cover plugin-specific profile overrides. Host-wide inherited environment names are configured separately in **OMP → Plugin**. Values that belong to an individual agent, including model, mode, thinking level, title, system prompt, MCP servers, persistence, and cwd, remain standard Paseo session fields rather than duplicate plugin options.

## Session limit

**OMP → Plugin → Session limit** caps how many OMP Plugin sessions can be open on the host at once. One count covers the default provider, every `OMP · <profile>` provider, and every configured provider that extends them. Idle agents count while their sessions are open; archiving an agent closes its session. The default is 32 and the maximum is 64. At the limit, a new agent fails with `OMP session limit reached (<limit> open sessions)` before any OMP process starts. Archive idle agents or raise the limit; a new value applies to the next session that opens and leaves open sessions running.

## OMP-native plugins

Open **OMP → OMP plugins** globally for user-scoped management, or use the workspace **OMP** panel to include project-scoped installations and effective project overrides. The manager uses OMP's documented singular `omp plugin` CLI and supports install, enable, disable, upgrade, and uninstall operations. Every state-changing action requires explicit confirmation; already-running OMP sessions are unchanged.

Project-scoped lifecycle commands run from the selected workspace and use `--scope project`. Duplicate path installations that share one npm package identity remain read-only because OMP's lifecycle CLI addresses npm plugins by package name rather than installation path. Plugin configuration exposes schema metadata without returning current or default values. Non-secret scalar plugin settings can be set or deleted through write-only controls. Secret settings are presence-only and delete-only because OMP's CLI would otherwise expose a new secret through process arguments.

The Configuration view links to the official OMP settings reference, value parsing and precedence guides, relevant category sections, and a small curated set of setting-specific anchors.


## MCP tools, management, and policy boundary

Configured MCP servers and Paseo's caller-scoped MCP tools are supported. The plugin discovers their schemas, assigns collision-safe OMP names, binds them before `session.ready`, forwards progress and terminal results, propagates cancellation, and renders calls with friendly labels.

Use the **MCP** control beside the composer on an **OMP Plugin** agent to run OMP's native list, add, reload, test, authorize, enable, disable, resource, and prompt commands. The control is agent-scoped because OMP MCP discovery depends on both the active profile and the workspace directory. The global OMP sidebar remains a host-level health and settings surface; a separate workspace manager would duplicate OMP's own discovery and precedence rules.

Command output, setup questions, and OAuth prompts appear in the agent timeline. OAuth URLs render as an interactive card and always retain the full provider authorization URL, never substituting OMP's daemon-local `/launch` shortcut. **Open in Paseo Browser** calls the current agent's caller-scoped `browser_new_tab` tool, so the authorization page becomes a browser tab in the same workspace; it requires Paseo tools to be injected into the agent, browser tools to be enabled, and a connected Paseo desktop browser host. **Open on this device** remains available when no browser host is connected. For a loopback callback to complete automatically, the chosen browser host must run on the daemon machine. Otherwise, finish authorization in either browser, copy the final redirect URL or authorization code, and submit it in the OMP authorization prompt. Tokens and refresh material are stored by OMP on the daemon (or its configured auth broker), never in the Paseo client or plugin timeline.

Paseo's exact session `toolPolicy` preapproval grants are not equivalent to OMP's `set_host_tools` contract. The plugin cannot preserve that policy exactly, so any non-empty `toolPolicy` rejects session startup. It never converts exact grants into broader access. `disallowedTools` is separate: it controls only recognized native OMP built-ins and rejects unknown names. The **OMP → Plugin** tab shows the same boundary in its Tool access boundary card.

## Subagent controls

Paseo shows each OMP subagent as a read-only child of its agent. While subagents run, an **OMP Plugin** agent's conversation shows one row per running subagent under the `task` card that started it, with its agent type, description, and running time:

- **Steer** opens a one-line message field in place. Enter sends up to 16,384 characters through OMP's `steer_subagent` and Esc closes it. The subagent receives the message as its user at its next step, so slash commands and prompt templates run in the subagent. If OMP does not confirm delivery before the provider RPC timeout, the message may still arrive; check the subagent before sending it again.
- **Stop** asks for confirmation in place, then calls OMP's `cancel_subagent`. OMP stops the subagent and its nested subagents; the parent turn continues and receives an aborted task result. Stopping a subagent that already finished reports that and changes nothing.

Rows disappear as their subagents finish. Outcomes and errors appear as Paseo toasts. A request is routed to the subagents of the agent named in it, and only while that agent's OMP runtime is running; the controls never start or resume a runtime. OMP names subagents after their task, so rows show agent types and descriptions after the agent's `outputRedaction` and address each subagent by an opaque handle rather than its OMP ID. Both actions need OMP 18.4.9 or newer.

The controls follow Paseo's client trust model. They are plugin RPCs, which the daemon only accepts from clients with its `daemon.manage` permission. That permission is a superset of what the controls can do: a `daemon.manage` client can already install plugin code on the daemon. The agent ID in a request selects the agent rather than limiting who may act on it, because the daemon passes no caller identity to the handler. A client without `daemon.manage` sees the rows but its requests are rejected.

## OMP accounts

The **Accounts** tab of the OMP screen lists the logins in OMP's own credential store for the selected store, grouped by provider. An OAuth login shows OMP's usage bars and reset times, and says whether the reading is live or OMP's last recorded one when the provider gave none. A provider with several logins also shows where OMP would start new agents right now, from `omp dry-balance`. OMP balances agents across its logins and moves off one that hits a limit by itself; this view does not change that.

- **Add login** runs OMP's own sign-in for a provider OMP offers. Open the sign-in page on any device. On the host's computer sign-in finishes by itself; anywhere else, paste the code or the address of the page that failed to load. One sign-in runs at a time because OAuth callbacks use fixed local ports. Closing the dialog stops the `omp` process.
- **Remove** signs one login out of OMP after a confirmation. It is OMP's store, so `omp` in a terminal loses the login too.
- **Use reset** spends one banked reset (`omp usage reset <provider>/<id>`) after a confirmation, and is disabled with OMP's reason when OMP cannot use one right now.
- **Prefer** makes a login the one new agents for its provider start on while it has room, and **Keep in reserve** sets the quota OMP leaves unused on it. Both edit that login's entry in OMP's own `auth.accountPolicies` (priority 100 with a reclaim threshold 15 points above the reserve that applies), replacing only that entry and keeping any other policy fields or accounts as written. At most one login per provider is preferred. They show only for logins OMP gives an account id for, which today means Claude and ChatGPT.
- **How OMP uses these logins** edits OMP's `retry.usageReservePct`, `retry.usageReservePolicy`, `retry.waitForUsageReset`, and the `codexResets` and `claudeResets` auto-redeem and keep-credits settings through `omp config set`, so the Configuration tab and terminal `omp` see the same values.

The plugin reads no OMP credential file and never receives a token. Every read and action goes through the `omp` command, and a pasted code goes straight to its standard input. Reads are cached for five minutes; **Refresh** asks the providers again. Logins belong to the selected store, so a profile shows its own. The tab is host-level and does not appear in the workspace OMP panel.

## OMP MCP servers

The **MCPs** tab of the OMP screen lists the MCP servers `omp` reports for the selected store, with their transport, state and where each is defined. Every read and change the tab makes goes through OMP's own `/mcp` commands, so `omp` in a terminal sees the same list and the tab never reads or writes `mcp.json` itself.

- **Add server** takes a name and either a URL, added with `/mcp add <name> --scope user --url <url>`, or a command line, added after `--`. It writes to OMP's user MCP file. A URL cannot contain spaces. OMP's `/mcp add` never connects, so the plugin runs `/mcp test` right after. A server that answers is reported as connected; one that answers HTTP 401 is reported as needing **Authorize**; anything else (refused connection, unknown host, 404, a page that is not an MCP server) stays added but is flagged on the page as probably not a working MCP server, with OMP's own message, so a mistyped address is not mistaken for a good one.
- **Test**, **Enable** and **Disable** run the matching `/mcp` command. **Remove** asks for confirmation and removes the server from the user file only; its OAuth sign-in is kept.
- **Authorize** runs `/mcp reauth` for a remote server (HTTP or SSE). Open the sign-in page on any device. On the host's computer OMP's own callback finishes it by itself; anywhere else, paste the address of the page that failed to load, or the code, and the plugin hands it to OMP's local callback. Only OMP's own loopback address is ever called. One authorization runs at a time because OMP's callback listens on a fixed local port, and closing the dialog stops the `omp` process. OMP stores the login under the exact server URL, and sign-in can succeed on a URL that is not the MCP endpoint (for example a missing `/mcp` path), so the plugin tests the server once sign-in finishes. If the test still fails, the dialog says the login is saved but the address may be wrong, with OMP's message.

OMP's rpc mode reports the outcome of a command only as printed text, so a result the plugin cannot recognise as a failure is shown as success. The server list is cached for 30 seconds; **Refresh** and every change read it again. Servers belong to the selected store, and the tab is host-level: it does not appear in the workspace OMP panel.

## OMP rules

The **Rules** tab of the OMP screen and of the workspace OMP panel shows which OMP rules apply. It is read-only: each rule shows the file it comes from, so you change a rule by editing that file.

- **Watch** lists the rules `omp ttsr list` reports: rules with a `condition`, `astCondition`, or `question` that step in when the agent writes something they match. Built-in rules are collapsed under one row.
- **Always applied** lists rules with `alwaysApply: true` and the `RULES.md` files, which go into every prompt in full.
- **Rulebook** lists rules with only a `description`, which OMP names in the prompt and reads when relevant.
- **Turned off** lists the names in the effective `ttsr.disabledRules` setting. OMP hides these rules, so only their names are known.

Always-applied and rulebook rules are read from OMP's own rule files: `.omp/rules/*.md` and `*.mdc` in the workspace, `rules/` and `RULES.md` in the selected store's agent directory, and the nearest project `.omp/RULES.md`. The global screen never reads project files. Rules imported from other tools, such as Cursor or Windsurf, appear only when they are watch rules. Rule settings (`ttsr.*`) live in the **Configuration** tab. Rule and setting changes apply to new sessions, or to an agent after a reload.

## Credentials and environment

The plugin is deny-by-default. It inherits only its fixed built-in allowlist of core provider authentication variables, exact host-wide names an operator selects in **OMP → Plugin**, and additional exact profile names under `providerOptions.inheritEnv`; it does not discover or inherit arbitrary credential-shaped names. Prefer OMP's native credential store or auth broker whenever possible.

For example:

```json
{
  "provider": "omp-plugin",
  "providerOptions": {
    "inheritEnv": ["ACME_PROFILE_ONLY_TOKEN"],
    "outputRedaction": "configured-values",
    "env": {
      "ACME_OMP_REGION": "us-east-1"
    }
  }
}
```

Host and profile `inheritEnv` values are combined and deduplicated, with host names first. `inheritEnv` accepts an array of at most 256 names after combining, each matching `[A-Za-z_][A-Za-z0-9_]{0,127}`. Selecting a name is an operator trust decision: its daemon-owned value becomes available to the OMP child and anything OMP launches. The plugin resolves selected values from the Paseo daemon environment immediately before each catalog or session launch. Unselected variables remain absent. Explicit `providerOptions.env` and per-session `env` overlays win over inherited values with the same name.

Profiles, persistence, errors, and catalog cache identity contain only the configured `inheritEnv` names, never resolved values or secret-derived hashes. A selected variable that is present and not shadowed by explicit `env` must contain at least 4 UTF-8 bytes. The existing 64 KiB per-value and 1 MiB total environment bounds still apply; shadowed daemon values are neither validated nor counted.

Process-control variables are always rejected case-insensitively, even when explicitly selected. The blocked prefix families are `BUN_INSTALL*`, `DYLD_*`, `GIT_CONFIG*`, `LD_*`, and `NPM_CONFIG_*`. The blocked exact names are:

```text
BASH_ENV, BUN_OPTIONS, CLASSPATH, CLAUDE_BASH_NO_CI, CLAUDE_BASH_NO_LOGIN,
CLAUDE_CODE_SHELL_PREFIX, EDITOR, ELECTRON_RUN_AS_NODE, ENV, GEM_HOME, GEM_PATH,
GIT_SSH_COMMAND, HOME, JAVA_TOOL_OPTIONS, NODE_OPTIONS, NODE_PATH,
OMP_AUTORESEARCH_DB_DIR, OMP_COMMAND, OMP_GITHUB_CACHE_DB, OMP_PROFILE,
OMP_WORKTREE_DIR, PATH, PATHEXT, PERL5LIB, PERL5OPT, PI_BASH_NO_CI,
PI_BASH_NO_LOGIN, PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR,
PI_CONFIG_DIR, PI_CONFIG_FILES, PI_GIT_COMMON_DIR, PI_PACKAGE_DIR, PI_PROFILE,
PI_PROJECT_DIR, PI_SESSION_ID, PI_SHELL_PREFIX, PI_SUBPROCESS_CMD,
PI_WORKTREE_DIR, PWD, PYTHONHOME, PYTHONINSPECT, PYTHONPATH, PYTHONSTARTUP,
RUBYLIB, RUBYOPT, SHELL, SYSTEMROOT, USERPROFILE, VISUAL, XDG_CACHE_HOME,
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR, XDG_STATE_HOME, _JAVA_OPTIONS
```

Unlike `inheritEnv`, `providerOptions.env` stores its literal values in the provider profile/configuration. Use it only for deliberate non-secret overrides. If configuration contains sensitive values anyway, restrict `<paseo-home>/config.json` to the daemon account (`chmod 600` on POSIX), protect backups, and never attach it to an issue.

The plugin validates and bounds native protocol data, but it does not heuristically detect, redact, or rewrite credentials in OMP, model, or tool content. Never put credentials in prompts or tool output. With `outputRedaction: "configured-values"`, every non-empty value selected through `inheritEnv` is treated as sensitive regardless of its name, alongside the existing explicitly configured credential values. Exact configured literals are replaced on a best-effort basis; generated secrets and encoded, transformed, or independently streamed fragments are not detected. With the default `none`, inherited values are not rewritten in output. Centralized Paseo policy is required for redaction guarantees. Unexpected or internal launch failures use fixed fallback messages rather than serializing the launch configuration, while explicit public validation errors may include caller-supplied configuration names or values.

## Modes and permissions

- `full` is always available.
- `write` and `ask` appear when Paseo negotiates provider permission support.
- Typed OMP approval frames become Paseo tool permissions when both sides negotiate `typedToolApprovals: 1`.
- OMP 18.1.15 uses the bounded generic interaction fallback.
- Changing approval mode requires a new session. Live model and thinking changes are supported.

## Persistence and images

Non-persisted sessions use `--no-session`. Persistent sessions keep a versioned native handle, replay before becoming ready, and recover with the effective launch configuration.

For text-only models, image inputs are written to a private bounded temporary directory shared with the local OMP child and removed after the turn, session, or failed launch.

Every OMP process launched by the plugin receives provider-owned `OMP_NO_WEBP=1` compatibility mode after caller environment validation, so generated and resized images use PNG or JPEG across Paseo clients without reducing the configured environment limits. Persisted or upstream WebP blocks are still retained: capable clients render them directly, while an unsupported client shows a per-image fallback instead of failing the timeline item.
