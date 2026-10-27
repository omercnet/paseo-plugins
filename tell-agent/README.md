# tell-agent

Send a message from one Paseo agent to another agent or workspace on the same daemon host.

## Demo

https://github.com/user-attachments/assets/93e67f62-67c5-4367-87ce-39da0aba7ebb

## Screenshots

Agent and workspace names are synthetic. Both PNGs were captured from an isolated Paseo test
daemon at 2× pixel density after browser DevTools verified that no private organization names
remained in the rendered page.

### Choose a target

![Tell Agent target picker](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/tell-agent/docs/images/tell-agent-picker.png)

### Compose an instruction

![Tell Agent instruction composer](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/tell-agent/docs/images/tell-agent-compose.png)

## Install

### Paseo 0.9.0 or 0.10.1

Install the npm package:

```bash
paseo plugin install npm:@omercnet/paseo-tell-agent
```

Update an npm installation by its plugin ID:

```bash
paseo plugin update tell-agent
```

Paseo 0.9 and 0.10 use the reviewed update flow to show the current and proposed revisions before asking for approval. Add `--check` to preview without applying or `--yes` to skip the approval prompt.

## Use

Run the slash command from an agent composer:

```text
/tell [--interrupt] <agent or workspace> :: <message>
```

For example:

```text
/tell Payments :: Review the authentication change.
```

The target can match an active agent's title or ID, or its project or workspace name. Ambiguous matches must be refined.

`tell-agent` only searches agents connected to the same Paseo daemon host. It does not discover or contact agents on other hosts.

On Paseo 0.12 and later, agents in background workspaces are hidden from discovery. They do not appear as targets, and their composers do not get the Tell agent button.

The plugin asks the source agent to forward the message to the resolved target. The source agent remains responsible for executing that instruction; the plugin does not inject the text directly into the target session.

If the source agent is busy, `/tell` and the Tell agent panel send that instruction with `activeTurnBehavior: "steer"`. Paseo tries to add it to the running turn instead of interrupting it, and the agent picks it up at its next step, which can be after its current tool call finishes. Steering is best effort: Paseo still replaces the turn when the provider cannot steer. Paseo 0.9 and later hosts accept both the steer and interrupt behaviors. Put `--interrupt` first to replace the source agent's current turn instead:

```text
/tell --interrupt Payments :: Stop and review the authentication change.
```

Either choice only applies to the source agent. Its later message to the target is a separate send. On Paseo 0.12 and later, an agent's send steers a running target by default and falls back to interrupting when the provider cannot steer. The target shows it as a message from the source agent. Tell the source agent to use `interrupt` if you want the target's turn replaced. Before 0.12, an agent's send always interrupts a running target.

On Paseo 0.13, an agent's send to another agent is queued instead of dispatched at once. Paseo delivers it after about two seconds with no further agent messages for that target, and merges the messages that arrive in that window into one prompt with one block per message. The target's completion notice back to the source agent is batched the same way, so a report and a finish notice can arrive together. Expect the target to receive a `/tell` roughly two seconds after the source agent forwards it. Messages with conflicting steer or interrupt behavior are delivered separately, in order. The pending window is kept in memory: a clean daemon shutdown flushes it, but a crash can lose it. The `/tell` instruction to the source agent is a user prompt and is not delayed.

Closed agents are offered as targets. A closed agent has no live runtime but keeps its record and provider session, and a message to it resumes that session. On Paseo 0.13, a daemon restart marks agents that were running as closed. On Paseo 0.14, an eligible agent that has been idle for an hour is closed automatically (pending permissions, active work and provider safety checks keep it live); set `agents.idleRuntimeCleanup: false` in the host config to turn that off. Archived agents are never offered.

## Trust

Paseo plugins run as trusted, unsandboxed code. Installing this package trusts its code, dependencies, and future updates. Review the package and update preview before approving an installation or update.
