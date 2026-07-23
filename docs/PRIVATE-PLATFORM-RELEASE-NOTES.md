# OpenSphere Setup CLI private platform release

Self-contained private administrator packages:

- Windows amd64
- Linux amd64 and arm64
- macOS Intel and Apple Silicon

Each archive contains the OpenSphere Setup executable or bundled Node runtime,
PowerShell, kubectl, runtime assets and third-party notices. The target host needs Git, authenticated
GitHub CLI (`gh`) and access to a Kubernetes cluster. Node.js, npm, PowerShell,
kubectl and libatomic are not host prerequisites.

Every archive is extracted on its native build runner and smoke-tested by running
OpenSphere Setup, bundled PowerShell and bundled kubectl. The Apple Silicon SEA
and Intel bundled Node runtime receive an ad-hoc code signature and are verified
again after extraction.

Windows operators can download the version-bound `Install-OpenSphereSetup.ps1`
release asset. It authenticates through `gh`, verifies the immutable release,
asset attestation and SHA-256, installs the self-contained archive under the
current user's LocalAppData and registers the `opensphere-setup` command.

The repository enforces GitHub Immutable Releases. Verify the release and downloaded
archive with `gh release verify` and `gh release verify-asset`, then confirm
`SHA256SUMS` before extraction. This edge release is not a substitute for Windows
Authenticode or Apple Developer ID notarization required by a stable enterprise
release.
