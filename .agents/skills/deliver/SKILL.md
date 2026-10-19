---
name: deliver
description: Take a GitHub issue or bug report in omercnet/paseo-plugins from triage to a merged PR. Reproduces on an isolated Paseo daemon, consults Astra on the design, implements the minimal fix, validates live, opens the PR with screenshots, gets an Astra review, and merges. Use when asked to investigate, fix, or ship a change in any plugin in this repo.
---

# deliver

Issue to merged PR for `omercnet/paseo-plugins`. Local to this repo: it encodes this repo's CI, release, and daemon-isolation rules. The generic skills it leans on are `paseo-advisor` (Astra consult), `review-pr` (post-PR loop), and `ponytail` (keep the diff small).

## Hard rules

- The default Paseo daemon and `~/.paseo` are production state. Never run daemon or plugin lifecycle commands against them. Every runtime check uses `scripts/dev-daemon.sh`, which has its own home and an explicit `--host`.
- `paseo-omp` is different: read `paseo-omp/AGENTS.md` and follow its `.paseo-dev` workflow. The helper script refuses it.
- Read the touched plugin's `AGENTS.md` before running commands (only `paseo-omp` has one today).
- Never edit versions, `CHANGELOG.md`, `.release-please-manifest.json`, or `release-please-config.json`. release-please owns them and opens the `chore: release main` PRs.
- Commit messages and PR titles use Conventional Commits with the plugin directory as scope: `fix(context-mode): ...`. `fix` and `feat` trigger a release; `test`, `docs`, `chore` do not.
- Never use `--admin` or otherwise bypass branch protection. If a merge is blocked, report the blocker and stop.
- No em dashes in code, commits, PR text, or comments.
- The repo is public. No customer details, secrets, tokens, hostnames, or private paths in PRs, tests, or screenshots.
- Rebase on `origin/main` (fetch first) before opening the PR. Work on a branch, never on `main`.
- Use `ponytail`: smallest change that fixes the root cause. No scope creep, no shims, no unrelated refactors.

## Phases

### 1. Triage

1. Read the issue: `issue://omercnet/paseo-plugins/<N>`. Pin the plugin, Paseo version, and the claimed root cause.
2. `git fetch origin && git switch -c fix/issue-<N> origin/main`.
3. `bun install` at the repo root. It may dirty `bun.lock`; run `git checkout bun.lock` before committing unless you changed dependencies on purpose (CI uses `--frozen-lockfile`).
4. Locate the code, and call `lsp references` on any exported symbol before changing it.
5. Check the SDK types, not memory: `node_modules/.bun/@getpaseo+plugin@*/node_modules/@getpaseo/plugin/dist/` and `@getpaseo+protocol@*`. The daemon source in `node_modules/.bun/@getpaseo+server@*/node_modules/@getpaseo/server/dist/server/server/` is the ground truth for hook order (`plugins/lifecycle/`), env handling, and config shape.

### 2. Reproduce (required before any fix)

Write the smallest scenario that fails, on the dev daemon:

```sh
S=.agents/skills/deliver/scripts/dev-daemon.sh
$S up <plugin> [extra-config.json]    # prints DEV_HOST, DEV_HOME, WORK_DIR
$S cli <plugin> run --no-wait --provider <id> --cwd "$WORK_DIR" --title repro "say hi"
$S agents <plugin>                    # recorded agent configs, e.g. config.mcpServers
```

- `extra-config.json` is merged into the dev home config. Custom providers need `label`, `command`, and `extends` or the daemon refuses to start. Example: `{"agents":{"providers":{"claude-work":{"extends":"claude","label":"Claude Work","command":["claude"],"env":{"CLAUDE_CONFIG_DIR":"/tmp/x"}}}}}`.
- The script strips `PASEO_*`, `CONTEXT_MODE_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and similar, and sets a fake `HOME`. Without that, the host's native registrations and env leak in and the first repro is wrong. Do not bypass it.
- Agent creation does not need provider credentials. The record is persisted at `DEV_HOME/agents/*/<id>.json` even if the model call later fails.
- Record the failing output. If you cannot reproduce, say so and stop; do not fix a guess.
- Use the `browser` tool (xd://browser, puppeteer) for UI checks at `http://$DEV_HOST/`. The `browser_*` Paseo tools need a connected browser host and usually have none.

### 3. Consult Astra on the design

Use `list_profiles`, take profile `astra` (provider `omp-plugin`, high thinking), and create a read-only advisor with `create_agent`:

- `provider`: `omp-plugin/<model id from the profile>` (the provider/model form is required; a bare `omp-plugin` is rejected).
- `settings`: `{"modeId":"full","thinkingOptionId":"high"}`. Omit `workspaceId` to inherit yours.
- Prompt: repo path, plugin dir, issue link, your repro result, the exact files and symbols, your proposed design, and specific questions. State "READ-ONLY: do not edit, push, or run daemon lifecycle commands".

Do not poll or sleep. Results auto-deliver as a notification. The final message may contain only the last delta; read the full reasoning with `get_agent_activity` when the summary looks partial. Take the advice that is verified against source, push back on the rest, and note what changed.

### 4. Implement and verify locally

From the plugin directory:

```sh
npm run check        # biome, plus shrinkwrap check where defined
npm run typecheck
npm test             # or test:unit / test:coverage, whichever the plugin defines
npm run verify:package   # only if the plugin defines it
```

- Run `npm run check:write` to apply biome fixes. Never hand-format.
- Changing a dependency in a plugin that ships `npm-shrinkwrap.json` needs `node ../scripts/shrinkwrap.mjs <plugin-dir>`; `npm run check` fails on drift.
- New tests defend an observable contract. Stub ambient env with `vi.stubEnv(name, undefined)` in `beforeEach` and `vi.unstubAllEnvs()` in `afterEach` (see `context-mode/tests/integration.test.ts`); ambient `CONTEXT_MODE_DIR` and similar vars have broken tests before.
- Prove new tests are discriminating: `git stash` the source change (keep the tests), run them, and confirm they fail, then restore.
- Re-run the repro with `$S reload <plugin>` and a fresh agent. Compare against the failing output from phase 2. For UI changes, take before and after screenshots at `viewport {width:1400,height:1000,scale:2}` of the same state (stash, reload, capture; unstash, reload, capture).

### 5. PR

```sh
git fetch origin && git rebase origin/main
git add -A && git commit -m "fix(<plugin>): <summary>"
git push -u origin HEAD
gh pr create -R omercnet/paseo-plugins --base main --head <branch> \
  --title "fix(<plugin>): <summary>" --body-file <file>
```

PR body: `Fixes #<N>`, problem, change, out of scope, verification (before and after table), and the checks that passed. CI affected-plugin detection keys on the first path segment, so a change under `<plugin>/` runs that plugin's job and changes under `.agents/` run none.

Screenshots: GitHub has no CLI image upload. Push an orphan branch `pr-assets-<N>` containing only the images (use a throwaway `git worktree`, `git checkout --orphan`), and embed `https://raw.githubusercontent.com/omercnet/paseo-plugins/pr-assets-<N>/<name>.jpg`. Keep the branch; deleting it breaks the images in the merged PR.

### 6. Review gate

1. Ask Astra to review the PR with a read-only `create_agent` (same recipe as phase 3). Point it at `git diff origin/main...HEAD` and the checked-out branch, tell it which earlier advice to verify against, and require `APPROVE` or `CHANGES REQUESTED` with blocking and non-blocking lists.
2. Fix every blocking item. Apply non-blocking items that are cheap and correct.
3. Any commit after the approved revision gets another Astra pass. If you skip it for a trivial change, say so in the PR. Do not claim a review that did not happen.
4. Run the `review-pr` skill for human or bot review threads.

### 7. Merge

```sh
gh pr checks <N> -R omercnet/paseo-plugins     # wait for the plugin job and "CI sentinel" to pass
gh pr merge <N> -R omercnet/paseo-plugins --squash --delete-branch
```

`skipping` jobs are plugin-specific jobs that did not apply and are fine. `paseo-omp` is CODEOWNERS-protected; if review is required and missing, report it and stop.

### 8. Cleanup

- `$S down <plugin>` (removes the daemon and its state). Confirm with `ps` that no dev daemon is left running.
- Remove temp files you created. Keep `pr-assets-<N>`.
- Final report: what was wrong, what changed, how it was verified (commands and results), what Astra changed or approved, and what is explicitly out of scope.

## Gotchas collected from real runs

- Shell env from an agent session leaks `PASEO_WORKSPACE_ID`, so `paseo run` reports "Workspace not found" on the dev daemon. Always go through `$S cli`.
- A host with a native Context Mode registration makes `claude` agents skip injection. That is expected and also why the helper uses a fake `HOME`.
- Paseo applies a provider's own `env` and `extends` after the `agent.create` hook. Hooks only see the request env; read `agents.providers` through `paseo.config.get()` (the hook's second argument) when a provider's env matters. `session_open` on resume carries an empty `env`.
- `hub wait` does not track `create_agent` agents. Rely on the completion notification.
- `bun install` modifies `bun.lock`. Revert it unless dependencies changed.
- Do not trust a green local test run as proof of a fix. The live repro on the dev daemon is the proof; tests defend it afterwards.
