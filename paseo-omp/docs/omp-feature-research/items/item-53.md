# Item 53: Shared login broker status

## What it is
OMP can keep provider logins in a central "auth broker" (a credential vault server on another host) instead of each machine's local store. A second piece, the "auth gateway", is a proxy that lets containers and tools call models without ever seeing tokens.
- `omp auth-broker status`: pings the configured broker. Without one it returns `{"ok":false,"reason":"not_configured"}` (verified).
- `omp auth-broker migrate --from-local --dry-run`: previews uploading local logins to the broker. One-time setup step.
- `omp auth-gateway status|check`: token file and broker reachability for a gateway, and a per-credential probe (`--strict` can spend quota).
- `task.agentAccountPools`: setting that pins a named task subagent to specific OAuth accounts (identity keys from `omp usage accounts`).

Who uses it: operators running OMP on several hosts, CI, or containers who want one vault. They set it up in a terminal. A typical Paseo user on one daemon host has no broker.

## What users get today
- Accounts tab lists logins, usage, resets and balancing via OMP's RPC; any broker failure surfaces as the tab's existing "Could not read OMP's accounts: ..." error (unverified with a real broker).
- No broker or gateway status anywhere in the plugin. `auth.broker.token` is deliberately kept out of the config views.
- `task.agentAccountPools` has no dedicated UI. It may be editable as raw JSON in the typed settings editor (unverified).
- Paseo itself has nothing for this.

## Works with the built-in provider?
Yes. All of it is CLI or config on the daemon host; no live RPC command is needed. Broker and gateway status are `--json` reads; pools are a config write that applies to new sessions.

## Value: low
- Audience is tiny: only users who already run a broker, and they set it up and debug it from a terminal.
- Gateway status/check is irrelevant to Paseo: Paseo agents do not go through the gateway. `check --strict` can burn quota.
- Migrate is a one-off setup action, not something to click twice.
- The one real gap: in broker mode, if the broker is down, agents fail and the Accounts tab shows only a generic error. A one-line "Logins come from broker <url>: reachable / unreachable" would explain it. Useful, but rare.
- Per-agent account pools matter only with several accounts on one provider plus named task agents you want to separate (e.g. keep a work org off a reviewer agent). Real but niche; balancing and reserve already cover most needs.

## Best surface if built
- Broker line: conditional notice at the top of the Accounts tab, shown only when `auth-broker status` is not `not_configured`. Size S.
- Agent pools: a small "Task agent pools" card in Accounts using `omp usage accounts` identity keys. Size M (needs agent names and validation). No pill for either.

## Risks/costs
- Status call on every Accounts load adds a network ping to a remote host; needs a timeout and caching.
- Broker URL may reveal internal hostnames in screenshots/support reports.
- Pools fail closed: a wrong identity key makes that agent fail every request, which is a support trap if edited from a UI.
- Drift: broker/gateway CLI is young and changes often.

## Recommendation
Skip for now. Revisit the conditional broker line (S) if a user reports confusing Accounts errors in broker mode. Do not expose gateway or migrate. Leave agent pools to config.

## Unverified
Behavior against a real broker; whether Accounts in broker mode lists broker logins; whether the settings editor shows `task.agentAccountPools`.

Note for other items: `omp auth-gateway status` resolved its token file under `~/.omp` even with `PI_CODING_AGENT_DIR` set (config dir follows `PI_CONFIG_DIR`); isolated tests should set both.

## Paseo check (2026-11-05)
- Paseo already has: Usage sources that discover ChatGPT and Claude logins stored by OMP by reading the local `agent.db` read-only (`plugins/codex-usage-source/server/stores.ts`, `plugins/claude-usage-source/server/stores.ts`, PR #5844, in 0.15.x). The Usage modal shows plan windows per account (`docs/glossary.md` Usage report).
- Not in Paseo: any broker or gateway status, agent account pools, or error explanation in broker mode. Source search for broker finds only Paseo's browser-tools broker and an `OMP_AUTH_BROKER_URL` env value in a usage-source test fixture, where local rows are still read; the sources do not call the broker.
- Effect on the decision: recommendation unchanged (A, skip). Core Usage may show local OMP logins that a broker user does not actually use; not a reason to build here.
- Unverified: behavior of Paseo's Usage cards against a real broker; no registry plugin found for broker status (search only, not exhaustive).
