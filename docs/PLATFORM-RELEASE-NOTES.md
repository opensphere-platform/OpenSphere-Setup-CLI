# OpenSphere Setup CLI 0.5.0-edge.21 — GitHub OAuth Device Flow

This edge prerelease adds opt-in GitHub OAuth Device Flow authentication. The registered OpenSphere application Client ID is built in; no PAT or client secret is bundled.

**Known limitation:** live OAuth login, refresh, identity preservation and old-token rejection passed. The current `opensphere-console:edge` manifest returned HTTP 404 (`MANIFEST_UNKNOWN`) both before and after refresh. Private GHCR pull and end-to-end Console installation are not verified. The response does not distinguish a missing image from restricted access. This prerelease must not be described as a completed OAuth installation solution.

- Run with `--registry-auth oauth`, then approve the displayed one-time code at GitHub. The requested scopes are `read:packages offline_access`.
- `resolve` verifies the selected Console release and image access; `doctor` also checks Kubernetes installation prerequisites without changing the cluster. `status` remains a Kubernetes Pod query, not a GitHub login command.
- Tokens remain in memory until an explicitly supported bootstrap handoff. No OAuth token is written into the portable runtime cache. Separate commands may require a new authorization.
- Broad repo/write/admin credentials are rejected for runtime handoff. Dedicated read-only PAT input remains available through stdin.
- OAuth bootstrap requires a Console release that activates `registry-auth/v1`. Unsupported releases fail before namespace/credential writes. This Setup release does not deploy Console's credential refresh worker or retrofit an existing installation. OAuth upgrade requires the Console reauthorization path.
- Kubernetes API egress for compatible Console releases is discovered from the target cluster's Service/EndpointSlices, rather than hardcoded.
- Bootstrap validates administrator/TLS inputs before starting authentication. Concurrent recovery receipt cleanup retries transient Windows EPERM only after revalidating exact files; persistent denial and content drift still fail.
- Windows remains a portable launcher with verified, per-version runtime reuse. No host Setup installation, PATH change, or service registration. Five platform archives and SHA256SUMS are distributed as before.

```powershell
.\opensphere-setup.exe --channel edge resolve --release edge --registry-auth oauth
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --registry-auth oauth
```

Setup version/channel selectors precede the command. Console `--release` and `--lock` remain independent. Windows edge executables are not Authenticode signed, and macOS ad-hoc signatures are not notarization; candidate/stable remain HOLD.
