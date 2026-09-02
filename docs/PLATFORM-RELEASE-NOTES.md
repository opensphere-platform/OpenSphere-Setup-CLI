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

Windows users can start with `Install-OpenSphereSetup.exe`. The executable is bound
to this exact release, validates the public metadata and PowerShell installer asset
digest, and invokes the same reviewable `Install-OpenSphereSetup.ps1` implementation.
That installer verifies the runtime archive against both its GitHub digest and
`SHA256SUMS`, installs under the current user's LocalAppData, and registers the
`opensphere-setup` command.

Linux and macOS users can start with `install-opensphere-setup.sh`. It selects the
native archive, verifies SHA-256, installs it under the current user's data directory,
and creates the command link without editing shell profile files. GitHub CLI is not required for public edge installation.

All three installers accept an exact Setup CLI `version` or a public distribution
`channel`. Exact versions map directly to immutable `setup-v<semver>` releases. A
channel resolves `channels/edge`, `channels/candidate`, or `channels/stable` once and
then installs the returned immutable release. Edge points to this release; candidate
and stable remain `HOLD` until their gates are satisfied. Setup package selection is
separate from the Console release selected later by `opensphere-setup bootstrap`.

Setup distribution and Console artifact authorization are independent. A private
Console GHCR package still requires a read-only package credential supplied to
`doctor`, `resolve`, `bootstrap` or `upgrade` through stdin. Candidate and stable
OCI attestation verification continues to require GitHub CLI.

The edge Windows bootstrap executable is not yet Authenticode signed. A trusted
code-signing certificate and verification gate are required before stable Windows
publication; Visual Studio alone does not establish publisher trust.
The edge macOS signature is ad hoc and does not replace Apple Developer ID
notarization required for a stable enterprise release.
