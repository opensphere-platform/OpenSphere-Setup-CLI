# OpenSphere Setup CLI 0.5.0-edge.30 — Console native runtime bootstrap

This edge prerelease binds Setup to governed Console source
`1b2f63cd533fdad621f82294a82f3e81b7cb4d06` and the integrated Console edge anchor
published as immutable release `202609050056`.

Fresh bootstrap now installs the Console native core in one governed flow: OSAA Gateway, OSDST,
OS Shell API, OS Shell Gateway and OS Shell Reconciler. Setup provisions six dedicated
`NOINHERIT` database logins, workload-specific Kubernetes Secrets, four P-256 TLS leaf
certificates under one local CA, and the GHCR pull credential required by ephemeral shell
sessions. The canonical C_API retains its projected service-account identity and mounts only the
two declared TLS Secret volumes.

Migration `opensphere-console/20260905/0035` introduces the owner-only Setup activation
procedure. Native workloads are accepted only when the migration ledger, exact source revision,
release digest, component image digests and declared replica counts agree. Setup verification
also checks all native services, workloads, Secrets and registry scopes.

LLM credential custody from edge.29 remains intact. Operational Graph, Incident, Durable
Operation and Engineering Remediation remain Cluster Manager capabilities and stay explicitly
`OFF` until that component installs their schema and authority.

Download the [Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.30/opensphere-setup.exe), then run:

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.30 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

Approve the displayed GitHub device code. The public Client ID is built in; no PAT or client
secret is bundled. Windows remains portable with verified per-version runtime reuse, no Setup
installation, PATH change or service registration. Candidate/stable remain on HOLD.

[Detailed change and verification record](CONSOLE-NATIVE-RUNTIME-EDGE30.md).
