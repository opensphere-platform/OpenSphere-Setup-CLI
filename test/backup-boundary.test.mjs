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
  sanitizeManifestMetadata
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
