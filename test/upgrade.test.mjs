import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrap,
  componentBaseRelease,
  componentRollouts,
  terminalPodError,
  upgrade
} from '../src/bootstrap.mjs';
import {
  calculateReleaseBomDigest,
  calculateReleaseDigest,
  COMPONENTS,
  RELEASE_API_VERSION,
  RELEASE_BOM_PREDICATE,
  RELEASE_SCOPE_COMPONENT,
  RELEASE_TRUST,
  LOCAL_EDGE_TRUST,
  releaseBomPointer,
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
  const bom = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseBOM',
    channel: 'edge',
    status: 'Active',
    source: SOURCE,
    sourceRevision: revision,
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    components
  };
  const releaseBom = releaseBomPointer(bom);
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components, RELEASE_TRUST, releaseBom),
    source: SOURCE,
    sourceRevision: revision,
    trust: RELEASE_TRUST,
    releaseBom,
    components
  };
}

function preRecoveryLock(revision, digestCharacter) {
  const previous = lock(revision, digestCharacter);
  delete previous.components.recovery;
  const bom = {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseBOM',
    channel: 'edge',
    status: 'Active',
    source: SOURCE,
    sourceRevision: revision,
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    components: previous.components
  };
  previous.releaseBom = {
    predicateType: RELEASE_BOM_PREDICATE,
    subject: previous.components.console.image,
    digest: calculateReleaseBomDigest(bom)
  };
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, RELEASE_TRUST, previous.releaseBom);
  return previous;
}

function componentTarget(previous, revision, changedComponents = ['backend']) {
  const target = structuredClone(previous);
  target.releaseScope = RELEASE_SCOPE_COMPONENT;
  target.baseReleaseDigest = previous.releaseDigest;
  target.changedComponents = [...changedComponents].sort();
  target.sourceRevision = revision;
  delete target.releaseBom;
  for (const name of target.changedComponents) {
    target.components[name].image =
      `ghcr.io/opensphere-platform/${target.components[name].repository}@sha256:${'c'.repeat(64)}`;
    target.components[name].sourceRevision = revision;
  }
  target.releaseDigest = calculateReleaseDigest(
    target.channel,
    target.components,
    target.trust,
    undefined,
    {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents
    }
  );
  return target;
}

test('component apply selects only the changed workload manifests', () => {
  const release = [
    {
      path: 'backend/opensphere-console-backend/deploy.yaml',
      yaml: 'backend\n---\n# Foundation bootstrap is not executed by the browser-facing Backend\nfoundation'
    },
    { path: 'deploy/opensphere-console.yaml', yaml: 'console' },
    { path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml', yaml: 'dupa' },
    { path: 'deploy/production-hardening.yaml', yaml: 'shared' }
  ];
  assert.deepEqual(
    componentBaseRelease(release, ['backend', 'console']).map(({ path }) => path),
    ['backend/opensphere-console-backend/deploy.yaml', 'deploy/opensphere-console.yaml']
  );
  assert.equal(componentBaseRelease(release, ['backend'])[0].yaml, 'backend\n');
  assert.equal(
    componentBaseRelease([{
      path: 'backend/opensphere-console-backend/deploy.yaml',
      yaml: 'standalone backend\n'
    }], ['backend'])[0].yaml,
    'standalone backend\n'
  );
  assert.throws(
    () => componentBaseRelease([{
      path: 'backend/opensphere-console-backend/deploy.yaml',
      yaml: 'backend\n---\nmetadata: { name: foundation-bootstrap-reconciler }\n'
    }], ['backend']),
    /contains Foundation bootstrap resources without the isolation boundary/
  );
  assert.throws(
    () => componentBaseRelease(release, ['supabasePostgres']),
    /no isolated manifest apply contract/
  );
});

test('component rollout verification is limited to selected workloads', () => {
  assert.deepEqual(componentRollouts(['backend', 'console']), [
    ['opensphere-console', 'deployment/opensphere-console-backend', '600s'],
    ['opensphere-console', 'deployment/opensphere-console', '600s']
  ]);
  assert.throws(
    () => componentRollouts(['recovery']),
    /no isolated rollout verification contract/
  );
});

function runtime(previous, events, { failTarget = false } = {}) {
  return {
    verifyReleaseLock: async (release, options) =>
      events.push(`supply:${release.sourceRevision}:${options?.allowLegacyComponentSet === true}`),
    ensureManagedNamespaces: () => events.push('namespaces'),
    ensureRegistryPullSecrets: () => events.push('registry'),
    readInstallationLock: () => previous,
    readInstallationConfig: () => ({
      architecture: 'supabase-data-identity+gitea-change-authority',
      storageClass: 'hostpath',
      consoleUrl: 'https://localhost:8090',
      authEnvironment: 'development',
      initialAdmin: {
        username: 'opensphere-admin',
        displayName: 'OpenSphere Administrator',
        email: 'admin@opensphere.local'
      }
    }),
    preflight: () => events.push('preflight'),
    prepareRelease: async (release, _root, _storageClass, _consoleUrl, _authEnvironment, options = {}) => {
      events.push(`prepare:${release.sourceRevision}`);
      if (options.optionalArtifacts?.has('backend/supabase/migrations/0027_external_channel_reason_policy.sql')) {
        events.push(`prepare-legacy-rollback:${release.sourceRevision}`);
      }
      return {
        foundation: { root: release.sourceRevision },
        base: [],
        all: [{ path: 'release.yaml', yaml: release.sourceRevision }]
      };
    },
    installPreparedRelease: (release, prepared, storageClass, consoleUrl, label) =>
      events.push(`install:${label}:${prepared.all[0].yaml}`),
    releaseResourceInventory: (release) => [{
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'opensphere-console',
      name: `release-${release[0].yaml}`
    }],
    readReleaseInventory: () => null,
    recordReleaseInventory: (release) => events.push(`inventory:${release.sourceRevision}`),
    pruneReleaseResources: (from, to) => events.push(`prune:${from[0].name}->${to[0].name}`),
    recordInstallationState: (release) => events.push(`record:${release.sourceRevision}`),
    waitForCoreRollouts: (_progress, selection) => events.push(`wait:${(selection ?? []).join(',')}`),
    verifyInstallation: async (release, options) => {
      events.push(`verify:${release.sourceRevision}:${(options?.componentSelection ?? []).join(',')}`);
      if (failTarget && release.sourceRevision !== previous.sourceRevision) {
        throw new Error('target is unhealthy');
      }
      return { releaseDigest: release.releaseDigest };
    }
  };
}

test('upgrade prefetches target and rollback artifacts before target install', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const result = await upgrade(previous, target, { runtime: runtime(previous, events) });
  assert.equal(result.changed, true);
  const targetPrepare = events.indexOf(`prepare:${target.sourceRevision}`);
  const rollbackPrepare = events.indexOf(`prepare:${previous.sourceRevision}`);
  const install = events.indexOf(`install:업그레이드:${target.sourceRevision}`);
  assert.ok(targetPrepare >= 0 && rollbackPrepare >= 0 && install >= 0);
  assert.ok(targetPrepare < install && rollbackPrepare < install);
  assert.ok(events.includes(`prepare-legacy-rollback:${previous.sourceRevision}`));
  assert.equal(events.includes(`prepare-legacy-rollback:${target.sourceRevision}`), false);
  assert.ok(events.indexOf(`verify:${target.sourceRevision}:`) > install);
  assert.ok(events.includes(`prune:release-${previous.sourceRevision}->release-${target.sourceRevision}`));
  assert.ok(events.includes('namespaces'));
});

test('component release is upgrade-only and keeps a complete rollback lock', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  const events = [];
  const result = await upgrade(previous, target, { runtime: runtime(previous, events) });
  assert.equal(result.changed, true);
  assert.equal(result.lock.components.console.image, previous.components.console.image);
  assert.ok(events.includes(`record:${target.sourceRevision}`));
  assert.ok(events.includes('wait:backend'));
  assert.ok(events.includes(`verify:${target.sourceRevision}:backend`));

  await assert.rejects(
    bootstrap(target, { progress: undefined }),
    /Component release locks are upgrade-only/
  );
});

test('upgrade accepts an exact pre-recovery installed lock only for the verified rollback side', async () => {
  const previous = preRecoveryLock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  await upgrade(previous, target, { runtime: runtime(previous, events) });
  assert.ok(events.includes(`supply:${previous.sourceRevision}:true`));
  assert.ok(events.includes(`supply:${target.sourceRevision}:false`));
});

test('failed target verification restores and verifies the previous Supabase/Gitea release', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  await assert.rejects(
    upgrade(previous, target, { runtime: runtime(previous, events, { failTarget: true }) }),
    /previous release was restored: target is unhealthy/
  );
  const rollbackInstall = events.indexOf(`install:롤백:${previous.sourceRevision}`);
  const rollbackVerify = events.lastIndexOf(`verify:${previous.sourceRevision}:`);
  assert.ok(rollbackInstall >= 0 && rollbackVerify > rollbackInstall);
  assert.ok(events.includes(`record:${previous.sourceRevision}`));
});

test('Supabase/Gitea upgrade path contains no retired backup-boundary operation', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const injected = runtime(previous, events);
  injected.captureBackupBoundary = () => events.push('legacy-backup-boundary');
  injected.runBackboneRecoveryDrill = () => events.push('legacy-rustfs-drill');
  await upgrade(previous, target, { runtime: injected });
  assert.equal(events.includes('legacy-backup-boundary'), false);
  assert.equal(events.includes('legacy-rustfs-drill'), false);
});

test('terminal pod configuration errors are detected before rollout timeout', () => {
  assert.match(terminalPodError({
    items: [{
      metadata: { name: 'supabase-auth-abc' },
      status: { containerStatuses: [{
        name: 'auth',
        state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret key required' } }
      }] }
    }]
  }), /supabase-auth-abc\/auth: CreateContainerConfigError.*secret key required/);
  assert.equal(terminalPodError({
    items: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } }]
  }), null);
});

test('unrecoverable image pull errors fail before rollout timeout', () => {
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
