import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalPodError, upgrade } from '../src/bootstrap.mjs';
import {
  calculateReleaseDigest,
  COMPONENTS,
  RELEASE_API_VERSION,
  RELEASE_TRUST,
  SOURCE
} from '../src/release.mjs';

function lock(revision, digestCharacter) {
  const imageDigest = `sha256:${digestCharacter.repeat(64)}`;
  const components = Object.fromEntries(Object.entries(COMPONENTS).map(([name, repository]) => [
    name,
    {
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@${imageDigest}`,
      sourceRevision: revision
    }
  ]));
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components),
    source: SOURCE,
    sourceRevision: revision,
    trust: RELEASE_TRUST,
    components
  };
}

function runtime(previous, events, { failTarget = false } = {}) {
  return {
    readInstallationLock: () => previous,
    readInstallationConfig: () => ({
      storageClass: 'hostpath',
      initialAdmin: { username: 'opensphere-admin', displayName: 'OpenSphere Administrator', email: 'admin@opensphere.local' }
    }),
    readInitialAdmin: () => null,
    assertPostgresUpgradeBoundary: () => events.push('assert-postgres-upgrade-boundary'),
    materializeRelease: async (release) => {
      events.push(`materialize:${release.sourceRevision}`);
      return [{ path: 'release.yaml', yaml: release.sourceRevision }];
    },
    applyRelease: (release, label) => events.push(`apply:${label}:${release[0].yaml}`),
    releaseResourceInventory: (release) => {
      events.push(`inventory:${release[0].yaml}`);
      return [{ apiVersion: 'v1', kind: 'ConfigMap', namespace: 'opensphere-console', name: `release-${release[0].yaml}` }];
    },
    readReleaseInventory: () => null,
    recordReleaseInventory: (release) => events.push(`record-inventory:${release.sourceRevision}`),
    pruneReleaseResources: (from, to) => events.push(`prune:${from[0].name}->${to[0].name}`),
    recordInstallationState: (release) => events.push(`record:${release.sourceRevision}`),
    prepareUpgradePrerequisites: async () => {
      events.push('prepare-prerequisites');
      return { changed: true, restore: () => events.push('restore-prerequisites') };
    },
    prepareBackupTarget: () => {
      events.push('prepare-backup-target');
      return { mode: 'in-cluster-rustfs', restore: () => events.push('restore-backup-target') };
    },
    restartBackboneTrustConsumers: () => events.push('restart-backbone-trust-consumers'),
    reconcileRollbackStatefulSets: () => events.push('reconcile-rollback-statefulsets'),
    captureBackupBoundary: () => {
      events.push('capture-backup-boundary');
      return { dedicated: true };
    },
    reassertBackupBoundary: (boundary, lock) => {
      events.push(`reassert-backup-boundary:${lock.sourceRevision}`);
      return { overlaid: false, resources: [] };
    },
    waitForCoreRollouts: () => events.push('wait'),
    waitForBackboneBoundaryReconcile: () => events.push('boundary-reconcile'),
    runBackboneRecoveryDrill: () => events.push('recovery-drill'),
    preflight: () => ({ storageClass: 'hostpath' }),
    verifyInstallation: async (release) => {
      events.push(`verify:${release.sourceRevision}`);
      if (failTarget && release.sourceRevision !== previous.sourceRevision) throw new Error('target is unhealthy');
      return { releaseDigest: release.releaseDigest };
    }
  };
}

test('upgrade prefetches both releases before applying and verifies the target', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const result = await upgrade(previous, target, { runtime: runtime(previous, events) });
  assert.equal(result.changed, true);
  assert.deepEqual(events, [
    'assert-postgres-upgrade-boundary',
    `materialize:${target.sourceRevision}`,
    `materialize:${previous.sourceRevision}`,
    `inventory:${target.sourceRevision}`,
    `inventory:${previous.sourceRevision}`,
    'capture-backup-boundary',
    'prepare-prerequisites',
    'prepare-backup-target',
    `apply:업그레이드:${target.sourceRevision}`,
    `reassert-backup-boundary:${target.sourceRevision}`,
    'boundary-reconcile',
    'restart-backbone-trust-consumers',
    `record:${target.sourceRevision}`,
    'wait',
    'recovery-drill',
    `verify:${target.sourceRevision}`,
    `prune:release-${previous.sourceRevision}->release-${target.sourceRevision}`,
    `record-inventory:${target.sourceRevision}`,
    `verify:${target.sourceRevision}`
  ]);
});

test('failed target verification restores and verifies the previous release', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  await assert.rejects(
    upgrade(previous, target, { runtime: runtime(previous, events, { failTarget: true }) }),
    /previous release was restored: target is unhealthy/
  );
  assert.deepEqual(events.slice(-10), [
    `apply:롤백:${previous.sourceRevision}`,
    `reassert-backup-boundary:${previous.sourceRevision}`,
    `prune:release-${target.sourceRevision}->release-${previous.sourceRevision}`,
    `record:${previous.sourceRevision}`,
    'reconcile-rollback-statefulsets',
    'wait',
    `verify:${previous.sourceRevision}`,
    `record-inventory:${previous.sourceRevision}`,
    'restore-prerequisites',
    'restore-backup-target'
  ]);
});

test('a downgrade reasserts the once-captured dedicated backup boundary on both the target apply and the rollback, pinned to each release', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const seen = [];
  const base = runtime(previous, events, { failTarget: true });
  const captured = { dedicated: true, marker: 'live-installation' };
  base.captureBackupBoundary = () => { events.push('capture-backup-boundary'); return captured; };
  base.reassertBackupBoundary = (boundary, appliedLock, release) => {
    seen.push({ dedicated: boundary.dedicated, sameCapture: boundary === captured, lock: appliedLock.sourceRevision, release: release[0].yaml });
    return { overlaid: true, resources: [
      'ConfigMap/backbone-postgres-backup-scripts',
      'CronJob/backbone-postgres-backup',
      'CronJob/backbone-postgres-restore-drill'
    ] };
  };
  await assert.rejects(upgrade(previous, target, { runtime: base }));
  // Captured exactly once (before any apply), then reasserted on the target apply
  // and again on the rollback apply -- each pinned to the release actually applied.
  assert.equal(events.filter((event) => event === 'capture-backup-boundary').length, 1);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { dedicated: true, sameCapture: true, lock: target.sourceRevision, release: target.sourceRevision });
  assert.deepEqual(seen[1], { dedicated: true, sameCapture: true, lock: previous.sourceRevision, release: previous.sourceRevision });
});

test('the dedicated backup boundary is reasserted after the target apply but before the recovery drill', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  await upgrade(previous, target, { runtime: runtime(previous, events) });
  const apply = events.indexOf(`apply:업그레이드:${target.sourceRevision}`);
  const reassert = events.indexOf(`reassert-backup-boundary:${target.sourceRevision}`);
  const drill = events.indexOf('recovery-drill');
  assert.ok(apply < reassert && reassert < drill,
    'the console→console downgrade must reassert the opensphere_backup boundary before pg_dump runs in the drill');
});

test('upgrade never calls an OAA staging-removal operation on the target apply or rollback path', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const staged = runtime(previous, events);
  staged.removeOptionalOaaStaging = () => events.push('remove-optional-oaa-staging');
  await upgrade(previous, target, { runtime: staged });
  assert.equal(events.includes('remove-optional-oaa-staging'), false);
});

test('rollback never calls an OAA staging-removal operation even when a runtime still provides one', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const staged = runtime(previous, events, { failTarget: true });
  staged.removeOptionalOaaStaging = () => events.push('remove-optional-oaa-staging');
  await assert.rejects(upgrade(previous, target, { runtime: staged }));
  assert.equal(events.includes('remove-optional-oaa-staging'), false);
});

test('terminal pod configuration errors are detected before rollout timeout', () => {
  assert.match(terminalPodError({
    items: [{
      metadata: { name: 'auth-abc' },
      status: { containerStatuses: [{
        name: 'auth',
        state: { waiting: { reason: 'CreateContainerConfigError', message: 'numeric uid required' } }
      }] }
    }]
  }), /auth-abc\/auth: CreateContainerConfigError.*numeric uid required/);
  assert.equal(terminalPodError({
    items: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } }]
  }), null);
});

test('unrecoverable image pull errors fail before the rollout timeout', () => {
  assert.match(terminalPodError({
    items: [{
      metadata: { name: 'console-abc' },
      status: { containerStatuses: [{
        name: 'console',
        state: { waiting: { reason: 'ImagePullBackOff', message: 'manifest unknown: manifest unknown' } }
      }] }
    }]
  }), /console-abc\/console: ImagePullBackOff.*manifest unknown/);
  assert.equal(terminalPodError({
    items: [{
      metadata: { name: 'console-abc' },
      status: { containerStatuses: [{
        name: 'console',
        state: { waiting: { reason: 'ErrImagePull', message: 'dial tcp: temporary network failure' } }
      }] }
    }]
  }), null);
});
