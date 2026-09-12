# Changelog

## Unreleased

### Features

* Add the production `omp` direct provider, OMP workspace tools, diagnostics, persistence migration, and nested-subagent support.
* Add Release Please packaging, Git installation, compatibility policy, and release rollback guidance.

### Security

* Split release metadata from least-privilege artifact publishing, gate publication on exact-commit CI, and attest release artifacts.
* Make release archives self-contained, restrict source inputs to tracked allowlisted files, and verify offline installation plus contained extraction.
* Disable dependency lifecycle scripts during Git installation and verify both plugin entries from a fresh checkout.
