# Item 09: See and cancel automatic retries

## What it is
When a model provider fails (rate limit, outage), OMP retries on its own with backoff, up to 10 times by default (`retry.maxRetries`, 500 ms base delay, 5 min cap). It emits `auto_retry_start` (attempt, max, delay, error) and `auto_retry_end`. Two RPC commands control it: `set_auto_retry` (per session on/off) and `abort_retry` (stop waiting and surface the error). Users who hit it: anyone on a busy or quota-limited provider, mostly during long unattended runs, when an agent "hangs" for minutes.

## What users get today
- Seeing it: the plugin's provider already turns `auto_retry_*` into a timeline status row ("OMP retry 2/4", running then failed or recovered). That is the plugin provider only; whether the built-in provider shows these rows is unverified.
- Cancelling: Paseo's Stop button aborts the run. Whether OMP's `abort` also cancels a pending retry wait is unverified, but the docs call retry waits "abortable", so Stop most likely covers the real need.
- Tuning: the Configuration tab already edits `retry.enabled`, `retry.maxRetries`, fallback chains, and the Accounts tab edits `retry.waitForUsageReset` and reserve settings.

## Works with the built-in provider?
Not the live parts. `set_auto_retry` and `abort_retry` are not in the built-in provider's command list, so a Cancel button needs our own provider or a Paseo upstream change. A plugin could only change `retry.*` config for new sessions, which exists already. A read-only retry row could be added by reading the session file after a turn, but retries are transient, so a row after the fact has little value.

## Value: low
- The live moment (countdown plus Cancel) is the only valuable part, and it is the part we cannot do.
- Stop already gives users an exit; a dedicated Cancel only differs by keeping the run alive with the error surfaced, which is niche.
- Retries are mostly short and self-healing; the long waits are quota waits, already covered by the Accounts settings.
- A chip would be noise on most messages.

## Best surface / size
If ever done: timeline row with a Cancel action, owned by Paseo's built-in provider (upstream). Plugin size: none worth building. Upstream size: S to M (two commands plus an action on the existing retry row).

## Risks / costs
- Duplicating a Paseo-native feature in a plugin that cannot reach the session.
- Drift: the OMP retry event schema is already tracked in our provider and would need parallel upkeep.
- Cancelling a retry mid-run leaves the agent in an error state users may not expect.

## Recommendation: skip in the plugin
Do not build. Optionally raise one upstream ask to Paseo: show `auto_retry_*` rows for built-in omp agents and map them to a Cancel action via `abort_retry`. Verify first that Stop already cancels a retry wait (unverified).

Related for other items: item 10 (usage-limit banner) shares the "long quota wait" pain and is the more useful surface.
