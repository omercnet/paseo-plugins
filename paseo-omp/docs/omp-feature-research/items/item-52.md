# Item 52: Local models, download and roles

## What it is
OMP can run small AI models on the user's own machine instead of calling a paid online model. They do cheap side jobs: naming sessions (`tiny` role), memory extraction (`memory`), judgments (`judge`), and speech (`speech`, `dictation`). Models are 90 MB to about 1.5 GB and are never downloaded automatically. `omp tiny-models list|download <id>|all` fetches title and memory models. `omp setup speech` picks and downloads speech models. A role is assigned with `modelRoles.<role>: local/<model-id>`.

Who: privacy or cost minded users, offline users, Apple silicon users. One-time setup, rare.

## What users get today
- The plugin Configuration tab is a typed editor over OMP settings. Its code already handles `providers.tinyModel*`-style provider keys and `tts.*`/`speech.*` keys. Whether the routing editor accepts `local/<id>` role values is unverified.
- Nothing lists local models, shows download state, or downloads. Paseo has no concept of this.
- Without a prior download, a local role downloads lazily on first use, which can delay the first title or memory write. That is the only real gap, and it is mild.

## Works with the built-in provider?
Yes. It is all CLI and config on the daemon host. Verified read-only: `omp tiny-models list --json` returns models (repo, dtype, size notes) and `omp setup speech --check --json` returns ready or not per model. No live session RPC needed. Settings apply to new sessions.

Unverified: whether `download` reports machine-readable progress (I did not run it, large files). `list --json` seems not to include per-model downloaded state.

## Value: low
- Rare, setup-time, two terminal commands.
- The speech half serves OMP terminal voice; item 59 (voice) was skipped, so Paseo has no consumer.
- A download manager means long child processes, progress UI, disk use and failure handling on the host. High cost for little use.
- Role assignment is already possible through settings.

## Best surface if built
A "Local models" card in the existing Configuration tab: model list with size, a Download button that runs the CLI, and assign to `tiny` or `memory`. Size M. No pill, no new tab.

## Risks and costs
- 150 MB to 1.5 GB downloads on the host, possibly metered, no confirmed progress channel.
- MLX models need a Python venv bootstrap; failures are hard to explain in a card.
- Catalog drifts between OMP versions; some entries are MLX only.
- A local `tiny` role disables online title fallback, so a bad pick leaves sessions untitled.

## Recommendation
Skip. If users ask later, a one-line Help hint pointing at `omp tiny-models` is enough.

Related: items 59 (voice) and 40 (tool switches, `tts`) overlap on speech settings.

## Paseo check (2026-11-05)
- Paseo already has its own local speech models for Voice and Dictation: ONNX STT/TTS, auto-download at daemon start into `$PASEO_HOME/models/local-speech`, listed in Settings > Voice (`public-docs/voice.md`, `public-docs/configuration.md`). Separate from OMP's tiny/memory/speech models; no shared state.
- Not in Paseo: anything about OMP `tiny-models`, role assignment or `omp setup speech`. Search of `providers/omp/` finds nothing.
- Registry: nothing found for OMP local models.
- Effect on the decision: recommendation unchanged (A, skip). A Paseo user may confuse the two speech setups; if a Help line is added, say it is OMP-only.
- Unverified: none material.
