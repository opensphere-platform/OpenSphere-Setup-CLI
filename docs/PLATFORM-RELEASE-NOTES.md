# OpenSphere Setup CLI public platform release

Public, self-contained administrator packages:

- Windows amd64
- Linux amd64 and arm64
- macOS Intel and Apple Silicon

Each archive contains the OpenSphere Setup executable or bundled Node runtime,
PowerShell, kubectl, runtime assets and third-party notices. Linux archives also
contain libatomic. Setup source and Setup release downloads require no GitHub
account or token.

Every archive is extracted on its native build runner and smoke-tested by running
OpenSphere Setup, bundled PowerShell and bundled kubectl. GitHub Immutable Releases
and per-asset SHA-256 digests bind the public tag and bytes. `SHA256SUMS` provides an
additional cross-check before extraction.

The Windows `Install-OpenSphereSetup.ps1` asset queries the public GitHub API,
requires the exact published immutable release, verifies GitHub asset digests and
`SHA256SUMS`, installs under the current user's LocalAppData and registers the
`opensphere-setup` command. GitHub CLI is not required for public edge installation.

Setup distribution and Console artifact authorization are independent. A private
Console GHCR package still requires a read-only package credential supplied to
`doctor`, `resolve`, `bootstrap` or `upgrade` through stdin. Candidate and stable
OCI attestation verification continues to require GitHub CLI.

The edge macOS signature is ad hoc and does not replace Apple Developer ID
notarization required for a stable enterprise release.
