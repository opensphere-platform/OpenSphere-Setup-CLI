# OpenSphere Setup CLI 0.5.0-edge.34

Fresh bootstrap asks the administrator for the Console HTTPS URL and an available
StorageClass in the terminal, and confirms them before authentication or cluster
writes. A non-secret input receipt records the selection. Existing installation
settings remain fixed on resume; automation must provide explicit inputs and consent.

All portable archives now include the external Node executable used by the Console
PowerShell installers. Linux PowerShell supports minimal hosts without ICU.

Full uninstall now accounts for Beszel node data and Console-owned RBAC in shared
namespaces. Host cleanup requires the recorded DaemonSet/node identities or an
existing checkpoint, stops agents first, and removes only children of the exact
Beszel state directory. Unavailable nodes or missing ownership evidence stop the
purge. Shared namespaces remain; only the verified Console Role/RoleBinding pairs
are removed. These destructive operations run only on an explicit uninstall.

The governed Console provider source is
`1866248e79ebe78f7f3e33ce00dc959a305a4382`, with 75 fresh migration steps and current
R2D2/Foundation installer contracts. The installed Console image version is chosen
separately through a verified release lock; the Setup version is not an image version.

Public Setup assets require no download credential. Private Console source artifacts
require Contents read access separately from GHCR read:packages authentication.
The Actions build uses the dedicated CONSOLE_SOURCE_READ_TOKEN only in source
checkout/verification; it is never packaged in the release.

Validation includes Setup contract tests, current Console provider conformance,
portable version/help smoke checks, and scoped Beszel cleanup in disposable storage.
No RKE2 or localhost Console installation is performed by this preparation. Full
Kubernetes installation acceptance remains the administrator's next step.

Windows remains portable: no automatic PATH, service, or application installation.
Candidate/stable remain on HOLD. Edge is a prerelease; Windows Authenticode and
macOS Developer ID notarization are not claimed.
