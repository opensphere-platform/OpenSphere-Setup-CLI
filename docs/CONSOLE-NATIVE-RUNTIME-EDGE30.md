# Setup CLI 0.5.0-edge.30 — Console native runtime bootstrap

## Governed source

- Console repository: `opensphere-platform/OpenSphere-console`
- Console revision: `1b2f63cd533fdad621f82294a82f3e81b7cb4d06`
- Console immutable release: `202609050056`
- Console edge anchor: `ghcr.io/opensphere-platform/opensphere-console@sha256:6d8d3e91db19885b6b0f241a4ea5c33a8c37a0d5470fe96eaa205df86f027141`
- Setup channel tag: `setup-v0.5.0-edge.30`
- Release class: `edge` prerelease
- Candidate/stable: HOLD

## Fresh-install behavior

After Supabase, Gitea and canonical C_API are ready, Setup performs a separately visible native
runtime phase. The phase validates the exact migration set, provisions least-privilege database
and Kubernetes authority, renders digest-pinned manifests, waits for every rollout, and records
the accepted release evidence through the owner-only database function.

The installed native core consists of:

- OSAA Gateway;
- OSDST;
- OS Shell API, Gateway and Reconciler;
- six dedicated `NOINHERIT` database login roles and workload-specific Secrets;
- four P-256 service TLS leaves under one Setup-managed local CA;
- one GHCR pull Secret scoped to ephemeral OS Shell session Pods;
- exact release, migration and replica evidence in `console_shell`.

C_API keeps its short-lived projected Kubernetes token and cluster CA. It may mount only the two
declared TLS Secret volumes used for native service communication. Registry authority covers the
five long-lived runtime namespaces plus `opensphere-shell-sessions`; the credential-only OSAA
namespace does not receive registry credentials.

## Verification gates

- Console complete Node test suite: 798 passed.
- Console migration verification: 35 migrations, latest global ID
  `opensphere-console/20260905/0035`.
- Console release-ready bootstrap contract verification: passed.
- Setup complete Node test suite: 328 passed.
- Integrated Console publisher: 22 images built, pushed and verified from one source revision.
- Exact Console API image started against isolated PostgreSQL: Ready HTTP 200; invalid database
  credential path failed closed with HTTP 503.
- Immutable date tags were published before the `edge` channel moved.

These source and publication gates do not by themselves prove installation reproducibility. The
release is complete only after the public portable Setup asset performs a purge-and-fresh
bootstrap on `docker-desktop`, all Console pages and native features pass end-to-end checks, and
the installed state recovers after a host reboot.

## Cluster Manager boundary

Operational Graph, Incident, Durable Operation and Engineering Remediation execution remain
Cluster Manager capabilities. Until Cluster Manager installs their current schemas, dedicated
login and reconcile authority, Console exposes those capabilities as explicitly `OFF` and returns
safe empty projections. Native Console readiness must not imply Cluster Manager readiness.
