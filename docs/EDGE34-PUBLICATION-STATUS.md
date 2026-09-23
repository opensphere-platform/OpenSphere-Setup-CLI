# Setup edge.34 publication status

Published on 2026-09-23: `setup-v0.5.0-edge.34`, immutable GitHub prerelease.
Canonical Setup source: `5fd63f005204cc2956c1927d8d706d5a3f3db8e9`.
[Five-platform build and asset verification](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/35861336944) passed.
Windows amd64, Linux amd64/arm64, and macOS amd64/arm64 archives each passed packaged
runtime smoke checks. GitHub asset digests and SHA256SUMS match all published files.

The public `channels/edge` pointer selects this verified release. Candidate and
stable remain HOLD. This pointer promotion follows successful publication as a
separate source change; the workflow does not push channel updates to main.

Private Console source checkout and subsequent Git fetch use the dedicated
`CONSOLE_SOURCE_READ_TOKEN` in isolated steps without credential persistence.
No source credential is packaged. Administrators authenticate to private Console
source and GHCR independently when installing.

Validation: 431 Setup tests and 27 current-provider contract tests pass. Approved
Beszel host-state cleanup was tested only in disposable storage. No target Console
installation or uninstall is claimed by this publication.

Linux amd64 archive SHA-256:
`cdaaaa1cbca84de9a4cba676182a3a1faf57120a0bb88a6e9ba83ef7b024d695`.
Windows portable launcher SHA-256:
`4d2a2b11fc67d961bbf9525b2369b7d1b7b0b5ab580e2a5d73df1d370e94cbbb`.
