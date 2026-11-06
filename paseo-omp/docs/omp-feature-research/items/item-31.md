# Item 31: Custom providers (`models.yml`) and `omp models refresh`

## What it is
`models.yml` in OMP's agent directory teaches OMP about models outside its hosted providers: a local server (Ollama, LM Studio, llama.cpp, vLLM) or a company gateway (LiteLLM, any OpenAI or Anthropic compatible proxy). `omp models refresh` re-fetches model lists, ignoring OMP's 2 hour cache. The item proposes an add-provider wizard plus a refresh action. Users: people on local models or a gateway, once per machine, then whenever they pull a model. OMP has no add-provider command; the file is hand-edited.

## What users get today
- Ollama, llama.cpp and LM Studio on default ports need no file. Env vars (`OLLAMA_BASE_URL` etc.) cover other hosts.
- Paseo's built-in provider fills its picker from OMP's `get_available_models`, so `models.yml` models already appear as `provider/model`. Verified with a stub provider.
- Paseo's provider sheet has Refresh models. The plugin's routing editor lists the same models. Nothing creates or checks `models.yml`.

## Works with the built-in provider?
Yes. File and CLI work on the daemon host, no live-session RPC.

## Gaps found (omp 18.13.1, stub servers, isolated dir)
1. **Typos are silent.** With an invalid file (custom models, no `api`), RPC returned success with only the other providers' models and nothing on stderr. `omp models` warns and exits 0.
2. **Refresh goes stale.** After adding a model to the stub, a fresh OMP process (what Paseo's Refresh starts) still served the old list for Ollama, LM Studio and generic discovery until `omp models refresh` ran. llama.cpp re-probed live. OMP has no RPC refresh command.

## Value
Wizard: low. One-time setup, large schema (13 `api` values, 7 discovery types), and a typed key lands in plaintext unless steered to an env var. The two gaps: low to medium. Both are "why is my model missing" moments, cheap to fix.

## Best surface and size
No wizard, no pill.
- S: a `models.yml` line in the OMP screen Diagnostics tab (run `omp models --json`, show the warning).
- S: a "Refresh models" button by the routing editor's model picker, plus a Command Center item, running `omp models refresh` on the daemon host.
- Wizard, if wanted: M for four common cases, reusing the comment-preserving YAML edit the plugin already has; L for the full schema.

## Risks and costs
- The check depends on OMP's warning wording.
- Bare `omp models refresh` may hit every hosted catalog; `refresh ollama` also refreshed LM Studio in my run.
- `models.yml` is global per agent directory; the store selector must apply.
- Wizard: secrets through the UI, schema drift.

## Recommendation
Expose the small pair (Diagnostics check, Refresh models). Skip the wizard. Upstream asks: OMP to return the `models.yml` error over RPC (`config_warnings_changed` has no documented payload); Paseo's Refresh to force an OMP refresh.

Unverified: end to end in a Paseo daemon (stderr discard read from Paseo's code); whether a plugin can trigger Paseo's provider refresh; whether running agents pick up edits without a reload.

## Paseo check (2026-11-05)
- Paseo already has: provider catalog fetch by starting a throwaway OMP RPC session and calling `get_available_models` (`providers/omp/agent.ts` `fetchCatalog`, ~line 2493), so a new OMP process per refresh, which is why OMP's 2 hour cache stays stale. Nothing handles OMP warnings or `models.yml`.
- Registry: `hulkzzhou1/model-providers` (79 installs, Paseo 0.12+) adds endpoint, key and model rows for OMP, including OpenRouter and DeepSeek presets and `Load models` from `/v1/models`. It registers models through its own local OMP extension, not `models.yml`, and stores keys in plaintext under PASEO_HOME. That covers the wizard (option B) use case for hosted compatible endpoints, but not Ollama/LM Studio discovery, `models.yml` health or `omp models refresh`.
- Not in Paseo: models.yml error surfacing; OMP-side refresh.
- Effect on the decision: recommendation unchanged (A, small fixes). B is further weakened by the registry plugin. A is still the only option that closes the silent-typo and stale-list gaps.
- Unverified: model-providers not run; whether it coexists with `models.yml` entries.
