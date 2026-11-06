# Gaps: OMP features Paseo users can't get without upstream changes

Known gaps as of 2026-11-05. Each one needs a change outside this plugin; the plugin cannot close it on its own for agents on Paseo's built-in `omp` provider. Feature gaps were not filed upstream (Paseo closes feature requests opened as issues); confirmed bugs were filed, see the last section.

## Gap 1: no live OMP commands from the built-in provider

The built-in `omp` provider only sends prompt, steer, abort, compact, handoff, branch, model, thinking, fast mode and a few state reads. A plugin cannot send any other OMP command into a running session.

| Item | What users miss | OMP command it would need |
|---|---|---|
| 03 | Remove or promote a queued steer/follow-up; Stop restoring queued text to the composer | `remove_queued_message`, `promote_queued_message`, `abort_and_restore_queue` |
| 04 | Goal panel: create, pause, resume, drop, budget meter | `goal` |
| 05 | Native side question without a new agent (community /btw plugins cover it with a fresh agent) | `btw` |
| 07 | Paseo agent rename reaching OMP's session title | `set_session_name` |
| 08 | Fork a conversation from a message into a new agent | `fork` |
| 09 | Live retry countdown with Cancel | `set_auto_retry`, `abort_retry` |
| 10 | Usage-limit banner with reset time | `get_state.usageLimit` |
| 12 | Editing the agent's todo list | `set_todos` |
| 14 | `!cmd` shell from the composer into the agent's context | `bash`, `abort_bash` |
| 15 | Starting agents in an already running OMP process | `new_session`, `open_session` |

Our own `omp-plugin` provider could implement these, but it is planned for deprecation.

## Gap 2: rich tool results reduced to text

The built-in provider keeps only the text of tool results, so images and structured details never reach the client.

| Item | What users miss |
|---|---|
| 45 | Browser and desktop screenshots from `eval`. Worked around in #525: the plugin reads the images from OMP's session file and shows a Screenshots row under the turn |
| 44 | `eval` code, table/JSON/Markdown views and images |
| 49 | Generated images inline. Worked around in #513: the plugin reads the file named in the text result and shows a thumbnail with Download |
| 43 | Live CI status card for the github tool |

Related Paseo issue: getpaseo/paseo#3244 (fix PR #3245 was closed unmerged).

## Gap 3: OMP does not report enough to Paseo

| Item | What users miss | What OMP would need to provide |
|---|---|---|
| 31 | A broken `models.yml` silently drops custom models; "Refresh models" serves a stale list | Report the config error over RPC; refresh on request. The plugin now checks `models.yml` and offers Refresh models in Diagnostics (#520), but agents still get no error |
| 22 | Always-apply and rulebook rules from other tools (Cursor, Copilot) in the Rules tab | A command that lists every rule kind, not only watch rules |
| 21 | Turned-off skills in a Skills list | A list option that includes disabled skills |
| 28 | Extension load errors for built-in agents; an extensions catalog | Forward `extension_error`; a list command |
| 41 | User-controlled Apply/Discard for structural edit previews | Pause on a pending preview plus a resolve command |

## Gap 4: Paseo client features a plugin can't add

| Item | What users miss |
|---|---|
| 50 | Highlighting OMP magic keywords in the message box (no text-decoration API for plugins) |
| 49 | An audio file player for generated speech |
| 06 | Delivering a daemon-side file (exported transcript) to phone or web users (unverified whether plugins can) |
| 22 | "View rule" from a rule-fired notice opens the OMP screen, which is user scope only: plugin screens get no workspace context, so a project-only rule shows a "not in this scope" note (#532) |

## Bugs filed upstream

- [getpaseo/paseo#8915](https://github.com/getpaseo/paseo/issues/8915): Paseo's built-in provider passes `--append-system-prompt` when Paseo's Append system prompt is set, and OMP treats that as a replacement for the user's `APPEND_SYSTEM.md`, so the file silently stops applying (item 25). The plugin warns about it in Diagnostics (#517).
- [getpaseo/paseo#8914](https://github.com/getpaseo/paseo/issues/8914): the provider `disallowedTools` setting is merged for the built-in `omp` provider but never passed to OMP at launch, so it is silently ignored (items 35 and 40).

Both reproduced on Paseo 0.15.2 and unchanged on Paseo `main` at the time of filing.
