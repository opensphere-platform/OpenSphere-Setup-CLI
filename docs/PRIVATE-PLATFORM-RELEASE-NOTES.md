# OpenSphere Setup CLI private platform release

Self-contained private administrator packages:

- Windows amd64
- Linux amd64 and arm64
- macOS Intel and Apple Silicon

Each archive contains the OpenSphere Setup Node SEA, PowerShell runtime, kubectl,
runtime assets and third-party notices. The target host needs Git, authenticated
GitHub CLI (`gh`) and access to a Kubernetes cluster. Node.js, npm, PowerShell,
kubectl and libatomic are not host prerequisites.

Verify the downloaded archive with `SHA256SUMS` and GitHub artifact attestation
before extraction. This edge release is not a substitute for Windows Authenticode
or Apple Developer ID notarization required by a stable enterprise release.
