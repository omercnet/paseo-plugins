# Security policy

## Supported versions

Security fixes are made on the default branch and included in the next `paseo-omp` release. After the first release, only the latest published `paseo-omp` version is supported. Compatibility remains bounded by the plugin manifest.

## Private reporting

Report suspected vulnerabilities through the [private GitHub Security Advisory form](https://github.com/omercnet/paseo-plugins/security/advisories/new). Do not open a public issue for a vulnerability.

Include the affected plugin and version or commit, impact, minimal reproduction, and any proposed mitigation. Remove credentials, private paths, repository names, prompts, and transcript contents. If evidence itself is sensitive, describe it first and wait for a private exchange path.

`paseo-omp` is trusted, unsandboxed code: its server entry and Git preparation commands run with the daemon user's filesystem, process, credential, and network access. A dependency or release-pipeline compromise is therefore in scope.

The maintainer will acknowledge and triage reports on a best-effort basis, coordinate fixes with OMP or Paseo maintainers when the defect crosses repositories, and request public disclosure only after a fix or documented mitigation is available.

## Release verification

Release ZIPs have GitHub build-provenance attestations signed through GitHub's OIDC and Sigstore integration. Verify provenance with `gh attestation verify <archive> --repo omercnet/paseo-plugins`. The adjacent SHA-256 file detects accidental corruption only and is not an independent authenticity proof.
