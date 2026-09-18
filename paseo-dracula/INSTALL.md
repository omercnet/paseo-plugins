### Paseo

#### Install from npm

Paseo plugins are trusted code. Review the source before installing a plugin on the daemon host.
This theme is data-only and does not access the filesystem, processes, credentials, or network.

```bash
paseo plugin install npm:@omercnet/paseo-dracula
```

To install the latest version from the public monorepo instead:

```bash
paseo plugin add omercnet/paseo-plugins:paseo-dracula
```

#### Activate a theme

1. Open **Settings → Appearance**.
2. Set **Theme** to **Dracula** for the dark variant or **Alucard** for the light variant.
3. Syntax highlighting is configured separately. For Dracula, optionally set **Highlight theme**
   to **Dracula**. For Alucard, select one of Paseo's light-capable highlight themes.

#### Update

```bash
paseo plugin update paseo-dracula
```

#### Remove

```bash
paseo plugin remove paseo-dracula
```

#### Install from a local checkout

```bash
git clone https://github.com/omercnet/paseo-plugins.git
cd paseo-plugins/paseo-dracula
npm ci
paseo plugin install "$PWD"
```
