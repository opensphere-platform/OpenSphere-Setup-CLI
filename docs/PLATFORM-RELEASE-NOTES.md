# OpenSphere Setup CLI 0.5.0-edge.29 — Console R2D2 baseline gate

This edge prerelease binds Setup to governed Console source
`be3c2a05bdd8aeeb457d3e5c1132b6cd4a5289a4`.

The Console baseline now treats LLM credential custody as an installable contract. A key is
stored only in a namespaced Kubernetes Secret, read projections expose only metadata and a
fingerprint, and the corresponding audit event is written through the fresh Supabase migration
lineage. Local development may use the documented exact exception to user MFA; this does not
weaken runtime service authentication or expand the exception to candidate/stable.

Operational Graph, Incident, Durable Operation and Engineering Remediation execution are
Cluster Manager capabilities. Before Cluster Manager installs their schema, dedicated database
login and reconcile scope, Console reports them as explicitly `OFF`. Read endpoints return safe
empty projections instead of HTTP 503. Enabling any capability without its authority still fails
closed.

This release does not declare the complete Console installation reproduced. Completion still
requires one integrated release anchor, Setup upgrade/verify against that anchor, full page and
feature acceptance, then a clean installation that reaches the same verified state.

[Detailed change and verification record](CONSOLE-R2D2-BASELINE-EDGE29.md).

Download the [Windows portable EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.29/opensphere-setup.exe), then run:

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.29 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

Approve the displayed GitHub device code. The public Client ID is built in; no PAT or client
secret is bundled. Windows remains portable with verified per-version runtime reuse, no Setup
installation, PATH change or service registration. Candidate/stable remain on HOLD.
