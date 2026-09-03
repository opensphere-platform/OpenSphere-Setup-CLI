# OpenSphere Setup CLI 0.5.0-edge.25 — Beszel native empty-output fix

This edge prerelease fixes a deterministic PowerShell error after Beszel had successfully deployed. On a fresh install, Console API does not exist yet. The successful `kubectl --ignore-not-found` lookup emits no stdout, and the production helper returns null. Version edge.24 called Trim on that null value and stopped installation.

The consumer check is now null-safe. Tests execute the production lookup helper and a native child process with no output, instead of mocking the helper as an empty string. The strengthened test rejects the published edge.24 code and passes with this fix. Existing API refresh, nonzero lookup failure and wrong-identity rejection remain covered. Readiness, credentials, RBAC and network policy are unchanged.

Governed Console source: `4a35cf46d5bcf31118cae25ab4ce2846a719b0db`, Console version `202609031708`. The prerequisite order corrected in edge.24 is retained.

[Publication, reset and validation record](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/blob/main/docs/CONSOLE-INSTALL-NULL-OUTPUT-EDGE25.md). Unit/contract checks and read-only verification do not establish a completed Kubernetes clean bootstrap. Five platform package builds and their smoke checks are required before this release is published. Candidate/stable remain on HOLD.

For the prepared local Kubernetes cluster, download the [Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.25/opensphere-setup.exe), then run:

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.25 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

Approve the new one-time code displayed by the command at GitHub. The public Client ID is built in; no PAT or client secret is bundled. Tokens are not cached alongside the portable runtime. Console handles supported operational credential handoff. Separate commands can require a new authorization.

Windows remains portable: no host Setup installation, PATH change, or service registration. The first execution of a version downloads about 166 MiB of verified runtime once; subsequent executions verify and reuse it. The release includes five platform archives, the Windows launcher and SHA256SUMS. Windows edge executables are not Authenticode signed; macOS ad-hoc signatures are not notarization.
