# Beszel bootstrap evidence during upgrades

The official `opensphere-monitoring/job/beszel-bootstrap-v0187` has a TTL.
Its absence after successful initialization is not evidence that Beszel failed.
An upgrade formerly cleared the Ready verification anchor when recording
Installing, then rejected the missing Job during both target and rollback
verification. This could leave healthy previous workloads marked Installing.

Normal upgrades now capture the previous completed bootstrap proof before the
first Installing transition. This is an opaque, process-local handle, bound to
the installation ConfigMap UID and the exact Hub, Agent and Bootstrap images.
It cannot be reconstructed from serialized data or a caller's success flag.
An Installing/Failed record cannot create this handle. An unknown receipt,
incorrect Ready anchor or changed Beszel image cannot authorize reuse.

The proof applies only to the missing Job with the exact namespace, name,
kind, component and container. It does not excuse a present failed Job or any
other missing workload. Current workload images/readiness, private Hub health,
published public key, credentials, database and service checks still run.
Ready is written only after fresh full installation verification succeeds.
The same handle is available during rollback, under the same identity checks.

If a process has already failed and lost the previous Ready anchor, do not
rewrite its state or relabel old evidence as a successful current verification.
Prepare the installed release's governed Beszel manifest, use the existing
`runForwardRepairBootstrap` function to recreate only an absent official
idempotent Job, then use `completeInstallationVerification` for the unchanged
installed release. This retains runtime credentials and service images.

Verification: `test/verify-gate.test.mjs`, `test/upgrade.test.mjs`,
`test/forward-repair-bootstrap.test.mjs`, `test/installation-state.test.mjs`.
The complete Setup test suite passed 406 tests, with no skips, on 2026-09-13.
