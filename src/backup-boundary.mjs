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
