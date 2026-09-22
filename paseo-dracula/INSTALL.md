### Paseo

Paseo plugins are trusted code. Review the source before installing a plugin on the daemon host.

This theme is data-only and does not access the filesystem, processes, credentials, or network.

#### Install from npm (Paseo 0.9.0 or later)

Install the published package directly:

```bash
paseo plugin install npm:@omercnet/paseo-dracula
```

#### Activate a theme

1. Open **Settings → Appearance**.
2. Set **Theme** to **Dracula** for the dark variant or **Alucard** for the light variant.
3. Syntax highlighting is configured separately. For Dracula, optionally set **Highlight theme**
   to **Dracula**. For Alucard, select one of Paseo's light-capable highlight themes.

#### Update (Paseo 0.9.0 or later)

```bash
paseo plugin update paseo-dracula
```

The command checks the npm source used for the installation and asks before applying the
new revision.

#### Remove

```bash
paseo plugin remove paseo-dracula
```
