import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_CRONJOB_RESOURCE,
  BACKUP_SCRIPTS_CONFIGMAP_RESOURCE,
  RESTORE_DRILL_CRONJOB_RESOURCE,
  COMPATIBILITY_OVERLAY_ANNOTATION,
  COMPATIBILITY_OVERLAY_VALUE,
  backupCronJobBackbonePostgresKeys,
  backbonePostgresEnvRefs,
  backupCronJobUsesDedicatedRole,
  backupScriptUsesDedicatedRole,
  backupBoundaryResourcesAreDedicated,
  backupBoundaryFullyDedicated,
  restoreDrillPreservesCredentialBoundary,
  buildCompatibilityOverlaySet,
  compatibilityBackupOverlay,
  retargetPostgresImage,
  sanitizeManifestMetadata,
  deriveDedicatedBackupScripts,
  deriveDedicatedBackupCronJob,
  deriveDedicatedRestoreDrill,
  buildBootstrapBackupBoundaryOverlaySet,
  planBootstrapBackupBoundary,
  BACKUP_ROLE_RECONCILE_RESOURCE,
  BACKUP_ROLE,
  BACKUP_ROLE_RECONCILE_SQL,
  BACKUP_ROLE_RECONCILE_SCRIPT,
  buildBackupRoleReconcileConfigMap,
  buildBackupRoleReconcileJob,
  buildBackupRoleReconcileManifests
} from '../src/backup-boundary.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POSTGRES = (character) => `ghcr.io/opensphere-platform/opensphere-cbs-postgresql@sha256:${character.repeat(64)}`;
const LIVE_IMAGE = POSTGRES('a');
const TARGET_IMAGE = POSTGRES('b');

// Realistic pg_dump backup script mounted from backbone-postgres-backup-scripts.
const DEDICATED_BACKUP_SH = [
  '#!/bin/sh',
  'set -eu',
  'export PGPASSWORD="$BACKUP_PASSWORD"',
  'pg_dump -h backbone-postgres -U opensphere_backup -d console --no-owner \\',
  '  | aws s3 cp - "s3://$BUCKET/audit-$(date +%s).sql"'
].join('\n');
// The regressed script an older signed release still ships: hardcoded to the
// constrained console runtime role.
const CONSOLE_BACKUP_SH = [
  '#!/bin/sh',
  'set -eu',
  'export PGPASSWORD="$CONSOLE_PASSWORD"',
  'pg_dump -h backbone-postgres -U console -d console --no-owner \\',
  '  | aws s3 cp - "s3://$BUCKET/audit-$(date +%s).sql"'
].join('\n');

function secretEnv(name, key) {
  return { name, valueFrom: { secretKeyRef: { name: 'backbone-postgres', key } } };
}

function backupEnv(...keys) {
  return keys.map((key, index) => secretEnv(`PG_${index}`, key));
}

// The realistic dedicated backup env: pg_dump reads its password from PGPASSWORD,
// bound to the dedicated backbone-postgres/backup_password credential.
function dedicatedBackupEnv() {
  return [secretEnv('PGPASSWORD', 'backup_password')];
}

function backupCronJob({ env = dedicatedBackupEnv(), image = LIVE_IMAGE, initEnv } = {}) {
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: BACKUP_CRONJOB_RESOURCE,
      namespace: 'opensphere-backbone',
      labels: { app: 'backbone-postgres-backup' },
      annotations: {
        'opensphere.io/keep': 'yes',
        'kubectl.kubernetes.io/last-applied-configuration': '{"stale":true}'
      },
      resourceVersion: '9001',
      uid: '11111111-2222-3333-4444-555555555555',
      creationTimestamp: '2026-01-01T00:00:00Z',
      generation: 7,
      managedFields: [{ manager: 'kubectl' }],
      ownerReferences: [{ kind: 'X', name: 'y' }]
    },
    spec: {
      schedule: '17 2 * * *',
      concurrencyPolicy: 'Forbid',
      jobTemplate: { spec: { template: { spec: {
        ...(initEnv ? { initContainers: [{ name: 'seed', image, env: initEnv }] } : {}),
        containers: [{ name: 'backup', image, env }]
      } } } }
    },
    status: { lastScheduleTime: '2026-07-14T02:17:00Z' }
  };
}

function backupScriptsConfigMap({ script = DEDICATED_BACKUP_SH } = {}) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: BACKUP_SCRIPTS_CONFIGMAP_RESOURCE, namespace: 'opensphere-backbone', resourceVersion: '5' },
    data: { 'backup.sh': script }
  };
}

// Mirrors the current canonical Console manifest restore-drill CronJob
// (OpenSphere-console/backend/backbone/bootstrap/backbone.yaml): it binds ONLY
// POSTGRES_PASSWORD -> backbone-postgres/bootstrap_password and intentionally wires
// NO PGPASSWORD env; restore-drill.sh consumes `PGPASSWORD="$POSTGRES_PASSWORD"`
// inline, so the read-only backup credential is absent from the Job entirely. Pass
// pgPassword to model a regressed older release that re-wires PGPASSWORD to a
// backbone-postgres credential (e.g. the console runtime `password` in dc272f4).
function restoreDrillCronJob({ pgPassword = null, postgresPassword = 'bootstrap_password', image = LIVE_IMAGE } = {}) {
  const env = [
    secretEnv('POSTGRES_PASSWORD', postgresPassword),
    { name: 'PGSSLMODE', value: 'verify-full' },
    { name: 'PGHOST', value: 'backbone-postgres' },
    // S3 target credentials live in a DIFFERENT secret and must not affect the boundary.
    { name: 'BACKUP_S3_ACCESS_KEY', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'access_key' } } }
  ];
  if (pgPassword) env.unshift(secretEnv('PGPASSWORD', pgPassword));
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: RESTORE_DRILL_CRONJOB_RESOURCE,
      namespace: 'opensphere-backbone',
      resourceVersion: '7'
    },
    spec: {
      schedule: '0 0 31 2 *',
      suspend: true,
      concurrencyPolicy: 'Forbid',
      jobTemplate: { spec: { template: { spec: {
        containers: [{ name: 'restore-drill', image, env }]
      } } } }
    },
    status: {}
  };
}

const lock = {
  releaseDigest: 'sha256:deadbeef',
  sourceRevision: 'c'.repeat(40),
  components: { cbsPostgresql: { image: TARGET_IMAGE } }
};

test('backupCronJobBackbonePostgresKeys collects only backbone-postgres secretKeyRef keys, across init and main containers', () => {
  const job = backupCronJob({ env: backupEnv('backup_password'), initEnv: backupEnv('bootstrap_password') });
  job.spec.jobTemplate.spec.template.spec.containers[0].env.push({
    name: 'OTHER', valueFrom: { secretKeyRef: { name: 'some-other-secret', key: 'password' } }
  });
  assert.deepEqual(backupCronJobBackbonePostgresKeys(job).sort(), ['backup_password', 'bootstrap_password']);
});

test('backupCronJobUsesDedicatedRole requires PGPASSWORD=backup_password and rejects any console password ref', () => {
  // pg_dump authenticates via PGPASSWORD bound to the dedicated backup credential.
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({ env: [secretEnv('PGPASSWORD', 'backup_password')] })), true);
  // PGPASSWORD bound to the console runtime `password` key must fail closed.
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({ env: [secretEnv('PGPASSWORD', 'password')] })), false);
  // A mixed CronJob whose PGPASSWORD is dedicated but which still consumes the console
  // `password` key on any other env var must fail closed.
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({
    env: [secretEnv('PGPASSWORD', 'backup_password'), secretEnv('AUX', 'password')]
  })), false);
  // Negative: an unrelated env var references backup_password, but PGPASSWORD is ABSENT --
  // referencing the credential does not prove pg_dump authenticates with it.
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({ env: [secretEnv('AUDIT_PW', 'backup_password')] })), false);
  // Negative: backup_password is referenced but PGPASSWORD is a literal, not the secret.
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({
    env: [{ name: 'PGPASSWORD', value: 'literal-not-a-secret' }, secretEnv('AUDIT_PW', 'backup_password')]
  })), false);
  // Negative: backup_password is referenced but PGPASSWORD points elsewhere (bootstrap).
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({
    env: [secretEnv('PGPASSWORD', 'bootstrap_password'), secretEnv('AUDIT_PW', 'backup_password')]
  })), false);
  assert.equal(backupCronJobUsesDedicatedRole(backupCronJob({ env: [] })), false);
  assert.equal(backupCronJobUsesDedicatedRole(null), false);
});

test('backupScriptUsesDedicatedRole proves pg_dump runs as opensphere_backup and excludes -U console', () => {
  assert.equal(backupScriptUsesDedicatedRole(backupScriptsConfigMap()), true);
  assert.equal(backupScriptUsesDedicatedRole(backupScriptsConfigMap({ script: CONSOLE_BACKUP_SH })), false);
  // --username=console / --username console forms are rejected too.
  assert.equal(backupScriptUsesDedicatedRole(backupScriptsConfigMap({ script: 'pg_dump --username=console -d console' })), false);
  assert.equal(backupScriptUsesDedicatedRole(backupScriptsConfigMap({ script: 'pg_dump --username opensphere_backup -d console' })), true);
  // A script that never invokes pg_dump as opensphere_backup fails closed.
  assert.equal(backupScriptUsesDedicatedRole(backupScriptsConfigMap({ script: 'echo hello' })), false);
  // A companion key (restore.sh) that reintroduces -U console fails the whole ConfigMap closed.
  const withConsoleCompanion = backupScriptsConfigMap();
  withConsoleCompanion.data['restore.sh'] = 'psql -U console -d scratch';
  assert.equal(backupScriptUsesDedicatedRole(withConsoleCompanion), false);
  assert.equal(backupScriptUsesDedicatedRole({ data: {} }), false);
  assert.equal(backupScriptUsesDedicatedRole(null), false);
});

test('backupBoundaryResourcesAreDedicated is a resource-set predicate: both halves must be dedicated', () => {
  assert.equal(backupBoundaryResourcesAreDedicated({
    cronJob: backupCronJob(), configMap: backupScriptsConfigMap()
  }), true);
  // Regression: CronJob already binds backup_password but the ConfigMap script still runs -U console.
  assert.equal(backupBoundaryResourcesAreDedicated({
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap({ script: CONSOLE_BACKUP_SH })
  }), false);
  // Regression: dedicated script but the CronJob still consumes the console `password` key.
  assert.equal(backupBoundaryResourcesAreDedicated({
    cronJob: backupCronJob({ env: [secretEnv('PGPASSWORD', 'password')] }),
    configMap: backupScriptsConfigMap()
  }), false);
  // Missing either resource fails closed.
  assert.equal(backupBoundaryResourcesAreDedicated({ cronJob: backupCronJob(), configMap: null }), false);
  assert.equal(backupBoundaryResourcesAreDedicated({ cronJob: null, configMap: backupScriptsConfigMap() }), false);
  assert.equal(backupBoundaryResourcesAreDedicated(), false);
});

test('restoreDrillPreservesCredentialBoundary requires POSTGRES_PASSWORD=bootstrap_password, PGPASSWORD absent, and no console password ref', () => {
  // Canonical current contract: sealed bootstrap operator only, PGPASSWORD unwired.
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrillCronJob()), true);
  // Regression (dc272f4): PGPASSWORD re-wired to the console runtime `password`.
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrillCronJob({ pgPassword: 'password' })), false);
  // Regression: PGPASSWORD wired to the read-only backup credential -- least exposure
  // means the restore drill must not carry the backup read credential at all.
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrillCronJob({ pgPassword: 'backup_password' })), false);
  // POSTGRES_PASSWORD must remain the bootstrap operator credential.
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrillCronJob({ postgresPassword: 'password' })), false);
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrillCronJob({ postgresPassword: 'backup_password' })), false);
  // Any backbone-postgres `password` ref anywhere fails closed, even on an aux var.
  const withConsolePasswordAux = restoreDrillCronJob();
  withConsolePasswordAux.spec.jobTemplate.spec.template.spec.containers[0].env.push(secretEnv('AUX', 'password'));
  assert.equal(restoreDrillPreservesCredentialBoundary(withConsolePasswordAux), false);
  assert.equal(restoreDrillPreservesCredentialBoundary(null), false);
});

// Manifest contract: mirror the EXACT env block of the current canonical Console
// restore-drill CronJob (OpenSphere-console/backend/backbone/bootstrap/backbone.yaml).
// Reading the sibling repo directly is brittle (path layout, YAML parsing, CI), so we
// pin the contract as an inline fixture: POSTGRES_PASSWORD binds the sealed bootstrap
// operator, PGPASSWORD is intentionally ABSENT (restore-drill.sh uses an inline
// `PGPASSWORD="$POSTGRES_PASSWORD"` only), and the S3 target credentials come from a
// different secret. The canonical contract must classify true; the historical
// dc272f4 form (PGPASSWORD=password) and any backup_password wiring must classify
// false so a real downgrade produces a compatibility overlay.
test('canonical Console restore-drill manifest contract: bootstrap-only env classifies true; PGPASSWORD=password/backup_password classify false', () => {
  const canonicalEnv = [
    { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'bootstrap_password' } } },
    { name: 'PGSSLMODE', value: 'verify-full' },
    { name: 'PGSSLROOTCERT', value: '/tls/ca.crt' },
    { name: 'BACKUP_S3_ACCESS_KEY', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'access_key' } } },
    { name: 'BACKUP_S3_SECRET_KEY', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'secret_key' } } },
    { name: 'BACKUP_S3_ENDPOINT', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'endpoint' } } },
    { name: 'BACKUP_S3_BUCKET', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'bucket' } } },
    { name: 'BACKUP_S3_REGION', valueFrom: { secretKeyRef: { name: 'backbone-postgres-backup-target', key: 'region' } } }
  ];
  const drillFromEnv = (env) => ({
    apiVersion: 'batch/v1', kind: 'CronJob',
    metadata: { name: RESTORE_DRILL_CRONJOB_RESOURCE, namespace: 'opensphere-backbone' },
    spec: { suspend: true, concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: {
      containers: [{ name: 'restore-drill', image: LIVE_IMAGE, env }]
    } } } } }
  });
  // Canonical: no PGPASSWORD wired anywhere -> boundary preserved.
  const canonical = drillFromEnv(canonicalEnv);
  assert.equal(backbonePostgresEnvRefs(canonical).PGPASSWORD, undefined, 'canonical manifest wires no PGPASSWORD');
  assert.equal(restoreDrillPreservesCredentialBoundary(canonical), true);
  // Negative: historical dc272f4 restore drill wired PGPASSWORD -> console runtime `password`.
  const consolePassword = drillFromEnv([
    { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'password' } } },
    ...canonicalEnv
  ]);
  assert.equal(restoreDrillPreservesCredentialBoundary(consolePassword), false);
  // Negative: PGPASSWORD wired -> read-only backup_password (unused credential must be absent).
  const backupPassword = drillFromEnv([
    { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'backup_password' } } },
    ...canonicalEnv
  ]);
  assert.equal(restoreDrillPreservesCredentialBoundary(backupPassword), false);
});

test('backupBoundaryFullyDedicated requires all three resources; a regressed restore drill fails closed', () => {
  assert.equal(backupBoundaryFullyDedicated({
    cronJob: backupCronJob(), configMap: backupScriptsConfigMap(), restoreDrill: restoreDrillCronJob()
  }), true);
  // Regression that gap 2 closes: the backup CronJob and script are BOTH dedicated, but the
  // restore drill has regressed its PGPASSWORD to the console runtime `password`. The full
  // boundary must fail closed so this cannot be trusted (in releaseProvidesDedicatedBackupBoundary,
  // that false is exactly what forces the compatibility overlay).
  assert.equal(backupBoundaryFullyDedicated({
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap(),
    restoreDrill: restoreDrillCronJob({ pgPassword: 'password' })
  }), false);
  // A missing restore drill is not a dedicated boundary.
  assert.equal(backupBoundaryFullyDedicated({ cronJob: backupCronJob(), configMap: backupScriptsConfigMap() }), false);
  // Either of the other two halves regressing still fails closed even with a dedicated restore drill.
  assert.equal(backupBoundaryFullyDedicated({
    cronJob: backupCronJob({ env: [secretEnv('PGPASSWORD', 'password')] }),
    configMap: backupScriptsConfigMap(),
    restoreDrill: restoreDrillCronJob()
  }), false);
  assert.equal(backupBoundaryFullyDedicated({
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap({ script: CONSOLE_BACKUP_SH }),
    restoreDrill: restoreDrillCronJob()
  }), false);
  assert.equal(backupBoundaryFullyDedicated(), false);
});

test('backbonePostgresEnvRefs maps env-var names to their backbone-postgres secret keys, ignoring other secrets', () => {
  // The canonical restore drill binds only POSTGRES_PASSWORD to backbone-postgres; its
  // S3 target credentials reference a different secret and must be excluded.
  assert.deepEqual(backbonePostgresEnvRefs(restoreDrillCronJob()), {
    POSTGRES_PASSWORD: 'bootstrap_password'
  });
  // A regressed drill that re-wires PGPASSWORD is surfaced so the predicate can reject it.
  assert.deepEqual(backbonePostgresEnvRefs(restoreDrillCronJob({ pgPassword: 'password' })), {
    PGPASSWORD: 'password',
    POSTGRES_PASSWORD: 'bootstrap_password'
  });
});

test('sanitizeManifestMetadata strips server-managed metadata, status and the last-applied annotation but keeps declarative fields', () => {
  const clean = sanitizeManifestMetadata(backupCronJob());
  for (const field of ['resourceVersion', 'uid', 'creationTimestamp', 'generation', 'managedFields', 'ownerReferences']) {
    assert.equal(field in clean.metadata, false, `${field} must be stripped`);
  }
  assert.equal('status' in clean, false);
  assert.equal('kubectl.kubernetes.io/last-applied-configuration' in clean.metadata.annotations, false);
  assert.equal(clean.metadata.annotations['opensphere.io/keep'], 'yes');
  assert.deepEqual(clean.metadata.labels, { app: 'backbone-postgres-backup' });
  assert.equal(clean.metadata.name, BACKUP_CRONJOB_RESOURCE);
});

test('sanitizeManifestMetadata does not mutate the captured source resource', () => {
  const source = backupCronJob();
  sanitizeManifestMetadata(source);
  assert.equal(source.metadata.uid, '11111111-2222-3333-4444-555555555555');
  assert.ok(source.status);
});

test('retargetPostgresImage swaps only the digest-pinned cbsPostgresql image, leaving other images untouched', () => {
  const job = backupCronJob({ image: LIVE_IMAGE, initEnv: backupEnv('bootstrap_password') });
  job.spec.jobTemplate.spec.template.spec.containers.push({ name: 'sidecar', image: 'ghcr.io/opensphere-platform/opensphere-cbs-rustfs@sha256:' + 'f'.repeat(64) });
  retargetPostgresImage(job, TARGET_IMAGE);
  const spec = job.spec.jobTemplate.spec.template.spec;
  assert.equal(spec.containers[0].image, TARGET_IMAGE);
  assert.equal(spec.initContainers[0].image, TARGET_IMAGE);
  assert.equal(spec.containers[1].image, 'ghcr.io/opensphere-platform/opensphere-cbs-rustfs@sha256:' + 'f'.repeat(64));
});

test('compatibilityBackupOverlay pins the applied release image, annotates the overlay, and preserves the dedicated role (no privilege regression)', () => {
  const overlay = compatibilityBackupOverlay(backupCronJob(), lock, TARGET_IMAGE);
  assert.equal(overlay.spec.jobTemplate.spec.template.spec.containers[0].image, TARGET_IMAGE, 'target cbsPostgresql digest must remain used');
  assert.equal(overlay.metadata.annotations[COMPATIBILITY_OVERLAY_ANNOTATION], COMPATIBILITY_OVERLAY_VALUE);
  assert.equal(overlay.metadata.annotations['opensphere.io/overlay-release'], lock.releaseDigest);
  assert.equal(overlay.metadata.annotations['opensphere.io/overlay-source-revision'], lock.sourceRevision);
  // The overlay must still authenticate as opensphere_backup and never reintroduce the console `password` key.
  assert.equal(backupCronJobUsesDedicatedRole(overlay), true);
  assert.equal(backupCronJobBackbonePostgresKeys(overlay).includes('password'), false);
  // Server-managed metadata is gone so the overlay is applyable as a clean manifest.
  assert.equal('resourceVersion' in overlay.metadata, false);
});

test('compatibilityBackupOverlay leaves the scripts ConfigMap script untouched except for its overlay annotations', () => {
  const overlay = compatibilityBackupOverlay(backupScriptsConfigMap(), lock, TARGET_IMAGE);
  assert.deepEqual(overlay.data, { 'backup.sh': DEDICATED_BACKUP_SH });
  assert.equal(backupScriptUsesDedicatedRole(overlay), true);
  assert.equal(overlay.metadata.annotations[COMPATIBILITY_OVERLAY_ANNOTATION], COMPATIBILITY_OVERLAY_VALUE);
  assert.equal('resourceVersion' in overlay.metadata, false);
});

test('compatibilityBackupOverlay retargets the restore-drill image and preserves its credential boundary (bootstrap-only, no exposed backup/console read credential)', () => {
  const overlay = compatibilityBackupOverlay(restoreDrillCronJob(), lock, TARGET_IMAGE);
  assert.equal(overlay.spec.jobTemplate.spec.template.spec.containers[0].image, TARGET_IMAGE);
  assert.equal(overlay.spec.suspend, true, 'the restore drill must remain suspended');
  assert.equal(restoreDrillPreservesCredentialBoundary(overlay), true);
  // The overlaid drill keeps POSTGRES_PASSWORD on the sealed bootstrap operator and wires no PGPASSWORD.
  assert.deepEqual(backbonePostgresEnvRefs(overlay), { POSTGRES_PASSWORD: 'bootstrap_password' });
  // The rollback must never re-expose the console runtime `password` to the restore job.
  assert.equal(Object.values(backbonePostgresEnvRefs(overlay)).includes('password'), false);
});

test('buildCompatibilityOverlaySet overlays ConfigMap, backup CronJob and restore drill in dependency order, each image-retargeted', () => {
  const boundary = {
    dedicated: true,
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap(),
    restoreDrill: restoreDrillCronJob()
  };
  const overlays = buildCompatibilityOverlaySet(boundary, lock, TARGET_IMAGE);
  assert.deepEqual(overlays.map((overlay) => `${overlay.kind}/${overlay.metadata.name}`), [
    `ConfigMap/${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}`,
    `CronJob/${BACKUP_CRONJOB_RESOURCE}`,
    `CronJob/${RESTORE_DRILL_CRONJOB_RESOURCE}`
  ]);
  // Every overlay is a clean, annotated, image-retargeted manifest.
  for (const overlay of overlays) {
    assert.equal(overlay.metadata.annotations[COMPATIBILITY_OVERLAY_ANNOTATION], COMPATIBILITY_OVERLAY_VALUE);
    assert.equal('resourceVersion' in overlay.metadata, false);
  }
  for (const overlay of overlays.filter((o) => o.kind === 'CronJob')) {
    assert.equal(overlay.spec.jobTemplate.spec.template.spec.containers[0].image, TARGET_IMAGE);
  }
  // Absent resources are skipped without error.
  assert.deepEqual(buildCompatibilityOverlaySet({ configMap: backupScriptsConfigMap() }, lock, TARGET_IMAGE)
    .map((overlay) => `${overlay.kind}/${overlay.metadata.name}`), [`ConfigMap/${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}`]);
});

// bootstrap.mjs must fail closed on either half of the boundary and preserve the
// restore drill, using the three distinct real resource identities.
test('bootstrap reasserts the boundary from three distinct resource identities and fails closed on either half', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(source, /BACKUP_CRONJOB_RESOURCE = 'backbone-postgres-backup'|BACKUP_CRONJOB_RESOURCE,/);
  // captureBackupBoundary snapshots the scripts ConfigMap under its REAL name and the restore drill.
  const capture = source.match(/function captureBackupBoundary\(\)[\s\S]*?\n\}/);
  assert.ok(capture, 'captureBackupBoundary must be defined');
  assert.match(capture[0], /readOptionalBackboneResource\('configmap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE\)/,
    'the scripts ConfigMap must be snapshotted under backbone-postgres-backup-scripts, not backbone-postgres-backup');
  assert.match(capture[0], /readOptionalBackboneResource\('cronjob', RESTORE_DRILL_CRONJOB_RESOURCE\)/,
    'the restore drill CronJob must be part of the captured boundary');
  assert.match(capture[0], /backupBoundaryFullyDedicated\(\{ cronJob, configMap, restoreDrill \}\)/,
    'the dedicated flag must be the full predicate over the CronJob, the ConfigMap AND the restore drill');
  // releaseProvidesDedicatedBackupBoundary must check all three halves so a regressed restore
  // drill (or console-script) in the applied release is overlaid rather than trusted.
  const provides = source.match(/function releaseProvidesDedicatedBackupBoundary\(release\)[\s\S]*?\n\}/);
  assert.ok(provides, 'releaseProvidesDedicatedBackupBoundary must be defined');
  assert.match(provides[0], /decodeReleaseResource\(release, 'ConfigMap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE\)/);
  assert.match(provides[0], /decodeReleaseResource\(release, 'CronJob', RESTORE_DRILL_CRONJOB_RESOURCE\)/,
    'the release restore drill must be decoded so its credential is checked');
  assert.match(provides[0], /backupBoundaryFullyDedicated\(\{ cronJob, configMap, restoreDrill \}\)/);
});

// verify.mjs must fail closed once this Setup version has established the boundary.
test('verifyRecovery fails closed on the backup CronJob credential, the ConfigMap script user, and the restore-drill credential', async () => {
  const source = await readFile(join(ROOT, 'src', 'verify.mjs'), 'utf8');
  assert.match(source, /backupCronJobUsesDedicatedRole,\s*\n\s*backupScriptUsesDedicatedRole,\s*\n\s*restoreDrillPreservesCredentialBoundary/);
  const match = source.match(/function verifyRecovery\(\{[\s\S]*?\n\}/);
  assert.ok(match, 'verifyRecovery must be defined');
  assert.match(match[0], /getJson\(\['-n', 'opensphere-backbone', 'get', 'configmap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE\]\)/,
    'verifyRecovery must read the backup-scripts ConfigMap by its real name');
  assert.match(match[0], /if \(!backupCronJobUsesDedicatedRole\(backup\)\)/,
    'verifyRecovery must gate on the live backup CronJob using the dedicated backup role');
  assert.match(match[0], /throw new Error\('PostgreSQL audit backup CronJob does not authenticate as the dedicated opensphere_backup role/);
  assert.match(match[0], /if \(!backupScriptUsesDedicatedRole\(backupScripts\)\)/,
    'verifyRecovery must gate on the live backup script running pg_dump as opensphere_backup');
  assert.match(match[0], /if \(!restoreDrillPreservesCredentialBoundary\(drill\)\)/,
    'verifyRecovery must gate on the restore drill preserving its credential boundary');
});

// ---------------------------------------------------------------------------
// Clean-bootstrap derivation of the dedicated boundary from a regressed release.
// ---------------------------------------------------------------------------

// A historical scripts ConfigMap that also carries a companion script running psql as
// the console role -- the whole ConfigMap must be transformed, not just backup.sh.
function historicalScriptsConfigMap() {
  const configMap = backupScriptsConfigMap({ script: CONSOLE_BACKUP_SH });
  configMap.data['verify.sh'] = 'psql -U console -d console -Atc "SELECT count(*) FROM audit_log"';
  return configMap;
}

test('deriveDedicatedBackupScripts rewrites every console-role pg_dump/psql to opensphere_backup and preserves the -d console database', () => {
  const dedicated = deriveDedicatedBackupScripts(historicalScriptsConfigMap());
  assert.equal(backupScriptUsesDedicatedRole(dedicated), true);
  // The authenticating role is rewritten in every script value...
  assert.match(dedicated.data['backup.sh'], /pg_dump[^\n]*-U opensphere_backup\b/);
  assert.match(dedicated.data['verify.sh'], /psql -U opensphere_backup\b/);
  // ...but the -d console DATABASE argument is never touched.
  assert.match(dedicated.data['backup.sh'], /-d console\b/);
  assert.doesNotMatch(dedicated.data['backup.sh'], /-U console\b/);
});

test('deriveDedicatedBackupScripts handles the --username=console and --username console forms', () => {
  const equals = deriveDedicatedBackupScripts(backupScriptsConfigMap({ script: 'pg_dump --username=console -d console' }));
  assert.equal(equals.data['backup.sh'], 'pg_dump --username=opensphere_backup -d console');
  const spaced = deriveDedicatedBackupScripts(backupScriptsConfigMap({ script: 'pg_dump --username console -d console' }));
  assert.equal(spaced.data['backup.sh'], 'pg_dump --username opensphere_backup -d console');
});

test('deriveDedicatedBackupScripts is idempotent on an already-dedicated ConfigMap', () => {
  const dedicated = deriveDedicatedBackupScripts(backupScriptsConfigMap());
  assert.deepEqual(dedicated.data, { 'backup.sh': DEDICATED_BACKUP_SH });
  assert.equal(backupScriptUsesDedicatedRole(dedicated), true);
});

test('deriveDedicatedBackupScripts fails closed when pg_dump supplies no inline role flag (rather than patching shell text)', () => {
  // The role is carried in an env var, so no console flag exists to rewrite and the result
  // cannot be proven dedicated; fail closed instead of injecting a flag.
  assert.throws(
    () => deriveDedicatedBackupScripts(backupScriptsConfigMap({ script: 'export PGUSER=console\npg_dump -d console' })),
    /Cannot derive dedicated backbone-postgres-backup-scripts: script does not run pg_dump as opensphere_backup/
  );
  // A present-but-empty data map reaches the postcondition (no pg_dump at all).
  assert.throws(() => deriveDedicatedBackupScripts({ data: {} }), /does not run pg_dump as opensphere_backup/);
  // A ConfigMap with no data map at all fails on the earlier guard.
  assert.throws(() => deriveDedicatedBackupScripts({}), /no script data to transform/);
  assert.throws(() => deriveDedicatedBackupScripts(null), /no script data to transform/);
});

test('deriveDedicatedBackupScripts does not mutate the captured source ConfigMap', () => {
  const source = backupScriptsConfigMap({ script: CONSOLE_BACKUP_SH });
  deriveDedicatedBackupScripts(source);
  assert.equal(source.data['backup.sh'], CONSOLE_BACKUP_SH);
});

test('deriveDedicatedBackupCronJob repoints PGPASSWORD (and any console password ref) to backup_password across all containers', () => {
  // Regressed release: PGPASSWORD binds the console runtime `password` key on the main
  // container and a seed init container also references it.
  const regressed = backupCronJob({
    env: [secretEnv('PGPASSWORD', 'password'), secretEnv('AUX', 'password')],
    initEnv: [secretEnv('SEED_PW', 'password')]
  });
  const dedicated = deriveDedicatedBackupCronJob(regressed);
  assert.equal(backupCronJobUsesDedicatedRole(dedicated), true);
  assert.equal(backupCronJobBackbonePostgresKeys(dedicated).includes('password'), false);
  assert.deepEqual(backbonePostgresEnvRefs(dedicated), {
    PGPASSWORD: 'backup_password', AUX: 'backup_password', SEED_PW: 'backup_password'
  });
});

test('deriveDedicatedBackupCronJob is idempotent on an already-dedicated CronJob', () => {
  const dedicated = deriveDedicatedBackupCronJob(backupCronJob());
  assert.equal(backupCronJobUsesDedicatedRole(dedicated), true);
  assert.deepEqual(backbonePostgresEnvRefs(dedicated), { PGPASSWORD: 'backup_password' });
});

test('deriveDedicatedBackupCronJob fails closed when PGPASSWORD is absent or a non-backbone-postgres value', () => {
  // A credential is referenced but PGPASSWORD itself is absent -- cannot be made dedicated safely.
  assert.throws(
    () => deriveDedicatedBackupCronJob(backupCronJob({ env: [secretEnv('AUDIT_PW', 'password')] })),
    /Cannot derive dedicated backbone-postgres-backup: PGPASSWORD is not bound to a backbone-postgres credential/
  );
  // PGPASSWORD is a literal, not a Secret ref.
  assert.throws(
    () => deriveDedicatedBackupCronJob(backupCronJob({ env: [{ name: 'PGPASSWORD', value: 'literal' }] })),
    /PGPASSWORD is not bound to a backbone-postgres credential/
  );
  assert.throws(() => deriveDedicatedBackupCronJob(null), /PGPASSWORD is not bound/);
});

test('deriveDedicatedBackupCronJob does not mutate the captured source CronJob', () => {
  const source = backupCronJob({ env: [secretEnv('PGPASSWORD', 'password')] });
  deriveDedicatedBackupCronJob(source);
  assert.deepEqual(backbonePostgresEnvRefs(source), { PGPASSWORD: 'password' });
});

test('deriveDedicatedRestoreDrill drops the exposed PGPASSWORD and pins POSTGRES_PASSWORD to bootstrap_password', () => {
  // Regressed drill wiring PGPASSWORD -> console `password` and POSTGRES_PASSWORD -> `password`.
  const dedicated = deriveDedicatedRestoreDrill(restoreDrillCronJob({ pgPassword: 'password', postgresPassword: 'password' }));
  assert.equal(restoreDrillPreservesCredentialBoundary(dedicated), true);
  assert.deepEqual(backbonePostgresEnvRefs(dedicated), { POSTGRES_PASSWORD: 'bootstrap_password' });
  // The S3 target credential (a DIFFERENT secret) is preserved untouched.
  const env = dedicated.spec.jobTemplate.spec.template.spec.containers[0].env;
  const s3 = env.find((entry) => entry.name === 'BACKUP_S3_ACCESS_KEY');
  assert.equal(s3?.valueFrom?.secretKeyRef?.name, 'backbone-postgres-backup-target');
});

test('deriveDedicatedRestoreDrill also drops a PGPASSWORD wired to the read-only backup credential', () => {
  const dedicated = deriveDedicatedRestoreDrill(restoreDrillCronJob({ pgPassword: 'backup_password' }));
  assert.equal(restoreDrillPreservesCredentialBoundary(dedicated), true);
  assert.equal('PGPASSWORD' in backbonePostgresEnvRefs(dedicated), false);
});

test('deriveDedicatedRestoreDrill is idempotent on the canonical bootstrap-only drill', () => {
  const dedicated = deriveDedicatedRestoreDrill(restoreDrillCronJob());
  assert.equal(restoreDrillPreservesCredentialBoundary(dedicated), true);
  assert.deepEqual(backbonePostgresEnvRefs(dedicated), { POSTGRES_PASSWORD: 'bootstrap_password' });
});

test('deriveDedicatedRestoreDrill fails closed when POSTGRES_PASSWORD is not a backbone-postgres credential', () => {
  const noBootstrap = {
    apiVersion: 'batch/v1', kind: 'CronJob',
    metadata: { name: RESTORE_DRILL_CRONJOB_RESOURCE, namespace: 'opensphere-backbone' },
    spec: { suspend: true, jobTemplate: { spec: { template: { spec: {
      containers: [{ name: 'restore-drill', image: LIVE_IMAGE, env: [secretEnv('PGPASSWORD', 'password')] }]
    } } } } }
  };
  assert.throws(
    () => deriveDedicatedRestoreDrill(noBootstrap),
    /Cannot derive dedicated backbone-postgres-restore-drill: POSTGRES_PASSWORD is not bound to a backbone-postgres credential/
  );
  assert.throws(() => deriveDedicatedRestoreDrill(null), /POSTGRES_PASSWORD is not bound/);
});

test('deriveDedicatedRestoreDrill does not mutate the captured source CronJob', () => {
  const source = restoreDrillCronJob({ pgPassword: 'password' });
  deriveDedicatedRestoreDrill(source);
  assert.deepEqual(backbonePostgresEnvRefs(source), { PGPASSWORD: 'password', POSTGRES_PASSWORD: 'bootstrap_password' });
});

// A fully regressed historical release resource set: every one of the three resources
// predates the dedicated boundary and is pinned to the LIVE (historical) image.
function regressedReleaseResources() {
  return {
    configMap: historicalScriptsConfigMap(),
    cronJob: backupCronJob({ env: [secretEnv('PGPASSWORD', 'password')], image: LIVE_IMAGE }),
    restoreDrill: restoreDrillCronJob({ pgPassword: 'password', image: LIVE_IMAGE })
  };
}

test('buildBootstrapBackupBoundaryOverlaySet derives all three dedicated resources, ConfigMap first, each image-pinned and annotated', () => {
  const overlays = buildBootstrapBackupBoundaryOverlaySet(regressedReleaseResources(), lock, TARGET_IMAGE);
  assert.deepEqual(overlays.map((overlay) => `${overlay.kind}/${overlay.metadata.name}`), [
    `ConfigMap/${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}`,
    `CronJob/${BACKUP_CRONJOB_RESOURCE}`,
    `CronJob/${RESTORE_DRILL_CRONJOB_RESOURCE}`
  ]);
  const [configMap, cronJob, restoreDrill] = overlays;
  // Every overlay is dedicated after derivation -- verifyRecovery would accept them.
  assert.equal(backupScriptUsesDedicatedRole(configMap), true);
  assert.equal(backupCronJobUsesDedicatedRole(cronJob), true);
  assert.equal(restoreDrillPreservesCredentialBoundary(restoreDrill), true);
  // No privilege regression: the console runtime `password` is never re-exposed.
  assert.equal(backupCronJobBackbonePostgresKeys(cronJob).includes('password'), false);
  assert.equal(Object.values(backbonePostgresEnvRefs(restoreDrill)).includes('password'), false);
  // Every CronJob is retargeted to the applied release's cbsPostgresql digest, not the
  // historical LIVE image, and every overlay carries the audit annotations.
  for (const overlay of overlays) {
    assert.equal(overlay.metadata.annotations[COMPATIBILITY_OVERLAY_ANNOTATION], COMPATIBILITY_OVERLAY_VALUE);
    assert.equal(overlay.metadata.annotations['opensphere.io/overlay-release'], lock.releaseDigest);
    assert.equal(overlay.metadata.annotations['opensphere.io/overlay-source-revision'], lock.sourceRevision);
    assert.equal('resourceVersion' in overlay.metadata, false);
  }
  for (const overlay of [cronJob, restoreDrill]) {
    assert.equal(overlay.spec.jobTemplate.spec.template.spec.containers[0].image, TARGET_IMAGE);
  }
  assert.equal(restoreDrill.spec.suspend, true, 'the restore drill must remain suspended');
});

test('buildBootstrapBackupBoundaryOverlaySet fails closed with a precise error when any of the three resources is missing', () => {
  const base = regressedReleaseResources();
  assert.throws(() => buildBootstrapBackupBoundaryOverlaySet({ ...base, configMap: null }, lock, TARGET_IMAGE),
    /release is missing ConfigMap backbone-postgres-backup-scripts/);
  assert.throws(() => buildBootstrapBackupBoundaryOverlaySet({ ...base, cronJob: null }, lock, TARGET_IMAGE),
    /release is missing CronJob backbone-postgres-backup\b/);
  assert.throws(() => buildBootstrapBackupBoundaryOverlaySet({ ...base, restoreDrill: null }, lock, TARGET_IMAGE),
    /release is missing CronJob backbone-postgres-restore-drill/);
  assert.throws(() => buildBootstrapBackupBoundaryOverlaySet(undefined, lock, TARGET_IMAGE),
    /release is missing ConfigMap/);
});

test('planBootstrapBackupBoundary is a no-op when the release already ships all three dedicated resources', () => {
  const dedicated = {
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap(),
    restoreDrill: restoreDrillCronJob()
  };
  assert.deepEqual(planBootstrapBackupBoundary(dedicated, lock, TARGET_IMAGE), []);
});

test('planBootstrapBackupBoundary overlays all three when any single resource regresses (a historical lock)', () => {
  // Only the restore drill regresses; the plan still re-establishes the full ordered set.
  const partiallyRegressed = {
    cronJob: backupCronJob(),
    configMap: backupScriptsConfigMap(),
    restoreDrill: restoreDrillCronJob({ pgPassword: 'password' })
  };
  const plan = planBootstrapBackupBoundary(partiallyRegressed, lock, TARGET_IMAGE);
  assert.deepEqual(plan.map((overlay) => `${overlay.kind}/${overlay.metadata.name}`), [
    `ConfigMap/${BACKUP_SCRIPTS_CONFIGMAP_RESOURCE}`,
    `CronJob/${BACKUP_CRONJOB_RESOURCE}`,
    `CronJob/${RESTORE_DRILL_CRONJOB_RESOURCE}`
  ]);
  // A fully regressed historical release produces the same complete overlay set.
  assert.equal(planBootstrapBackupBoundary(regressedReleaseResources(), lock, TARGET_IMAGE).length, 3);
});

test('the Setup-owned backup-role reconcile is image-pinned, TLS-verified, hardened, and secret-backed', () => {
  const [configMap, job] = buildBackupRoleReconcileManifests(lock);
  assert.equal(configMap.kind, 'ConfigMap');
  assert.equal(configMap.metadata.name, BACKUP_ROLE_RECONCILE_RESOURCE);
  assert.equal(job.kind, 'Job');
  assert.equal(job.metadata.name, BACKUP_ROLE_RECONCILE_RESOURCE);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(job.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault');
  const container = job.spec.template.spec.containers[0];
  assert.equal(container.image, TARGET_IMAGE);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry]));
  assert.equal(env.PGSSLMODE.value, 'verify-full');
  assert.equal(env.PGSSLROOTCERT.value, '/tls/ca.crt');
  assert.deepEqual(env.BOOTSTRAP_PASSWORD.valueFrom.secretKeyRef,
    { name: 'backbone-postgres', key: 'bootstrap_password' });
  assert.deepEqual(env.BACKUP_PASSWORD.valueFrom.secretKeyRef,
    { name: 'backbone-postgres', key: 'backup_password' });
  assert.deepEqual(job.spec.template.spec.volumes.find((volume) => volume.name === 'tls').secret,
    { secretName: 'backbone-postgres', items: [{ key: 'ca.crt', path: 'ca.crt' }] });
  for (const resource of [configMap, job]) {
    assert.equal(resource.metadata.annotations[COMPATIBILITY_OVERLAY_ANNOTATION], COMPATIBILITY_OVERLAY_VALUE);
    assert.equal(resource.metadata.annotations['opensphere.io/backup-role'], BACKUP_ROLE);
    assert.equal(resource.metadata.annotations['opensphere.io/overlay-release'], lock.releaseDigest);
    assert.equal(resource.metadata.annotations['opensphere.io/overlay-source-revision'], lock.sourceRevision);
  }
  assert.deepEqual(buildBackupRoleReconcileConfigMap(lock), configMap);
  assert.deepEqual(buildBackupRoleReconcileJob(lock), job);
});

test('the backup-role reconcile SQL is idempotent least-privilege and contains no credential or destructive operation', () => {
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /\\getenv backup_password BACKUP_PASSWORD/);
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /CREATE ROLE opensphere_backup LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/);
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /ALTER ROLE opensphere_backup LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/);
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /GRANT CONNECT ON DATABASE console TO opensphere_backup/);
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /GRANT pg_read_all_data TO opensphere_backup/);
  assert.doesNotMatch(BACKUP_ROLE_RECONCILE_SQL, /(?:GRANT|ALTER ROLE)\s+console\b/i);
  assert.doesNotMatch(BACKUP_ROLE_RECONCILE_SQL, /\b(?:DROP|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(BACKUP_ROLE_RECONCILE_SQL, /bootstrap_password|backup_password\s*=|PASSWORD\s+'[^']+'/i);
  assert.match(BACKUP_ROLE_RECONCILE_SQL, /PASSWORD\s+:'backup_password'/,
    'the password value must remain a psql quoted variable populated by \\getenv');
  assert.match(BACKUP_ROLE_RECONCILE_SCRIPT, /export PGPASSWORD="\$BOOTSTRAP_PASSWORD"/);
  assert.doesNotMatch(BACKUP_ROLE_RECONCILE_SCRIPT, /opensphere_backup|backup_password/);
  const commandText = buildBackupRoleReconcileJob(lock).spec.template.spec.containers[0].command.join(' ');
  assert.doesNotMatch(commandText, /BOOTSTRAP_PASSWORD|BACKUP_PASSWORD|password/i);
});

test('historical bootstrap runs the Setup-owned role reconcile only after release reconcile and before recovery', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const bootstrapSrc = source.slice(
    source.indexOf('export async function bootstrap('),
    source.indexOf('export async function upgrade(')
  );
  const idxEstablish = bootstrapSrc.indexOf('establishBootstrapBackupBoundary(lock, release)');
  const idxReleaseReconcile = bootstrapSrc.indexOf('waitForBackboneBoundaryReconcile(lock)');
  const idxRoleReconcile = bootstrapSrc.indexOf('runBackupRoleReconcile(lock)');
  const idxDrill = bootstrapSrc.indexOf('runBackboneRecoveryDrill()');
  assert.ok(idxEstablish < idxReleaseReconcile && idxReleaseReconcile < idxRoleReconcile && idxRoleReconcile < idxDrill);
  assert.match(bootstrapSrc, /if \(bootstrapBackupBoundary\.overlaid\) \{[\s\S]*?runBackupRoleReconcile\(lock\)/,
    'a fully dedicated current release must not run the Setup-owned role reconcile');
  const runner = source.match(/function runBackupRoleReconcile\(lock\)[\s\S]*?\n\}/);
  assert.ok(runner);
  assert.match(runner[0], /buildBackupRoleReconcileManifests\(lock\)/);
  assert.match(runner[0], /delete', 'job', BACKUP_ROLE_RECONCILE_RESOURCE, '--ignore-not-found', '--wait=true'/,
    'a rerun must replace the immutable Job object without deleting data');
  assert.match(runner[0], /applyYaml\(`\$\{JSON\.stringify\(configMap\)\}\\n`\)[\s\S]*applyYaml\(`\$\{JSON\.stringify\(job\)\}\\n`\)/,
    'the ConfigMap must be applied before the Job');
});

// bootstrap.mjs must establish the CURRENT boundary from the applied release AFTER
// BASE_MANIFESTS are applied but BEFORE the reconcile Job and recovery drill run.
test('bootstrap establishes the derived dedicated boundary after applying BASE_MANIFESTS and before the reconcile/recovery drill', async () => {
  const source = await readFile(join(ROOT, 'src', 'bootstrap.mjs'), 'utf8');
  const establish = source.match(/function establishBootstrapBackupBoundary\(lock, release\)[\s\S]*?\n\}/);
  assert.ok(establish, 'establishBootstrapBackupBoundary must be defined');
  // It plans from the release and pins to this release's cbsPostgresql digest (never a captured image).
  assert.match(establish[0], /planBootstrapBackupBoundary\(\s*decodeBackupBoundaryResources\(release\), lock, lock\.components\.cbsPostgresql\.image/);
  assert.match(establish[0], /applyYaml\(`\$\{JSON\.stringify\(overlay\)\}\\n`\)/,
    'the derived overlays must be applied to the cluster');

  // Ordering within bootstrap(): apply loop -> establish overlay -> boundary reconcile -> recovery drill.
  const bootstrapSrc = source.slice(
    source.indexOf('export async function bootstrap('),
    source.indexOf('export async function upgrade(')
  );
  const idxApplyLoop = bootstrapSrc.indexOf('for (const spec of BASE_MANIFESTS)');
  const idxEstablish = bootstrapSrc.indexOf('establishBootstrapBackupBoundary(lock, release)');
  const idxReconcile = bootstrapSrc.indexOf('waitForBackboneBoundaryReconcile(lock)');
  const idxDrill = bootstrapSrc.indexOf('runBackboneRecoveryDrill()');
  assert.ok(idxApplyLoop !== -1 && idxEstablish !== -1 && idxReconcile !== -1 && idxDrill !== -1);
  assert.ok(idxApplyLoop < idxEstablish, 'the boundary is established only after BASE_MANIFESTS are applied');
  assert.ok(idxEstablish < idxReconcile, 'the boundary is established before the reconcile Job runs');
  assert.ok(idxReconcile < idxDrill, 'the recovery drill runs after the reconcile Job');
  // decodeBackupBoundaryResources keys off the three REAL distinct resource names.
  const decode = source.match(/function decodeBackupBoundaryResources\(release\)[\s\S]*?\n\}/);
  assert.ok(decode, 'decodeBackupBoundaryResources must be defined');
  assert.match(decode[0], /find\('CronJob', BACKUP_CRONJOB_RESOURCE\)/);
  assert.match(decode[0], /find\('ConfigMap', BACKUP_SCRIPTS_CONFIGMAP_RESOURCE\)/);
  assert.match(decode[0], /find\('CronJob', RESTORE_DRILL_CRONJOB_RESOURCE\)/);
});

// verify.mjs must stay strict: the clean-bootstrap derivation belongs to bootstrap, not
// verify. verify must never import the derivation helpers to relax verifyRecovery.
test('verify.mjs does not weaken verifyRecovery with the bootstrap derivation helpers', async () => {
  const source = await readFile(join(ROOT, 'src', 'verify.mjs'), 'utf8');
  assert.doesNotMatch(source, /planBootstrapBackupBoundary|deriveDedicated|buildBootstrapBackupBoundaryOverlaySet/,
    'verify must not import or call the clean-bootstrap derivation; it stays fail-closed');
  // The exact CI failure message remains the guard, proving the boundary is still enforced.
  assert.match(source, /PostgreSQL audit backup CronJob does not authenticate as the dedicated opensphere_backup role \(backup_password\)/);
});
