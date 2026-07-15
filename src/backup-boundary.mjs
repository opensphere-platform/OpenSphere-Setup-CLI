// Dedicated audit-backup security boundary (CONSTITUTION-0004 §4.5).
//
// Setup provisions a least-privilege opensphere_backup PostgreSQL role and its
// dedicated backbone-postgres/backup_password credential; the scheduled
// backbone-postgres-backup CronJob authenticates as that role (pg_read_all_data)
// rather than the constrained Console runtime `console` role, and its pg_dump
// command line -- carried in the backbone-postgres-backup-scripts ConfigMap --
// runs as `-U opensphere_backup`. Once this boundary exists, a downgrade to an
// older signed release whose own manifests still hardcode `pg_dump -U console`
// (and consume the `password` key) must NOT be allowed to regress it: the
// constrained console role cannot read the forward `oaa` schema, so its
// recovery-drill backup Job fails. This module holds the pure (cluster-free)
// predicates and the compatibility-overlay builder so the same boundary logic is
// shared by bootstrap (which reapplies the overlay) and verify (which fails
// closed when the live boundary is not the dedicated role).
//
// The boundary spans three distinct in-cluster resources in opensphere-backbone,
// each with its OWN name -- they are NOT a single shared identity:
//   * backbone-postgres-backup          (CronJob)   -- scheduled pg_dump
//   * backbone-postgres-backup-scripts  (ConfigMap) -- the backup.sh pg_dump script
//   * backbone-postgres-restore-drill   (CronJob)   -- suspended non-destructive restore
export const BACKUP_CRONJOB_RESOURCE = 'backbone-postgres-backup';
export const BACKUP_SCRIPTS_CONFIGMAP_RESOURCE = 'backbone-postgres-backup-scripts';
export const RESTORE_DRILL_CRONJOB_RESOURCE = 'backbone-postgres-restore-drill';
export const COMPATIBILITY_OVERLAY_ANNOTATION = 'opensphere.io/compatibility-overlay';
export const COMPATIBILITY_OVERLAY_VALUE = 'dedicated-backup-boundary';

// Server-managed metadata must never be re-applied verbatim: a captured live
// resource carries a resourceVersion/uid/managedFields that would either be
// rejected on apply or silently re-anchor ownership. Strip them (and any status)
// so the overlay is a clean, declarative manifest.
const SERVER_MANAGED_METADATA = Object.freeze([
  'resourceVersion', 'uid', 'creationTimestamp', 'generation',
  'managedFields', 'selfLink', 'ownerReferences'
]);

const POSTGRES_IMAGE = /^ghcr\.io\/opensphere-platform\/opensphere-cbs-postgresql@sha256:[a-f0-9]{64}$/;

// A pg_dump line that authenticates as the dedicated read-only role, and the
// forbidden constrained-console role in ANY form (`-U console`,
// `--username console`, `--username=console`). \b keeps `consoleadmin` /
// `opensphere_backup_ro` from being mistaken for an exact-role match.
const PG_DUMP_BACKUP_USER = /pg_dump\b[^\n]*?(?:-U|--username[=\s])\s*opensphere_backup\b/;
const PG_CONSOLE_USER = /(?:-U|--username[=\s])\s*console\b/;

function podSpec(cronJob) {
  return cronJob?.spec?.jobTemplate?.spec?.template?.spec ?? null;
}

function allContainers(spec) {
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])];
}

// Every backbone-postgres Secret key referenced by any container of the CronJob's
// pod template. The credential a Job authenticates with is the security boundary,
// so this is what "opensphere_backup + backup_password" is proven against.
export function backupCronJobBackbonePostgresKeys(cronJob) {
  const keys = [];
  for (const container of allContainers(podSpec(cronJob))) {
    for (const entry of container.env ?? []) {
      const ref = entry.valueFrom?.secretKeyRef;
      if (ref?.name === 'backbone-postgres' && ref.key) keys.push(ref.key);
    }
  }
  return keys;
}

// Map of env-var name -> backbone-postgres Secret key referenced by the CronJob's
// pod template. Unlike backupCronJobBackbonePostgresKeys this is keyed by env-var
// so a specific variable (PGPASSWORD, POSTGRES_PASSWORD) can be asserted to bind
// the dedicated credential.
export function backbonePostgresEnvRefs(cronJob) {
  const refs = {};
  for (const container of allContainers(podSpec(cronJob))) {
    for (const entry of container.env ?? []) {
      const ref = entry.valueFrom?.secretKeyRef;
      if (ref?.name === 'backbone-postgres' && ref.key && entry.name) refs[entry.name] = ref.key;
    }
  }
  return refs;
}

// The CronJob is on the dedicated boundary only when the pg_dump process actually
// authenticates as opensphere_backup: PGPASSWORD -- the variable libpq reads the
// password from -- must bind backbone-postgres/backup_password, and NO
// backbone-postgres env ref anywhere on the pod may fall back to the constrained
// Console runtime `password` key. A mere `backup_password` reference on some
// unrelated env var does not prove authentication: PGPASSWORD could be a literal,
// absent, or point at another key while backup_password sits inert. Both conditions
// matter: a regressed release consumes `password`, and a partially-migrated one
// must not pass either.
export function backupCronJobUsesDedicatedRole(cronJob) {
  const refs = backbonePostgresEnvRefs(cronJob);
  return refs.PGPASSWORD === 'backup_password' && !Object.values(refs).includes('password');
}

// Concatenated script text of the backup-scripts ConfigMap (all data values, so a
// console user hidden in a companion script -- not just backup.sh -- still fails
// the predicate closed).
export function backupScriptConfigMapText(configMap) {
  const data = configMap?.data;
  if (!data || typeof data !== 'object') return null;
  const values = Object.values(data).filter((value) => typeof value === 'string');
  return values.length ? values.join('\n') : null;
}

// The backup-scripts ConfigMap is on the dedicated boundary only when its script
// actually runs `pg_dump -U opensphere_backup` and never references the console
// role. The credential reference alone is insufficient: a regressed release can
// ship the dedicated backup_password Secret ref on the CronJob while its ConfigMap
// still hardcodes `pg_dump -U console`, which fails on the forward `oaa` schema.
export function backupScriptUsesDedicatedRole(configMap) {
  const text = backupScriptConfigMapText(configMap);
  if (!text) return false;
  return PG_DUMP_BACKUP_USER.test(text) && !PG_CONSOLE_USER.test(text);
}

// Resource-set predicate: the boundary exists only when BOTH halves are dedicated
// -- the CronJob binds backup_password AND the ConfigMap script runs as
// opensphere_backup. Fails closed if either half regresses.
export function backupBoundaryResourcesAreDedicated({ cronJob, configMap } = {}) {
  return backupCronJobUsesDedicatedRole(cronJob) && backupScriptUsesDedicatedRole(configMap);
}

// The suspended restore-drill CronJob preserves the credential boundary when it
// provisions and loads its EPHEMERAL restore database using the sealed bootstrap
// operator ALONE and exposes NO Console/backup read credential. The restore drill
// does NOT authenticate as opensphere_backup: it never reads live audit data, so it
// needs no read-only backup role. In the current canonical contract POSTGRES_PASSWORD
// binds backbone-postgres/bootstrap_password and restore-drill.sh runs every
// createdb/pg_restore/psql with an inline `PGPASSWORD="$POSTGRES_PASSWORD"` -- the
// read-only backup_password credential is deliberately absent from the Job (least
// exposure). The boundary is preserved only when: POSTGRES_PASSWORD binds the
// bootstrap operator credential, PGPASSWORD is NOT wired as a backbone-postgres
// credential at all (rejecting both PGPASSWORD=backup_password and the console
// runtime PGPASSWORD=password), and NO backbone-postgres env ref anywhere falls back
// to the constrained console runtime `password` key. An older release whose restore
// drill still binds PGPASSWORD to `password` (or to backup_password) regresses this
// boundary and must be overlaid, not trusted.
export function restoreDrillPreservesCredentialBoundary(cronJob) {
  const refs = backbonePostgresEnvRefs(cronJob);
  return refs.POSTGRES_PASSWORD === 'bootstrap_password'
    && !('PGPASSWORD' in refs)
    && !Object.values(refs).includes('password');
}

// The FULL monotonic backup boundary spans all THREE resources: the scheduled
// backup CronJob credential, the backup-scripts ConfigMap pg_dump user AND the
// restore-drill CronJob credential boundary. The recovery guarantee is only
// preserved when the scheduled backup CronJob and its script authenticate as
// opensphere_backup AND the restore drill preserves its credential boundary (sealed
// bootstrap only, no exposed backup/console read credential) -- a release (or live
// installation) that regresses ANY single resource, including a restore drill that
// wires the console runtime `password` (or the read-only backup_password) into
// PGPASSWORD, is NOT on the dedicated boundary and must be overlaid rather than
// trusted. Fails closed if any resource is absent or regressed.
export function backupBoundaryFullyDedicated({ cronJob, configMap, restoreDrill } = {}) {
  return backupBoundaryResourcesAreDedicated({ cronJob, configMap })
    && restoreDrillPreservesCredentialBoundary(restoreDrill);
}

export function sanitizeManifestMetadata(resource) {
  const clone = JSON.parse(JSON.stringify(resource));
  delete clone.status;
  const metadata = clone.metadata ?? {};
  for (const field of SERVER_MANAGED_METADATA) delete metadata[field];
  if (metadata.annotations) delete metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  clone.metadata = metadata;
  return clone;
}

// The overlay is captured from the (newer) live installation but re-applied on top
// of the release being installed, so its digest-pinned PostgreSQL image must be the
// release's own cbsPostgresql image -- never the captured installation's image.
export function retargetPostgresImage(cronJob, image) {
  const spec = podSpec(cronJob);
  if (!spec || !image) return cronJob;
  for (const container of allContainers(spec)) {
    if (POSTGRES_IMAGE.test(container.image ?? '')) container.image = image;
  }
  return cronJob;
}

// Build the auditable compatibility overlay: a sanitized, image-retargeted copy of
// the live dedicated-boundary resource, annotated so it is unambiguously an overlay
// preserving the boundary across a release whose own manifests would regress it.
export function compatibilityBackupOverlay(resource, lock, postgresImage) {
  const overlay = sanitizeManifestMetadata(resource);
  if (overlay.kind === 'CronJob') retargetPostgresImage(overlay, postgresImage);
  overlay.metadata.annotations = {
    ...(overlay.metadata.annotations ?? {}),
    [COMPATIBILITY_OVERLAY_ANNOTATION]: COMPATIBILITY_OVERLAY_VALUE,
    'opensphere.io/overlay-release': lock.releaseDigest,
    'opensphere.io/overlay-source-revision': lock.sourceRevision
  };
  return overlay;
}

// The ordered overlay set applied to preserve the boundary across a regressive
// release: the scripts ConfigMap first (so both CronJobs mount the dedicated
// backup.sh), then the backup CronJob, then the suspended restore-drill CronJob.
// Absent resources are skipped. Every CronJob is image-retargeted to the applied
// release's cbsPostgresql digest.
export function buildCompatibilityOverlaySet(boundary, lock, postgresImage) {
  return [boundary?.configMap, boundary?.cronJob, boundary?.restoreDrill]
    .filter(Boolean)
    .map((resource) => compatibilityBackupOverlay(resource, lock, postgresImage));
}

// --- Clean-bootstrap compatibility: DERIVE the dedicated boundary from a regressed
// --- release (there is no live boundary to capture) ---
//
// Upgrade/downgrade preserves a live dedicated boundary via captureBackupBoundary +
// buildCompatibilityOverlaySet. A CLEAN bootstrap of a historical signed lock has no
// live dedicated resources to capture: the just-applied BASE_MANIFESTS may themselves
// predate the boundary. The three resources are instead DERIVED from the applied
// release by transforming their PARSED Kubernetes objects into the dedicated form --
// never by patching manifest text. Each transform asserts its dedicated postcondition
// and fails closed with a precise error when a historical shape cannot be safely
// transformed, so the contract is never weakened (CONSTITUTION-0004 §4.5).

// Repoint (or drop) every backbone-postgres secretKeyRef in a CronJob's pod template.
// `mapKey(key, envName)` returns the replacement Secret key, null to drop the whole env
// entry, or the same key for a no-op. Literal env vars and refs to other Secrets are
// left untouched. Mutates and returns the passed-in CronJob clone.
function rewriteBackbonePostgresRefs(cronJob, mapKey) {
  for (const container of allContainers(podSpec(cronJob))) {
    if (!Array.isArray(container.env)) continue;
    container.env = container.env.flatMap((entry) => {
      const ref = entry.valueFrom?.secretKeyRef;
      if (ref?.name !== 'backbone-postgres' || !ref.key) return [entry];
      const mapped = mapKey(ref.key, entry.name);
      if (mapped === null) return [];
      if (mapped === ref.key) return [entry];
      return [{ ...entry, valueFrom: { ...entry.valueFrom, secretKeyRef: { ...ref, key: mapped } } }];
    });
  }
  return cronJob;
}

// A pg_dump/psql role flag naming the constrained console runtime role, in any accepted
// form (-U console, --username console, --username=console). The database argument
// (-d console) is deliberately NOT matched, so only the authenticating role is rewritten.
const CONSOLE_ROLE_FLAG = /((?:-U|--username[=\s])\s*)console\b/g;

// dc272f4 and other early signed releases exported a Console PGPASSWORD into the
// restore-drill Job only to satisfy this guard. Every database client invocation in
// the same script already overrides it inline with the sealed bootstrap credential:
// `PGPASSWORD="$POSTGRES_PASSWORD" createdb|pg_restore|psql|dropdb ...`. Once the
// compatibility overlay removes the exposed Console credential, that obsolete guard
// must be removed as well or the hardened Job exits before doing any work.
const LEGACY_RESTORE_PGPASSWORD_GUARD = /^\s*:\s*"\$\{PGPASSWORD:\?PGPASSWORD is required\}"\s*$/gm;

function removeLegacyRestorePgPasswordGuard(script) {
  if (!LEGACY_RESTORE_PGPASSWORD_GUARD.test(script)) return script;
  LEGACY_RESTORE_PGPASSWORD_GUARD.lastIndex = 0;
  const transformed = script.replace(LEGACY_RESTORE_PGPASSWORD_GUARD, '');
  const unsafeReference = transformed
    .split('\n')
    .find((line) => /\bPGPASSWORD\b/.test(line) && !/PGPASSWORD="\$POSTGRES_PASSWORD"/.test(line));
  if (unsafeReference) {
    throw new Error(`Cannot derive dedicated ${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}: restore drill still consumes PGPASSWORD outside the sealed bootstrap override`);
  }
  return transformed.replace(/\n{3,}/g, '\n\n');
}

// backbone-postgres-backup-scripts: rewrite every console-role pg_dump/psql invocation
// in every script value to the dedicated read-only opensphere_backup role. Fails closed
// (rather than injecting a flag into shell text) if the result does not run pg_dump as
// opensphere_backup -- e.g. a historical script that supplies the role via an env var
// instead of an inline flag cannot be safely transformed here.
export function deriveDedicatedBackupScripts(configMap) {
  const clone = JSON.parse(JSON.stringify(configMap ?? null));
  const data = clone?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`Cannot derive dedicated ${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}: no script data to transform`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    const roleRewritten = value.replace(CONSOLE_ROLE_FLAG, (_match, flag) => `${flag}opensphere_backup`);
    data[key] = key === 'restore-drill.sh'
      ? removeLegacyRestorePgPasswordGuard(roleRewritten)
      : roleRewritten;
  }
  if (!backupScriptUsesDedicatedRole(clone)) {
    throw new Error(`Cannot derive dedicated ${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}: script does not run pg_dump as opensphere_backup after transformation`);
  }
  return clone;
}

// backbone-postgres-backup: rewrite the CronJob so PGPASSWORD binds the dedicated
// backup_password credential and no backbone-postgres ref keeps the console runtime
// `password` key. Fails closed if PGPASSWORD is not a backbone-postgres credential to
// retarget (a literal or foreign-Secret PGPASSWORD cannot be safely made dedicated).
export function deriveDedicatedBackupCronJob(cronJob) {
  const clone = JSON.parse(JSON.stringify(cronJob ?? null));
  if (!('PGPASSWORD' in backbonePostgresEnvRefs(clone))) {
    throw new Error(`Cannot derive dedicated ${BACKUP_CRONJOB_RESOURCE}: PGPASSWORD is not bound to a backbone-postgres credential`);
  }
  rewriteBackbonePostgresRefs(clone, (key, envName) =>
    (envName === 'PGPASSWORD' || key === 'password') ? 'backup_password' : key);
  if (!backupCronJobUsesDedicatedRole(clone)) {
    throw new Error(`Cannot derive dedicated ${BACKUP_CRONJOB_RESOURCE}: console runtime credential still present after transformation`);
  }
  return clone;
}

// backbone-postgres-restore-drill: rewrite the CronJob so POSTGRES_PASSWORD binds the
// sealed bootstrap operator and NO PGPASSWORD backbone-postgres credential is exposed
// (restore-drill.sh consumes an inline PGPASSWORD="$POSTGRES_PASSWORD" only). Every
// backbone-postgres ref other than a dropped PGPASSWORD is pinned to bootstrap_password
// so no console/backup read credential remains. Fails closed if POSTGRES_PASSWORD is
// not a backbone-postgres credential to retarget.
export function deriveDedicatedRestoreDrill(restoreDrill) {
  const clone = JSON.parse(JSON.stringify(restoreDrill ?? null));
  if (!('POSTGRES_PASSWORD' in backbonePostgresEnvRefs(clone))) {
    throw new Error(`Cannot derive dedicated ${RESTORE_DRILL_CRONJOB_RESOURCE}: POSTGRES_PASSWORD is not bound to a backbone-postgres credential`);
  }
  rewriteBackbonePostgresRefs(clone, (_key, envName) => envName === 'PGPASSWORD' ? null : 'bootstrap_password');
  if (!restoreDrillPreservesCredentialBoundary(clone)) {
    throw new Error(`Cannot derive dedicated ${RESTORE_DRILL_CRONJOB_RESOURCE}: backup/console read credential still exposed after transformation`);
  }
  return clone;
}

// The ordered dedicated overlay set for a clean bootstrap: derive each of the three
// resources from the applied (regressed) release, then wrap each as an auditable,
// image-retargeted, annotated compatibility overlay -- scripts ConfigMap first so both
// CronJobs mount the dedicated backup.sh, then the backup CronJob, then the suspended
// restore drill. A missing required resource fails closed with a precise error rather
// than silently establishing a partial boundary.
export function buildBootstrapBackupBoundaryOverlaySet({ cronJob, configMap, restoreDrill } = {}, lock, postgresImage) {
  if (!configMap) throw new Error(`Cannot establish the dedicated backup boundary: release is missing ConfigMap ${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}`);
  if (!cronJob) throw new Error(`Cannot establish the dedicated backup boundary: release is missing CronJob ${BACKUP_CRONJOB_RESOURCE}`);
  if (!restoreDrill) throw new Error(`Cannot establish the dedicated backup boundary: release is missing CronJob ${RESTORE_DRILL_CRONJOB_RESOURCE}`);
  return [
    deriveDedicatedBackupScripts(configMap),
    deriveDedicatedBackupCronJob(cronJob),
    deriveDedicatedRestoreDrill(restoreDrill)
  ].map((resource) => compatibilityBackupOverlay(resource, lock, postgresImage));
}

// Pure planner for the clean-bootstrap path: a no-op (empty set) when the applied
// release already ships all three dedicated resources -- so a forward release's own
// dedicated backup manifests are never overlaid -- otherwise the ordered dedicated
// overlay set derived from the release. Callers apply the returned overlays in order.
export function planBootstrapBackupBoundary(resources, lock, postgresImage) {
  if (backupBoundaryFullyDedicated(resources)) return [];
  return buildBootstrapBackupBoundaryOverlaySet(resources, lock, postgresImage);
}

// --- Setup-owned dedicated backup ROLE reconcile (clean-bootstrap only) ---
//
// The overlays above make the scheduled backup CronJob authenticate as the dedicated
// read-only opensphere_backup PostgreSQL role. But a historical signed release (e.g.
// dc272f4) predates that role ENTIRELY: its PostgreSQL init and boundary-reconcile SQL
// never CREATE it. On a clean bootstrap of such a release the role does not exist, so the
// recovery-drill pg_dump -- now overlaid to run `-U opensphere_backup` -- would fail
// authentication. (The prior CI backup only passed because it still used the old console
// role.) When -- and only when -- planBootstrapBackupBoundary actually overlays a
// regressed release, current Setup must also ESTABLISH the missing role before the
// recovery drill, WITHOUT weakening verifyRecovery and without touching upgrade/downgrade.
//
// This is a Setup-OWNED, auditable, one-shot Kubernetes reconcile expressed as parsed
// objects (a ConfigMap carrying the shell + SQL, and a Job image-pinned to the applied
// release's cbsPostgresql image). The Job connects as the sealed bootstrap operator over
// verify-full TLS (CA mounted from backbone-postgres/ca.crt), reads the dedicated backup
// credential through psql \getenv (never on argv, never embedded in the SQL) and
// idempotently CREATE/ALTERs the least-privilege opensphere_backup role, granting it only
// CONNECT on the console database and pg_read_all_data. It never grants or elevates the
// constrained console runtime role, never touches OAA, deletes no data, and never uses
// kubectl exec (CONSTITUTION-0004 §4.5).
export const BACKUP_ROLE_RECONCILE_RESOURCE = 'setup-backup-role-reconcile';
export const BACKUP_ROLE = 'opensphere_backup';
export const BACKUP_ROLE_RECONCILE_ANNOTATION = 'opensphere.io/backup-role';
const BACKUP_ROLE_BOOTSTRAP_OPERATOR = 'opensphere_db_bootstrap';
const BACKUP_ROLE_DATABASE = 'console';
// A cert-SAN-matching host so verify-full validates: New-Certificates.ps1 issues the
// backbone-postgres leaf for backbone-postgres[.opensphere-backbone.svc[.cluster.local]].
const BACKUP_ROLE_POSTGRES_HOST = 'backbone-postgres.opensphere-backbone.svc.cluster.local';

// Static, secret-free reconcile SQL. The dedicated backup credential is pulled from the
// environment via \getenv (so it is never embedded here and never lands on a process
// argument) and applied through the injection-safe :'...' quoted-literal interpolation.
// The role is created (or realigned) with an explicit least-privilege attribute set and
// granted only read access; the constrained console runtime role is never referenced as a
// grantee or altered. NB: every psql backslash meta-command is written with a doubled
// backslash so the emitted file carries a single backslash.
export const BACKUP_ROLE_RECONCILE_SQL = [
  '\\set ON_ERROR_STOP on',
  '\\getenv backup_password BACKUP_PASSWORD',
  "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_backup') AS backup_role_exists \\gset",
  '\\if :backup_role_exists',
  'ALTER ROLE opensphere_backup LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :\'backup_password\';',
  '\\else',
  'CREATE ROLE opensphere_backup LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :\'backup_password\';',
  '\\endif',
  'GRANT CONNECT ON DATABASE console TO opensphere_backup;',
  'GRANT pg_read_all_data TO opensphere_backup;',
  ''
].join('\n');

// Fail-closed wait for PostgreSQL, then apply the reconcile SQL as the sealed bootstrap
// operator. The operator password reaches libpq only through PGPASSWORD in the process
// ENVIRONMENT -- never argv -- and the backup credential is handed to psql by \getenv.
export const BACKUP_ROLE_RECONCILE_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'export PGPASSWORD="$BOOTSTRAP_PASSWORD"',
  'attempt=0',
  'until pg_isready -q; do',
  '  attempt=$((attempt + 1))',
  '  if [ "$attempt" -ge 60 ]; then',
  '    echo "PostgreSQL did not become ready for the dedicated backup-role reconcile" >&2',
  '    exit 1',
  '  fi',
  '  sleep 5',
  'done',
  'exec psql -v ON_ERROR_STOP=1 --no-psqlrc -f /reconcile/reconcile.sql',
  ''
].join('\n');

function backupRoleReconcileAnnotations(lock) {
  return {
    [COMPATIBILITY_OVERLAY_ANNOTATION]: COMPATIBILITY_OVERLAY_VALUE,
    [BACKUP_ROLE_RECONCILE_ANNOTATION]: BACKUP_ROLE,
    'opensphere.io/overlay-release': lock.releaseDigest,
    'opensphere.io/overlay-source-revision': lock.sourceRevision
  };
}

// Setup-owned ConfigMap carrying the reconcile shell + SQL (no secrets), annotated for
// audit. The Job mounts it read-only.
export function buildBackupRoleReconcileConfigMap(lock) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: BACKUP_ROLE_RECONCILE_RESOURCE,
      namespace: 'opensphere-backbone',
      labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup' },
      annotations: backupRoleReconcileAnnotations(lock)
    },
    data: {
      'reconcile.sh': BACKUP_ROLE_RECONCILE_SCRIPT,
      'reconcile.sql': BACKUP_ROLE_RECONCILE_SQL
    }
  };
}

// Setup-owned one-shot Job, image-pinned to lock.components.cbsPostgresql.image EXACTLY.
// Hardened: automountServiceAccountToken false, restricted pod/container securityContext,
// read-only root fs (with a writable emptyDir /tmp for libpq), CA mounted from
// backbone-postgres/ca.crt for verify-full TLS, and both PostgreSQL credentials wired only
// as backbone-postgres secretKeyRefs (never inline literals, never argv).
export function buildBackupRoleReconcileJob(lock) {
  const image = lock.components.cbsPostgresql.image;
  const annotations = backupRoleReconcileAnnotations(lock);
  const labels = { 'app.kubernetes.io/managed-by': 'opensphere-setup' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: BACKUP_ROLE_RECONCILE_RESOURCE,
      namespace: 'opensphere-backbone',
      labels,
      annotations
    },
    spec: {
      backoffLimit: 2,
      activeDeadlineSeconds: 600,
      template: {
        metadata: { labels, annotations },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
            fsGroup: 999,
            seccompProfile: { type: 'RuntimeDefault' }
          },
          containers: [{
            name: 'reconcile',
            image,
            command: ['/bin/sh', '/reconcile/reconcile.sh'],
            workingDir: '/tmp',
            env: [
              { name: 'HOME', value: '/tmp' },
              { name: 'PGHOST', value: BACKUP_ROLE_POSTGRES_HOST },
              { name: 'PGPORT', value: '5432' },
              { name: 'PGDATABASE', value: BACKUP_ROLE_DATABASE },
              { name: 'PGUSER', value: BACKUP_ROLE_BOOTSTRAP_OPERATOR },
              { name: 'PGSSLMODE', value: 'verify-full' },
              { name: 'PGSSLROOTCERT', value: '/tls/ca.crt' },
              { name: 'BOOTSTRAP_PASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'bootstrap_password' } } },
              { name: 'BACKUP_PASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'backup_password' } } }
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] }
            },
            volumeMounts: [
              { name: 'reconcile', mountPath: '/reconcile', readOnly: true },
              { name: 'tls', mountPath: '/tls', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' }
            ]
          }],
          volumes: [
            { name: 'reconcile', configMap: { name: BACKUP_ROLE_RECONCILE_RESOURCE } },
            { name: 'tls', secret: { secretName: 'backbone-postgres', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
            { name: 'tmp', emptyDir: {} }
          ]
        }
      }
    }
  };
}

// The ordered manifests for the Setup-owned role reconcile: the ConfigMap first (so the
// Job's pod can mount the shell + SQL), then the image-pinned Job.
export function buildBackupRoleReconcileManifests(lock) {
  return [buildBackupRoleReconcileConfigMap(lock), buildBackupRoleReconcileJob(lock)];
}
