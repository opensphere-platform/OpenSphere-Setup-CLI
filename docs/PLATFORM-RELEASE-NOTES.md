# OpenSphere Setup CLI 0.5.0-edge.42

Observer replacements now remove the client-side apply tracking annotation before
kubectl runs. Otherwise kubectl refreshes an existing last-applied value from the
complete live input, including server UID/resourceVersion/status or sealed Secret
data. That poisoned baseline blocked both a later official Console component
upgrade and its rollback. Existing contaminated metadata needs a separately
reviewed, UID/resourceVersion-bound annotation repair; the helper does not delete
admission policies, loosen their specifications or silently perform that repair.

The fixed 12-asset snapshot is re-pinned to PSSS commit
`fc136f54df1b2c1346cb6cb70d0195b3caf305ff`; only the helper's content changed.
This is tool provenance, not a new deployed PSSS image. Compatibility arguments
must continue to identify the actual Current Registration (PSSS 20 source
`65d8bbfdddefafd1d1146b4ac73f8bda8f517a9f` for the verified deployment).

Baseline completion also distinguishes an old committed one-way migration from
a boundary newly crossed by the current attempt. Historical state alone no
longer blocks completion, but it must match the selected release's verified
cutover and baseline evidence. The strict checks and refusal of actual unsafe
rollback remain; no migration ledger or database entry is edited to bypass them.

Only Setup source/tooling changes are included. No Console or PSSS image rebuild,
runtime permission expansion, existing immutable asset replacement or channel
promotion is part of this candidate. Publication and actual installation
acceptance are reported separately.

## Earlier edge.41 preparation retained

Full preparation and recovery now preserve the exact approved Argo Core executor
Role after the observer cutover removed signing Secret get/create. The expected
legacy and reduced definitions are both pinned; other identities or rule changes
still fail before writes. The transition does not patch or restore authority.

The fresh-install runbook now includes the existing reviewed six-role
`prepare-psss-argocd` transition before `core-credentials` and OS Shell Core
installation. Console's generated profile and extension-controller manifest
prepare the matching delivery VAP before a demo Project is created.

This is a new immutable Setup source version. Existing edge.40 assets are not
replaced, the PSSS65d8 observer snapshot remains unchanged, and the edge pointer
is promoted only after separate publication and asset verification. Source tests
do not claim an accepted real full recovery or independent clean installation.

## Earlier edge.40 observer preparation retained

Add the explicit `prepare-argocd-observer` command for Setup-owned Argo read
preparation. It verifies 12 fixed source assets from PSSS commit
`65d8bbfdddefafd1d1146b4ac73f8bda8f517a9f` before execution. Every operation
requires an explicit kubeconfig, context and expected cluster UID; writes also
require a freshly reviewed plan digest. Existing Core preparation guards remain.

The staged procedure covers durable internal TLS, a seven-day read-only apiKey,
finite local namespace cache scope, and only the fixed demo Project's generated
ReplicaSet/Pod observation. Source validation still rejects direct ReplicaSet/Pod
deployment, and controller writes remain denied. Cutover removes signing Secret
read/create authority. Token cleanup resumes only after exact account metadata
proves revocation; private material remains in memory and Secret stdin.

The native Linux SEA smoke check loads the verified observer assets and confirms
that missing cluster identity fails before Kubernetes access. Only the used Linux
amd64 archive and SHA256SUMS are published. Publication does not itself install a
module, change Console or complete application acceptance. The edge pointer is
promoted separately after the immutable asset digests are verified.

See [the operator runbook](argocd-observer-preparation.md) for stage ordering,
partial-outcome handling, renewal and remaining TLS rotation work.

## Earlier edge.39 preparation retained

Fresh bootstrap now prepares the fixed 96-resource HISS execution profile,
including cert-manager controller authority and fixed service accounts. Existing
installations can run `opensphere-setup prepare-hiss --context <context>` to
review the same profile and add `--apply` to fill missing prerequisites. Existing
conflicting objects are refused; every write remains bound to the observed
cluster UID and installation UID, release digest, channel and Console origin.
This prepares authority; it does not claim the cert-manager workload is installed.
Use the Console HISS installation review to install and verify that capability.

Console activation now includes canonical OS Shell Pod admission checks. A Ready
control Pod cannot hide a rejected session Pod. Failed or timed-out sessions show
an actionable error and a deliberate retry instead of an endless Pending state.

Only the used Linux amd64 archive and SHA256SUMS are published.

## Earlier edge.38 correction retained

Uninstall now inventories Foundation/catalog CRDs using their actual Cluster or
Namespaced scope. It refuses shared custom data before deleting anything, removes
all owned admission bindings before deleting parameter namespaces or starting
cleanup Jobs, and verifies cluster resources and PVs are gone before success.
Previously a Namespaced-only guard stopped after namespace deletion and left a
Ceph binding whose missing parameter rejected the next Beszel bootstrap Job.

Fresh bootstrap checks for orphaned Console cluster resources before writing
namespaces/credentials. Resume diagnoses missing managed admission parameters.
Neither path changes Deny to Allow or disables another owner's policy. The local
clean-install harness now calls production uninstall instead of maintaining a
separate, outdated deletion implementation. The isolated Kubernetes admission
regression is distinct from full Console installation acceptance.

## Earlier edge.37 correction retained

Fresh installation now renders the Console LoadBalancer port from the exact
administrator-selected origin: HTTPS defaults to443, explicit ports are retained,
and localhost:1114 remains1114. Only the governed Service document is edited.
Malformed or ambiguous Service definitions fail before installation.

Installation success now requires the recorded origin to match the actual Service
and to return Console HTML, public API readiness and bootstrap status through its
real hostname/port. TLS checks use normal chain/hostname/validity validation with
the installation's public CA material. No tunnel, redirect, insecure TLS fallback,
or Pod readiness result substitutes for this check. Failures cannot record Ready.
Evidence describes verification from the Setup host; it does not assert that a
separate administrator browser already trusts a private installation CA.

Fix an uninstall hang after the Beszel node inspections: internal ConfigMap input
now reaches kubectl through stdin even when command output is streamed to the
terminal. Previously `kubectl create -f -` inherited the terminal and waited for
administrator input. Real child-process regression tests cover supplied/empty
input, interactive inheritance, captured output and exit failures. Cleanup plan
creation has a 30-second request limit and a 45-second process limit.

Uninstall now reports its current stage, each Beszel node and namespace wait,
and elapsed time. This release changes Setup only; Console 202609232230 remains
the installation image set. No deletion ownership or scope is widened.

This release publishes only the Linux amd64 portable archive and SHA256SUMS for
the current RKE2 installation.

Uninstall now handles an installation that stopped before Beszel was created.
When both the agent and its cleanup checkpoint are absent, read-only Jobs must
verify the exact Beszel directory is empty on every Ready, unchanged node and no
live Pod uses that path. Nonempty/unreadable data, an unavailable node, or an
appearing agent stops deletion. No ownership checkpoint is invented and this
branch deletes no host data. Existing installed-agent cleanup retains its checks.

When the Cilium policy API is present, fresh installation materializes a namespaced
Console API policy for the kube-apiserver entity on the discovered HTTPS ports.
It keeps standard NetworkPolicy rules and does not change global Cilium settings.
The accompanying Console release fixes both PostgreSQL PGDATA paths and nginx DNS.

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
