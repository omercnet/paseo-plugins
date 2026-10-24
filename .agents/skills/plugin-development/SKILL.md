---
name: plugin-development
description: Required reading before writing or changing any plugin in omercnet/paseo-plugins. Points at the upstream Paseo plugin, coding-standards and design docs agents must fetch first, and lists the packaging and bundler-boundary mistakes that have broken installs here. Use for any new plugin, any edit under a plugin's client/, server/ or shared/ directory, and any dependency or package.json change.
---

# plugin-development

Rules for writing plugins in this repo. Read this before touching plugin code, then fetch the upstream docs below. Shipping and release rules live in `deliver`; this skill covers what to write.

## Always fetch these first

Do not rely on memory or on this file for the contracts. Fetch all three every time you start plugin work, and read them fully. They change between Paseo releases.

- Plugins: https://github.com/getpaseo/paseo/blob/main/docs/plugins.md
- Coding standards: https://github.com/getpaseo/paseo/blob/main/docs/coding-standards.md
- Design: https://github.com/getpaseo/paseo/blob/main/docs/design.md

Fetch raw Markdown with `read` on the `https://raw.githubusercontent.com/getpaseo/paseo/main/docs/<name>.md` form of each URL. `main` can be ahead of the Paseo version this repo supports (see each plugin's `requirements.paseo` and the root `package.json` catalog). Where an API is marked unreleased, check the installed SDK under `node_modules/.bun/@getpaseo+plugin@*/` before using it.

Also read the public docs `https://paseo.sh/docs/plugins.md`, `/docs/plugins/publishing.md` and `/docs/plugins/reference.md`, and the `paseo-plugin` skill.

## Shipped code resolves outside the monorepo

A plugin is installed from npm, Git or the registry into a directory with no workspace around it. Everything under `client/`, `server/`, `shared/` and the entry files must work there. Inside this repo, bun hoisting hides missing packages, so typecheck and tests passing proves nothing about an install.

The daemon bundles each runtime with an esbuild boundary plugin (`@getpaseo/server`, `dist/server/server/plugins/compiler.js`). It checks imports, including `import type`:

| Import | Result in shipped code |
| --- | --- |
| `@getpaseo/plugin`, `/client`, `/client/ui`, `/server` | Allowed. Host provides them. |
| `react`, `react-native`, `react/jsx-runtime`, `@tanstack/react-query`, `zod`, Node builtins (server only) | Allowed. Host provides them. |
| `import type ... from "@getpaseo/protocol/..."` | Allowed. Type-only protocol imports are skipped. |
| `@getpaseo/client`, `@getpaseo/cli`, `@getpaseo/server`, any non-host package, type-only or not | Resolved from disk. Fails the install when the package is only a devDependency: `Could not resolve type dependency "<pkg>" imported by <file>`. |
| Value (non-type) import from `@getpaseo/protocol/...` | Resolved from disk like any dependency. Do not do this in client code. |

Consequences:

- Never import from `@getpaseo/client` in shipped code, not even `import type`. Get types from `@getpaseo/protocol/<module>` when the type lives there (for example `HostSummary` from `@getpaseo/protocol/hosts`).
- For the SDK client type, derive it instead of importing it: `ReturnType<typeof usePaseo>` in client code, `PluginClientContext["paseo"]`, or a small structural interface covering only the methods you call (see `connected-hosts/client/hosts.ts`). Existing examples: `agent-crew/client/crew.ts`, `context-mode/client/screen-scope.ts`.
- Tests may import `@getpaseo/client` types because `tests/` is not shipped.
- A runtime dependency a plugin really needs goes in `dependencies`, with `npm-shrinkwrap.json` where the plugin ships one. Host libraries and type-only packages stay in `devDependencies`.
- Keep every imported file inside `files` in `package.json`. A module at the plugin root other than the entries and `paseo-plugin.json` is a compile error; use `client/`, `server/` or `shared/`.
- `client/` must not import `server/` or Node modules, `server/` must not import `client/`, React or React Native. Shared code imports only shared code.

## Verify a plugin the way users install it

Before opening a PR that touches shipped code or `package.json`, install the packed package from outside the checkout. The workspace install the dev daemon helper does is not enough.

```sh
T=$(mktemp -d)
(cd <plugin> && npm pack --ignore-scripts --pack-destination "$T")
mkdir "$T/x" && tar -xzf "$T"/*.tgz -C "$T/x"
S=.agents/skills/deliver/scripts/dev-daemon.sh
$S up <plugin>
$S cli <plugin> plugin remove <id>
$S cli <plugin> plugin install "$T/x/package" --json   # must report status "running"
$S cli <plugin> plugin ls
$S down <plugin>
```

- `npm:` sources only take registry specs (`npm:pkg@version`), not tarball paths, so install the extracted directory.
- The extraction directory must have no `node_modules` in any parent, or you recreate the hoisting problem.
- Run `up`, installs and `down` from the same shell session type. Daemons started inside a sandboxed runner can be killed when the call ends.
- Failure shows as plugin status `failed` and a `Build failed` error naming the boundary plugin. Success is `running` with no error.
- Use the browser tool against `http://$DEV_HOST/` to confirm the plugin's screen renders without console errors. Daemon and `~/.paseo` safety rules in the root `AGENTS.md` apply.

## Checklist

1. Fetched and read the three upstream docs for this session.
2. No shipped import of `@getpaseo/client` or any other non-host, non-protocol-type package that is not in `dependencies`.
3. `npm run check`, `npm run typecheck`, `npm test` pass in the plugin.
4. Packed install outside the monorepo reports `running`.
5. `requirements.paseo` still matches the APIs used.
