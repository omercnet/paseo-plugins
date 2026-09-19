# tell-agent

Send a message from one Paseo agent to another agent or workspace on the same daemon host.

## Screenshots

Agent and workspace names are synthetic. Both PNGs were captured from an isolated Paseo test
daemon at 2× pixel density after browser DevTools verified that no private organization names
remained in the rendered page.

### Choose a target

![Tell Agent target picker](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/tell-agent/docs/images/tell-agent-picker.png)

### Compose an instruction

![Tell Agent instruction composer](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/tell-agent/docs/images/tell-agent-compose.png)

## Install

### Paseo 0.9.0-beta.1 or later

Install the npm package:

```bash
paseo plugin install npm:@omercnet/paseo-tell-agent
```

Update an npm installation by its plugin ID:

```bash
paseo plugin update tell-agent
```

Paseo 0.9's reviewed update flow shows the current and proposed revisions before asking for approval. Add `--check` to preview without applying or `--yes` to skip the approval prompt. npm installation and this reviewed update behavior are not available in Paseo 0.8.

### Paseo 0.8.x

The manifest remains compatible with Paseo 0.8. Install from the Git repository:

```bash
paseo plugin add omercnet/paseo-plugins:tell-agent
```

Or install a local checkout on the daemon host:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/tell-agent
```

Use `paseo plugin update tell-agent` to refresh a Git installation. After changing a local checkout, use `paseo plugin reload tell-agent`.

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
