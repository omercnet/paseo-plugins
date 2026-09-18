# tell-agent

Send a message from one Paseo agent to another agent or workspace on the same daemon host.

## Install

Paseo 0.9.0-beta.1 or later can install the package from npm:

```bash
paseo plugin install npm:@omercnet/paseo-tell-agent
```

The plugin remains runtime-compatible with Paseo 0.8.x. npm-managed installation and updates require Paseo 0.9.0-beta.1 or later.

Update an existing installation by its plugin ID:

```bash
paseo plugin update tell-agent
```

## Use

Run the slash command from an agent composer:

```text
/tell <agent or workspace> :: <message>
```

For example:

```text
/tell Payments :: Review the authentication change.
```

The target can match an active agent's title or ID, or its project or workspace name. Ambiguous matches must be refined.

`tell-agent` only searches agents connected to the same Paseo daemon host. It does not discover or contact agents on other hosts.

The plugin asks the source agent to forward the message to the resolved target. The source agent remains responsible for executing that instruction; the plugin does not inject the text directly into the target session.

## Trust

Paseo plugins run as trusted, unsandboxed code. Installing this package trusts its code, dependencies, and future updates. Review the package and update preview before approving an installation or update.
