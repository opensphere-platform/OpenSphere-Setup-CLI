# OpenSphere Setup CLI private platform release

Self-contained private administrator packages:

- Windows amd64
- Linux amd64 and arm64
- macOS Intel and Apple Silicon

Each archive contains the OpenSphere Setup Node SEA, PowerShell runtime, kubectl,
runtime assets and third-party notices. The target host needs Git, authenticated
GitHub CLI (`gh`) and access to a Kubernetes cluster. Node.js, npm, PowerShell,
kubectl and libatomic are not host prerequisites.

The repository enforces GitHub Immutable Releases. Verify the release and downloaded
archive with `gh release verify` and `gh release verify-asset`, then confirm
`SHA256SUMS` before extraction. This edge release is not a substitute for Windows
Authenticode or Apple Developer ID notarization required by a stable enterprise
release.
