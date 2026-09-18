### Paseo

Paseo plugins are trusted code. Review the source before installing a plugin on the daemon host.

This theme is data-only and does not access the filesystem, processes, credentials, or network.

#### Install from npm (Paseo 0.9.0-beta.1 or later)

Install the published package directly:

```bash
paseo plugin install npm:@omercnet/paseo-dracula
```

#### Install from Git (Paseo 0.8.x or later)

Install from the public monorepo:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-dracula
```

#### Activate a theme

1. Open **Settings → Appearance**.
2. Set **Theme** to **Dracula** for the dark variant or **Alucard** for the light variant.
3. Syntax highlighting is configured separately. For Dracula, optionally set **Highlight theme**
   to **Dracula**. For Alucard, select one of Paseo's light-capable highlight themes.

#### Update (Paseo 0.9.0-beta.1 or later)

```bash
paseo plugin update paseo-dracula
```

The command checks the npm or Git source used for the installation and asks before applying the
new revision.

#### Remove

```bash
paseo plugin remove paseo-dracula
```

#### Install from a local checkout (Paseo 0.8.x or later)

```bash
git clone https://github.com/omercnet/paseo-plugins.git
cd paseo-plugins/paseo-dracula
npm ci
paseo plugin install "$PWD"
```
