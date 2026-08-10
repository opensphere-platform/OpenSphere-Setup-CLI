import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrap,
  COMPONENT_ROLLOUTS,
  componentReleaseManifestSpecs,
  componentReleaseWorkloadManifests,
  renderManifest,
  terminalPodError,
  upgrade,
  workloadReady
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

function runtime(previous, events, { failTarget = false, recordedInventory = null } = {}) {
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
    prepareComponentRelease: async (
      release,
      _root,
      _storageClass,
      _consoleUrl,
      _authEnvironment,
      { changedComponents = [], includeMigrations = true } = {}
    ) => {
      events.push(`prepare-component:${release.sourceRevision}:${changedComponents.join(',')}:migrations=${includeMigrations}`);
      return {
        foundation: { root: release.sourceRevision, release: [] },
        base: [{ path: 'component.yaml', yaml: release.sourceRevision }],
        all: [{ path: 'component.yaml', yaml: release.sourceRevision }]
      };
    },
    installPreparedRelease: (release, prepared, storageClass, consoleUrl, label) =>
      events.push(`install:${label}:${prepared.all[0].yaml}`),
    installPreparedComponentRelease: (release, prepared, storageClass, consoleUrl, label, changed, _progress, options = {}) =>
      events.push(`install-component:${label}:${release.sourceRevision}:${changed.join(',')}:migrations=${options.applyMigrations !== false}`),
    releaseResourceInventory: (release) => [{
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'opensphere-console',
      name: `release-${release[0].yaml}`
    }],
    readReleaseInventory: () => recordedInventory,
    recordReleaseInventory: (release) => events.push(`inventory:${release.sourceRevision}`),
    pruneReleaseResources: (from, to) => events.push(`prune:${from[0].name}->${to[0].name}`),
    recordInstallationState: (release) => events.push(`record:${release.sourceRevision}`),
    waitForCoreRollouts: () => events.push('wait'),
    waitForComponentRollouts: (changed) => events.push(`wait-component:${changed.join(',')}`),
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
  const result = await upgrade(previous, target, {
    runtime: runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] })
  });
  assert.equal(result.changed, true);
  assert.equal(result.lock.components.console.image, previous.components.console.image);
  assert.ok(events.includes(`record:${target.sourceRevision}`));
  assert.ok(events.includes(`install-component:업그레이드:${target.sourceRevision}:backend:migrations=true`));
  assert.ok(events.includes(`prepare-component:${target.sourceRevision}:backend:migrations=true`));
  assert.ok(events.includes(`prepare-component:${previous.sourceRevision}:backend:migrations=false`));
  assert.equal(events.some((event) => event.startsWith('prepare:')), false);
  assert.ok(events.includes('wait-component:backend'));
  assert.ok(events.includes(`verify:${target.sourceRevision}:backend`));
  assert.equal(events.some((event) => event.startsWith('install:')), false);
  assert.equal(events.includes('wait'), false);
  assert.equal(events.some((event) => event.startsWith('prune:')), false);
  assert.ok(events.includes(`inventory:${target.sourceRevision}`));

  await assert.rejects(
    bootstrap(target, { progress: undefined }),
    /Component release locks are upgrade-only/
  );
});

test('component release preparation selects only manifests that own changed images', () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = componentTarget(previous, '2'.repeat(40), ['dupaController']);
  const selected = componentReleaseManifestSpecs(target);
  assert.deepEqual(selected.foundation, []);
  assert.deepEqual(selected.base.map(({ path }) => path), [
    'backend/dupa-control/opensphere-console-dupa-controller.yaml'
  ]);
  assert.equal(selected.base[0].artifactSourceRevision, target.sourceRevision);

  const foundationTarget = componentTarget(previous, '3'.repeat(40), ['gitea', 'supabaseAuth']);
  const foundationSelected = componentReleaseManifestSpecs(foundationTarget);
  assert.deepEqual(foundationSelected.foundation.map(({ path }) => path), [
    'backend/supabase/bootstrap/supabase.yaml',
    'backend/gitea/bootstrap/gitea.yaml'
  ]);
  assert.deepEqual(foundationSelected.base, []);

  const stacked = componentTarget(previous, '4'.repeat(40), ['console']);
  const inherited = componentReleaseManifestSpecs(stacked, ['dupaController']);
  assert.equal(inherited.base[0].artifactSourceRevision, previous.sourceRevision);

  const recovery = componentReleaseManifestSpecs(stacked, ['recovery']).base[0];
  const renderedRecovery = renderManifest(
    stacked,
    recovery,
    [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata: { name: recovery }',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: recovery',
      '          image: __OPENSPHERE_RECOVERY_IMAGE__',
      '          env:',
      '            - name: RELEASE_REVISION',
      '              value: __OPENSPHERE_RELEASE_REVISION__'
    ].join('\n'),
    'hostpath',
    'https://localhost:1114',
    'development',
    { sourceRevision: recovery.artifactSourceRevision }
  );
  assert.match(renderedRecovery, new RegExp(`value: ${previous.sourceRevision}`));
  assert.doesNotMatch(renderedRecovery, new RegExp(`value: ${stacked.sourceRevision}`));
});

test('component rollout waits for every workload sharing the changed image', () => {
  assert.deepEqual(COMPONENT_ROLLOUTS.backend.map(([, workload]) => workload), [
    'deployment/opensphere-console-backend',
    'deployment/foundation-bootstrap-reconciler',
    'deployment/platform-release-reconciler'
  ]);
  assert.deepEqual(COMPONENT_ROLLOUTS.notificationDispatcher.map(([, workload]) => workload), [
    'deployment/opensphere-notification-dispatcher',
    'deployment/opensphere-external-channel-executor'
  ]);
});

test('component release refuses to overwrite a missing complete release inventory', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  await assert.rejects(
    upgrade(previous, target, { runtime: runtime(previous, []) }),
    /requires the existing complete release inventory/
  );
});

test('component release applies only workload documents that contain a changed exact image', () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  const selected = componentReleaseWorkloadManifests(target, {
    foundation: { release: [] },
    base: [{
      path: 'combined.yaml',
      yaml: [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata: { name: opensphere-console-backend }',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        `        - image: ${target.components.backend.image}`,
        '---',
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata: { name: opensphere-console }',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        `        - image: ${target.components.console.image}`
      ].join('\n')
    }]
  });
  assert.equal(selected.length, 1);
  assert.match(selected[0].yaml, new RegExp(target.components.backend.image.replaceAll('.', '\\.')));
  assert.doesNotMatch(selected[0].yaml, new RegExp(target.components.console.image.replaceAll('.', '\\.')));
});

test('a single-owner component manifest applies its RBAC and workload atomically', () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  const selected = componentReleaseWorkloadManifests(target, {
    foundation: { release: [] },
    base: [{
      path: 'backend/opensphere-console-backend/deploy.yaml',
      yaml: [
        'apiVersion: rbac.authorization.k8s.io/v1',
        'kind: Role',
        'metadata: { name: opensphere-console-backend-installation-lock }',
        '---',
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata: { name: opensphere-console-backend }',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        `        - image: ${target.components.backend.image}`
      ].join('\n')
    }]
  });
  assert.equal(selected.length, 1);
  assert.match(selected[0].yaml, /kind: Role/);
  assert.match(selected[0].yaml, /opensphere-console-backend-installation-lock/);
  assert.match(selected[0].yaml, new RegExp(target.components.backend.image.replaceAll('.', '\\.')));
});

test('failed component verification rolls back only the same changed workloads', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend', 'console']);
  const events = [];
  await assert.rejects(
    upgrade(previous, target, {
      runtime: runtime(previous, events, {
        failTarget: true,
        recordedInventory: [{ name: 'complete-release' }]
      })
    }),
    /previous release was restored/
  );
  assert.ok(events.includes(`install-component:업그레이드:${target.sourceRevision}:backend,console:migrations=true`));
  assert.ok(events.includes(`install-component:롤백:${previous.sourceRevision}:backend,console:migrations=false`));
  assert.ok(events.includes(`prepare-component:${target.sourceRevision}:backend,console:migrations=true`));
  assert.ok(events.includes(`prepare-component:${previous.sourceRevision}:backend,console:migrations=false`));
  assert.equal(events.some((event) => event.startsWith('install:')), false);
  assert.equal(events.some((event) => event.startsWith('prune:')), false);
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

test('current generation exact readiness ignores a stale historical ProgressDeadlineExceeded condition', () => {
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { generation: 17 },
    spec: { replicas: 2 },
    status: {
      observedGeneration: 17,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
      unavailableReplicas: 0,
      conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }]
    }
  };
  assert.equal(workloadReady(deployment), true);
  assert.equal(workloadReady({
    ...deployment,
    status: { ...deployment.status, observedGeneration: 16 }
  }), false);
  assert.equal(workloadReady({
    ...deployment,
    status: { ...deployment.status, readyReplicas: 1, unavailableReplicas: 1 }
  }), false);
});

test('StatefulSet readiness requires the current update revision at exact replicas', () => {
  const statefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { generation: 8 },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 8,
      currentReplicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      currentRevision: 'postgres-abc',
      updateRevision: 'postgres-abc'
    }
  };
  assert.equal(workloadReady(statefulSet), true);
  assert.equal(workloadReady({
    ...statefulSet,
    status: { ...statefulSet.status, updateRevision: 'postgres-def' }
  }), false);
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
