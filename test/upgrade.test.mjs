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
    recordInstallationState: (release) => events.push(`record:${release.sourceRevision}`),
    prepareUpgradePrerequisites: async () => {
      events.push('prepare-prerequisites');
      return { changed: true, restore: () => events.push('restore-prerequisites') };
    },
    restartBackboneTrustConsumers: () => events.push('restart-backbone-trust-consumers'),
    reconcileRollbackStatefulSets: () => events.push('reconcile-rollback-statefulsets'),
    waitForCoreRollouts: () => events.push('wait'),
    waitForBackboneBoundaryReconcile: () => events.push('boundary-reconcile'),
    runBackboneRecoveryDrill: () => events.push('recovery-drill'),
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
    'prepare-prerequisites',
    `apply:업그레이드:${target.sourceRevision}`,
    'boundary-reconcile',
    'restart-backbone-trust-consumers',
    `record:${target.sourceRevision}`,
    'wait',
    'recovery-drill',
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
  assert.deepEqual(events.slice(-6), [
    `apply:롤백:${previous.sourceRevision}`,
    `record:${previous.sourceRevision}`,
    'reconcile-rollback-statefulsets',
    'wait',
    `verify:${previous.sourceRevision}`,
    'restore-prerequisites'
  ]);
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
