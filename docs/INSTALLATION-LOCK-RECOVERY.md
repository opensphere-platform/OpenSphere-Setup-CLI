# Installation lock explicit-preservation recovery

> **Historical incident contract:** this runbook preserves a reviewed legacy release. The workload and component counts below describe that historical lock, not the current 18-canonical + 3-auxiliary target catalog.

This runbook is only for incident
`2026-08-15-installation-lock-accidental-delete`. It reconstructs a missing
`opensphere-console/opensphere-installation-lock` ConfigMap without treating
the reconstruction as the original Kubernetes object.

## Meaning of the recovery

- `release.json` is byte-exact evidence recovered from the already reviewed
  Gitea declaration and its Applied database receipt.
- `config.json` is an approved **semantic reconstruction**, not a historical
  byte snapshot. The signed plan records that status and its reviewed SHA-256.
- The old ConfigMap UID is evidence only. Kubernetes creates a new UID and
  resourceVersion; the durable receipt binds both old and new identities.
- The normal release-lock validator is unchanged. Only the incident-specific,
  signed recovery plan can admit the legacy Console component lock.

Do not guess missing fields, restore the stale local cache, use `kubectl apply`,
or create a replacement ConfigMap by hand.

## Required immutable inputs

The plan must already have passed the closed validator in
`src/installation-lock-recovery.mjs`. Its ES256-P1363 approval is anchored to
the observed `opensphere-edge-local-v1` key in `opensphere-extension-trusted-keys` and binds:

- incident raw bytes and digest;
- Gitea commit, path, Git blob ID, and raw document digest;
- Applied request, operation, merge revision, and database receipt digest;
- installation-evidence and release-inventory UID/resourceVersion;
- the historical 15 workload identities, digest-pinned images, Ready Pod
  imageIDs, two suspended-safe recovery CronJobs, and historical 13-component
  source mapping recorded by this incident plan;
- the four Bound `hostpath` CBS PVCs, initial-admin ConfigMap, Backend URL,
  managed `shell-tls` metadata/type/key names, and trust ConfigMap identity;
- semantic configuration reconstruction digest and approval reason;
- absolute workspace and receipt directory, plus the completed quarantine
  journal and quarantined regular-file path/hash for the known stale cache.
  These paths are signed inputs and cannot be replaced with CLI options.

The signed receipt directory must resolve outside the source repository. The
stale cache path `<workspace>/.codex-deploy/current-installation-lock.json`
must be absent. The signed plan also requires the exact known stale cache
(4654 bytes, SHA-256 `a74e6796...75bc1`, release
`sha256:0a580e9e...d4d9d4`, source `4f771141...6209f`) as a unique regular
file outside the repository, together with its no-overwrite completed
quarantine journal. Neither file may be a symlink, junction, or ambiguous hard
link. Preparation output, quarantine, and durable receipt directory roots must
also be owned by the current SID and have Windows ACL inheritance disabled,
exactly one explicit current-user full-control rule, exact
`ContainerInherit,ObjectInherit`, and `PropagationFlags=None`; POSIX-style
`0700` alone is not treated as Windows custody.
These stale bytes are evidence only and are never a recovery lock input.

## Local stale-cache quarantine (separate operation)

Quarantine is a local-only operation and is never implicit in recovery. An
immutable closed intent owns the workspace, external quarantine and receipt
directories, operation UUID, timestamp, and exact reviewed stale profile.

```text
opensphere-setup quarantine-stale-installation-lock \
  --intent <immutable-quarantine-intent.json> \
  --confirm QUARANTINE-STALE-INSTALLATION-LOCK
```

The operation is Windows-only. It first creates or verifies the external
current-user-only directory ACL. It verifies the source, writes and fsyncs an
exclusive prepared journal, re-verifies source identity and bytes, proves the
source and destination are on one volume, then performs a no-overwrite atomic
rename using exact inline PowerShell bytes and
`System.IO.File.Move(source,destination,false)`; both paths cross the child
boundary only through environment variables. A lost rename response is resumed only when the source is absent and
the destination plus prepared journal remain byte-exact. It never performs a
copy-plus-pathname-unlink sequence and never overwrites different destination
bytes. This source change did **not** run the command or move the live stale
file.

## Offline plan preparation

Preparation consumes a reviewed immutable evidence bundle, immutable reason
file, and a P-256 PKCS8 private-key file under the current user's
`.opensphere/keys` custody. Private-key and signature bytes are never command
line values or log output.

```text
opensphere-setup prepare-installation-lock-recovery \
  --evidence <immutable-reviewed-evidence.json> \
  --approval-key <current-user-only-p256-pkcs8.pem> \
  --reason-file <immutable-reason.txt> \
  --approval-id <uuid-v4> --approved-at <ISO-8601> --expires-at <ISO-8601,max-30m> \
  --output-dir <outside-repository-directory> \
  --confirm PREPARE-SIGNED-INSTALLATION-LOCK-RECOVERY
```

Before reading the key, the command proves the Setup repository is clean
canonical `main` at freshly fetched `origin/main` and verifies the reviewed Git
blob and SHA-256 for CLI, core, local-state, preparation, runtime, and Windows
directory-custody/ACL helper sources. The reviewed helper bytes are passed to PowerShell through
`-EncodedCommand`; the key path is supplied only through a child environment
variable. The helper enforces a non-reparse key with inheritance disabled and
current-user-only ACLs. The derived P-256 SPKI must equal the
signed trust observation. Approval binds the tooling-authority digest.

Approval document, detached ES256-P1363 signature, validated plan, and
preparation receipt are written with exclusive no-overwrite writes and fsync.
The receipt binds evidence, approval, signature, plan, local-state, and tooling
hashes. Response-loss replay accepts only byte-identical files.

## Authorized command

Only after a separate operator approval authorizes cluster mutation:

```text
opensphere-setup recover-installation-lock \
  --plan <immutable-signed-plan.json> \
  --confirm RECOVER-MISSING-INSTALLATION-LOCK \
  [--context docker-desktop]
```

The command accepts no workspace or receipt-directory override. It reads both
from the signed plan. Keep the plan file immutable for the entire operation;
the adapter hashes and re-stats it before mutation.

## State machine

1. Validate the plan, approval, exact confirmation phrase, signed filesystem
   paths, absence of the stale local cache, exact external quarantine
   file/journal, and reviewed recovery tooling. No Kubernetes read occurs
   before these checks.
2. Re-observe every signed precondition. The Kubernetes client child necessarily
   reads the Secret object, but only `shell-tls` UID, resourceVersion, type, and
   sorted data key names cross into the parent process. Secret values are never
   emitted to parent/stdout, persisted, hashed, signed, logged, or included in
   evidence. The trust key is read from the closed nested
   `trusted-keys.json.trustedKeys` object.
3. Require the installation lock to be absent and issue exactly one
   `kubectl create -f -`; apply, replace, and patch are not used.
4. If create reports conflict or response loss, GET the object and accept it
   only when labels, annotations, both data values, and lifecycle metadata
   exactly match the plan. Such an ambiguous object is never owned by this
   execution and is never deleted after verifier failure.
5. Re-observe the full precondition set and verify the new UID/resourceVersion,
   release/config hashes, evidence/inventory identities, and Ready image set.
6. Append a durable receipt revision outside the repository. Receipt history
   is append-only and contiguous; unknown, missing, symlinked, irregular, or
   hard-linked revisions fail closed. Each append exclusively writes and fsyncs
   a unique non-authoritative staging candidate, validates its identity and
   bytes, then uses Windows no-overwrite moves to promote it first to the
   deterministic pending name and then to the final revision. Neither staging,
   pending, nor final files are ever hard-linked. A partial staging candidate
   left by a write crash is never parsed as evidence and cannot block a fresh
   candidate; a response loss after promotion accepts only the exact pending or
   final revision with `nlink=1`.
   `readReceipt(planDigest)` returns the newest revision.

Staging names have one closed plan/revision/nonce profile. Known-name staging
residue is non-authoritative and may contain incomplete JSON; it is never read
as a receipt. The runtime automatically removes only the exact unique candidate
whose device/inode/creation-time/size and bytes were captured by that live
append. It deliberately retains crash-orphaned candidates instead of deleting
an unowned pathname. Repeated crash residue remains visible but does not enter
history or block a restart. There is intentionally no automatic pruning;
operational cleanup requires a separately reviewed, explicit local custody
operation and must not reuse the recovery command as deletion authority.

Receipt transitions are closed:

- no receipt → `SemanticReconstructionRecovered`;
- no receipt → `RollbackClaimed` → `RolledBackToMissing` (terminal; a new
  approval is required);
- no receipt → `NeedsAttentionPreservedExactObject`;
- `RollbackClaimed` → `NeedsAttentionPreservedExactObject` when a different
  object appears, without delete or create;
- `NeedsAttentionPreservedExactObject` → `SemanticReconstructionRecovered`
  after the same plan verifies successfully;
- identical receipt replay is side-effect free.

## Rollback and failure handling

Rollback is allowed only when a successful create response and the subsequent
GET prove the same UID/resourceVersion was created by this execution. Before
DELETE, the state machine durably appends `RollbackClaimed`. The adapter then re-GETs the
object and compares its UID/resourceVersion, then calls the Kubernetes HTTPS
API directly with a `DeleteOptions.preconditions` body containing that exact
UID and resourceVersion. It never uses raw kubectl DELETE or `kubectl delete
-f` as a concurrency substitute.

An exact `RollbackClaimed` replay resumes DELETE even after approval expiry.
If DELETE response is lost but GET proves the object absent, the state machine
appends terminal `RolledBackToMissing`. If the object identity has changed, the
direct DELETE boundary is not called.
If an exact object predated this execution, verifier failure preserves it and
records `NeedsAttentionPreservedExactObject`. If recovery verification passed
but receipt storage failed, preserve the verified object and repair the
receipt path; do not delete it.

## Current execution hold

Source and mock tests do not authorize recovery. Until the reviewed plan file,
explicit mutation approval, external receipt custody, and exact kube context
are provided, do not run the command and do not issue any Kubernetes mutation.
