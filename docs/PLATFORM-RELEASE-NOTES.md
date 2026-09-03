# OpenSphere Setup CLI 0.5.0-edge.24 — clean-install dependency order

This edge prerelease corrects the Console installation order that caused the API to remain in `CreateContainerConfigError` for five minutes because the required Beszel reader Secret had not been created.

- Establish the existing Extension Controller CRDs and trusted-key configuration before starting the controller.
- Install Gitea, then Beszel and its reader credential, then Supabase, Console API and Extension Controller, followed by the remaining base workloads.
- During a fresh install, Beszel does not restart an API Deployment that has not been created yet. Existing API Deployments still refresh normally; lookup failures are not treated as absence.
- Check the mandatory monitoring reader input before database work and rollout waiting. Keep credential, RBAC, network, image-verification and readiness requirements unchanged.
- Retain the 12-stage installation progress display and use an ASCII progress separator for terminal compatibility.

Setup source: `21af3001e8eb08e321ca2cfd963a9b10132dfdfb`. Governed Console source: `787b82193125d6c592b16dd05ce09007a01d0998`, Console version `202609031642`.

Validation: 316 Setup tests, Console CI including PostgreSQL/API tests, and all five platform package builds passed. The public Windows EXE was downloaded, checksum-verified, and executed for read-only version/status checks; a second execution reused its verified runtime without another download. These checks do not establish a completed Kubernetes clean bootstrap. See the [installation and publication record](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/blob/main/docs/CONSOLE-INSTALL-ORDER-EDGE24.md).

For the prepared local Kubernetes cluster, download the [Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.24/opensphere-setup.exe), then run:

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.24 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

Approve the new one-time code displayed by this command at GitHub. The registered public Client ID is built in; no PAT or client secret is bundled. Private GHCR requires the approved read-only authorization. Tokens are not stored in the portable runtime cache. Bootstrap hands supported operational credentials to Console; separate commands can require another approval.

Windows remains a portable executable with per-version runtime reuse: no Setup host installation, PATH change, or service registration. The first use of this version downloads about 166 MiB of runtime once. The release includes five platform archives, the Windows launcher and SHA256SUMS. Windows edge executables are not Authenticode signed; macOS ad-hoc signatures are not notarization. Candidate/stable remain on HOLD.
