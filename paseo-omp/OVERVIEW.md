OMP adds an agent provider for the OMP coding agent, plus an OMP sidebar and workspace panel for configuring it. Choose **OMP Plugin** when creating an agent, and Paseo runs OMP on the daemon host and maps its prompts, images, steering, tool permissions, subagents, session history and conversation rewind into Paseo. It runs alongside Paseo's bundled `omp` provider without changing it or migrating existing `omp` agents. Sessions created by an earlier alpha preview may need to be re-imported after an upgrade.

## Setup

- Paseo 0.9.2 through 0.9.x, 0.10.x or 0.11.x.
- OMP 18.1.15 or newer on the daemon host, speaking RPC protocol v2. Older runtimes are rejected.
- Provider options let you change the OMP command, set environment values, choose an output redaction mode and set a session directory and timeout. Named OMP profiles appear as separate **OMP · <profile>** providers.

## What the sidebar and panel do

- Edit OMP settings and project configuration for the default store or a named profile.
- Manage OMP's own plugins, and view quota history, memory, hub processes, session history and a support report.
- An **MCP** composer control runs OMP's MCP management in the current session, with authorization prompts shown in the chat.

## Reads and sends

- Runs the OMP command as a process on the daemon host. Its output is passed to Paseo as produced, apart from validation and length limits.
- Reads OMP's settings, configuration, session transcripts, quota history, memory and hub state on the host, and writes OMP's settings file when you edit settings in the panel.
- With the default output redaction, nothing is redacted, so do not put credentials in prompts or tool output. The optional `configured-values` mode replaces configured credential values on a best-effort basis.
- Opens only http and https links, through Paseo.

## Limits

Structured output schemas, archive and unarchive, revert of files, and exact MCP tool pre-approval are not supported, and requests for them fail visibly. Changing the approval mode of a running session needs a new session.
