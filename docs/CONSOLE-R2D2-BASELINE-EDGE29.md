# Setup CLI 0.5.0-edge.29 — Console R2D2 baseline

## Governed source

- Console repository: `opensphere-platform/OpenSphere-console`
- Console revision: `be3c2a05bdd8aeeb457d3e5c1132b6cd4a5289a4`
- Setup channel tag: `setup-v0.5.0-edge.29`
- Release class: `edge` prerelease
- Candidate/stable: HOLD

## Accepted baseline behavior

The fresh migration lineage ends at `opensphere-console/20260904/0034`. Migration 0034 adds the
durable LLM credential audit bridge without importing the legacy operational-plane schema.

LLM Key creation has been exercised end to end with synthetic key material:

1. Console accepted the create request under the local development authentication profile.
2. The provider credential was written to a namespaced Kubernetes Secret.
3. Read responses and the UI exposed metadata and fingerprint only.
4. Supabase stored the corresponding durable audit event.
5. The exact synthetic Secret was deleted and the UI returned to `0 keys`.

No real provider secret is part of source, image, release lock, test evidence or this document.

## Cluster Manager stage gate

The Console baseline owns credential custody, OSDST and the base R2D2 runtime projection.
Operational Graph, Incident, Durable Operation and Engineering Remediation execution require
Cluster Manager to install:

- the current operational schema and migration lineage;
- dedicated least-privilege database logins;
- source ownership and reconcile scope;
- postcondition and rollback evidence boundaries.

Until that activation is complete, the Gateway reports all operational flags as `false`, returns
empty read projections, and shows Repair Runner as waiting/fail-closed. This is a valid inactive
state. It is not evidence that the operational capabilities are installed or healthy. If any
operational flag is enabled without its schema or authority, the existing 503 fail-closed path
remains in effect.

## Verification performed before packaging

- Console focused operational API and projection tests: 36 passed.
- Console complete test suite at the functional change revision: 798 passed.
- Angular production build at the governed revision: passed.
- Local Kubernetes R2D2 page: no Platform Release/Repair Runner HTTP 503 caused by the inactive
  operational plane.
- Console overview: `Console baseline`, `Operational runtime OFF · Cluster Manager 필요`.
- R2D2 monitoring: `ACTIVATION OFF`, `Graph OFF`, `Incident OFF`, `RUNNER WAITING`.
- LLM key inventory after cleanup: `0`.

Existing Angular bundle/style budget warnings remain visible and are not installation failures;
they should be addressed as separate frontend optimization work.

## Completion boundary

This edge package may be published only after the integrated Console anchor is built from the
same governed revision and Setup tests pass. It does not by itself establish a completed clean
installation. The installation can be declared reproducible only after Setup resolves the exact
anchor, upgrades/verifies the current cluster, and a later clean bootstrap reaches the same
post-deployment acceptance state.
