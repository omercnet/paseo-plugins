---
name: paseo-upgrade
description: Move every plugin in omercnet/paseo-plugins to a new Paseo release. Finds the supported version, reviews every upstream commit against each plugin, ships one broad PR that adds support (SDK pin, manifest ranges, docs), then one PR per plugin that adopts new features and removes deprecated code. Use when Paseo publishes a new stable or beta version, or when asked to "support Paseo X".
---

# paseo-upgrade

New Paseo release to merged support PRs, for all plugins. This repo has done it for 0.11 and 0.12 (#342 for 0.12.0-beta.2, then #343-#353 per plugin, #357 for 0.12.0) and again for 0.13. The generic skills it leans on: `deliver` (this repo's CI, release, and daemon-isolation rules), `ponytail` (small diffs), `review-pr` (post-PR loop).

## Hard rules

- Everything in `deliver` applies: isolated daemon only (`.agents/skills/deliver/scripts/dev-daemon.sh`), `paseo-omp` follows its own `AGENTS.md`, never edit versions or `CHANGELOG.md` or release-please files, Conventional Commits scoped by plugin dir, no em dashes, public repo, never `--admin`.
- Never merge a floor-raising PR on the user's behalf. Open it, verify it, report it.
- Review upstream by tag, never by the clone's `HEAD`. The clone is `--no-checkout`.

## Phases

### 1. Survey (facts, not memory)

```sh
.agents/skills/paseo-upgrade/scripts/survey.sh [target]
```

It prints the SDK pin and every manifest range, npm `latest` and `beta`, the commit list, the plugin and protocol diff stat, `COMPAT(...)` markers added in the range, and where plugins touch deprecated surface. Default target is the newest of the two npm dist-tags. A beta can be ahead of `latest`; that is the usual state when this runs, and it is the target (precedent: #342).

If `gh` times out against the GraphQL API, `git ls-remote`/`git fetch` over HTTPS and `npm view` still work. Do not block on it.

Then read the actual API diff yourself: `git -C /tmp/paseo-src diff <from> <to> -- packages/plugin/src packages/protocol/src ':!*.test.ts'`. Note removals, new required props, deprecations (with removal dates), and behaviour changes in the daemon that plugins observe (lifecycle events, agent labels, workspace and worktree flow, notifications, CLI output). Check how `requirements.paseo` is evaluated (`packages/protocol/src/plugin-requirements.ts`): a prerelease passes when its stable core satisfies the range, so `^0.12.0 || ^0.13.0` accepts `0.13.0-beta.N` and `^0.12.0` alone refuses it.

### 2. Per-plugin impact review (parallel, read-only)

Write a brief to `local://paseo-<ver>-brief.md`: repo and clone paths, from and to tags, the known API changes from phase 1, and the job description below. Spawn one `scout` per plugin in a single `task` batch. Each must:

1. Read the plugin's `AGENTS.md` (if any), `README.md`, `OVERVIEW.md`, manifest, source, tests, and list exactly which SDK APIs and daemon behaviours it relies on.
2. Classify EVERY commit in `git -C /tmp/paseo-src log --no-merges <from>..<to>` as `breaks | deprecates | opportunity | none` with sha, reason, and file:line evidence on both sides. Shared reasons may group `none` commits.
3. Report deprecated usages with locations, features worth adopting, code to change, and a proposed PR scope. Mark unverified claims `[INFERENCE]`.

Scouts see concurrent edits in the working tree; tell them it is read-only and to cite tags.

Treat scout output as leads. The commit count the brief states can be wrong (`rev-list --count` is the truth). Verify any claim that decides a PR.

### 3. Broad PR: add support

Branch `chore/paseo-<ver>` from `origin/main`. One commit `chore(deps): update paseo sdk to <ver>`:

1. Root `package.json` catalog: pin `@getpaseo/{cli,client,plugin,protocol,server}` to the target together.
2. `bun install`, then `node ../scripts/shrinkwrap.mjs .` in every plugin that ships `npm-shrinkwrap.json` (`context-mode`, `paseo-omp`, `paseo-shared-browser`).
3. Widen every `requirements.paseo` to also accept the new line. Keep older alternatives. Update every doc that quotes the range (README, OVERVIEW, SUPPORT, docs, tests asserting it). Find them with `grep -rnE '\^0\.12\.0'` (sentence-final matches need a second pass: `^0.12.0.`).
4. Fix only what the bump breaks. Run `npm run typecheck` in every plugin first; in 0.13 the only break was panel props gaining required fields, which narrowed to `Pick<...>` in `paseo-gas-city`.
5. Update prose that says "pinned to the <old> SDK line". Leave the `paseo-omp` Docker canary alone; its PR decides (the image digest must be resolved, never invented).
6. Verify: `npm run check`, `npm run typecheck`, unit tests in all plugins (`npm run check:write` fixes formatting; never hand-format). Then on an isolated daemon: `dev-daemon.sh up <plugin>`, install the other plugins with `$S cli <plugin> plugin install "$PWD/<other>"`, and confirm `$S cli <plugin> plugin ls` shows every one `running` with no error. `paseo-omp` is excluded (its own workflow). `dev-daemon.sh down` afterwards and check `ps`.
7. Rebase on `origin/main`, push, open the PR against `main`.

The nightly `Paseo SDK compatibility` workflow (`.github/workflows/paseo-latest.yml`) covers `latest` and `beta` for `paseo-omp`; it should go green after this merges.

### 4. Policy decision: floors

Everything a new release adds can only run on that release. Dual-range plugins cannot use new APIs or leave deprecated imports (the replacement entry often lacks the export on the old line). Ask the user once, with the recommendation below:

- Raise the floor only where new features are adopted (recommended, chosen for 0.13). Those plugins go breaking (`feat(<plugin>)!:` with a `BREAKING CHANGE:` footer) and are stacked on the broad PR. The rest keep the wide range and get only docs, behaviour fixes, and tests.
- Raise every floor (hygiene-only gains, strands the old line).
- Keep dual ranges everywhere (no new features).

A deprecated API with a removal date a year out is not a reason by itself to raise a floor.

### 5. Per-plugin PRs

One worker per plugin (or per plugin pair for docs-only), spawned in one `task` batch, each in its own `git worktree` off the broad branch (`git worktree add /tmp/wt-<plugin> -b <branch> origin/chore/paseo-<ver>`, then `bun install`; `git checkout bun.lock` before committing). Base the PR on the broad branch: `gh pr create --base chore/paseo-<ver>`. GitHub retargets it to `main` when the broad PR merges and its branch is deleted.

Every worker gets: the floor policy, the common cleanup, the scout result URL (`agent://<id>`) as leads to verify, the `deliver` rules, and the acceptance (check, typecheck, tests, live dev-daemon load, UI driven with the `browser` tool for UI changes).

Common floor-raising cleanup (0.13 example; derive the list for the next release from the `COMPAT(...)` markers in the survey):

- `@getpaseo/plugin/client/react-native` imports move to `@getpaseo/plugin/client/ui`, including test `vi.mock`s.
- Drop `context: "workspace"` from `addWorkspacePanel`; agent panels use `addAgentPanel`; `props.agentId` becomes `props.params.agentId`.
- Manifest `requirements.paseo` becomes the new line only, and every doc and test that quotes it follows.

Feature work is per plugin and must earn its place: state that survives tab restore (`useTabState`), host `Markdown` for rich text, icons, i18n only when someone will translate. Plugins with nothing to adopt get no PR; say so in the report instead of opening a hygiene-only breaking change.

Docs-only PRs (`docs(<plugin>): ...`) are right for behaviour changes in the daemon that users can observe (for 0.13: compact header buttons shown, agent messages batched about 2s). Verify each claim against the upstream commit before writing it.

### 6. Report

For the user: target and supported versions; the commit-impact summary by plugin; the broad PR; each per-plugin PR with what it adopts and how it was verified; plugins that intentionally have no PR and why; what was not verified (canary image, real phones, mobile layouts); the merge order (broad PR first, then the stacked PRs; `paseo-omp` is CODEOWNERS-protected).

## Gotchas from real runs

- `npm view @getpaseo/plugin dist-tags`: `latest` can trail a beta by days. A beta pin is acceptable here; the floor-raising PRs should not merge before the line is stable unless the user decides otherwise.
- `/tmp/paseo-src` `HEAD` is not the tag. Use `git show <tag>:<path>` and `git diff <from> <to>`. Tag objects (`git rev-parse <tag>`) differ from commits (`<tag>^{commit}`); `npm view ... gitHead` matches the commit.
- Plugin ranges declared as `^0.12.0` do not accept `0.13.x`. Forgetting the manifest is the only thing that actually breaks a plugin on a new minor.
- A dual-range plugin cannot import from `client/ui` what only the new line exports (`Icon`, `Modal`, `useToast`, `ScrollView`, `TextInput`, `FlatList`, `copyText`, `StreamedText`, `Markdown`).
- Scouts running concurrently with your edits will cite your uncommitted changes as if they were `HEAD`. Commit early or say so in the brief.
- A line-anchored edit with stale tags can silently mangle a file. Re-read after every edit, or script multi-site changes and review `git diff`.
- `bun install` dirties `bun.lock`; revert it unless dependencies changed. CI uses `--frozen-lockfile`.
- Stage by path (`git add <dir>`), never `git add -A`, while workers run: a worker that edits through a relative path writes into your checkout and your next commit ships it. Tell workers to use absolute paths inside their own worktree.
- `/tmp` is tmpfs and each bun-installed worktree is about 2.3G. Put worker worktrees under `$HOME` (for example `~/wt/<plugin>`) and remove them when done.
- Before blaming the SDK for a red CI job, run the same job on an untouched `origin/main` (throwaway draft PR that edits one line in that plugin, close it after). In 0.13 the `paseo-shared-browser` ubuntu native-video smoke failed on `main` too, so it was not caused by the upgrade.
- Check `gh pr list` for another session already working the same upgrade (same author, `fix: support Paseo X`, extra worktrees under `~/.paseo/worktrees`). Duplicate broad PRs conflict on `package.json`, `bun.lock`, and every manifest; say which one is canonical.
