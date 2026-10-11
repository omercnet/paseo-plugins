Tell Agent lets one agent pass a message to another agent on the same Paseo host. From an agent's composer, run `/tell [--interrupt] <agent or workspace> :: <message>`. The target matches an active agent's title or ID, or a project or workspace name, and the command fails if a name matches more than one agent. Running `/tell` with no arguments opens a panel for choosing a target and writing the message.

## How it works

The plugin does not write into the target's session. It asks the agent you are typing in (the source agent) to forward your message to the target, and the source agent carries that out. If the source agent is busy, the request is added to its running turn. Put `--interrupt` first to replace its current turn instead.

## Reads and sends

- Reads the titles, workspace and project names and IDs of agents on the host you are connected to.
- Sends your message and the target agent's ID to the source agent over the existing host connection.
- Only agents on the same host are reachable. It reads no files and contacts no other service.
