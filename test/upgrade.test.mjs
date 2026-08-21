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
import {
  CANONICAL_AGENT_NAMESPACE,
  LEGACY_INSTALLED_AGENT_COMPONENTS,
  LEGACY_INSTALLED_AGENT_NAMESPACE
} from '../src/release-agent-identity-cutover.mjs';

const MIGRATION_MANIFEST = Object.freeze({
  path: 'backend/supabase/migrations/manifest.json',
  sha256: `sha256:${'d'.repeat(64)}`,
  setDigest: `sha256:${'e'.repeat(64)}`,
  latestMigrationId: '0053',
  migrationCount: 52
});

function componentPublicationBinding() {
  return {
    contract: 'opensphere-edge-component-publication-binding/v1',
    publisher: 'scripts/Publish-LocalEdgeBackendComponent.ps1',
    publisherGitBlob: '1'.repeat(40),
    publisherSha256: `sha256:${'1'.repeat(64)}`,
    documentSha256: `sha256:${'2'.repeat(64)}`,
    signatureSha256: `sha256:${'3'.repeat(64)}`,
    keyId: 'opensphere-edge-local-v1',
    setupSourceRevision: '4'.repeat(40),
    setupSourceLockSha256: `sha256:${'5'.repeat(64)}`,
    setupManifestProjectionGitBlob: '6'.repeat(40),
    setupManifestProjectionSha256: `sha256:${'6'.repeat(64)}`,
    migrationSetDigest: `sha256:${'6'.repeat(64)}`,
    platformRevision: '7'.repeat(40),
    inventorySha256: `sha256:${'7'.repeat(64)}`,
    verificationSetDigest: `sha256:${'8'.repeat(64)}`,
  };
}

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
    artifacts: { supabaseMigrationManifest: { ...MIGRATION_MANIFEST } },
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
  target.componentPublication = componentPublicationBinding();
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
      changedComponents: target.changedComponents,
      componentPublication: target.componentPublication
    }
  );
  return target;
}

function agentIdentityCutoverLocks() {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  delete previous.components.osaaGateway;
  delete previous.components.osaaGovernedAdapter;
  for (const [name, repository] of Object.entries(LEGACY_INSTALLED_AGENT_COMPONENTS)) {
    previous.components[name] = {
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@sha256:${'a'.repeat(64)}`,
      sourceRevision: previous.sourceRevision
    };
  }
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, previous.trust);

  const canonicalBase = lock(previous.sourceRevision, 'a');
  canonicalBase.trust = LOCAL_EDGE_TRUST;
  delete canonicalBase.releaseBom;
  canonicalBase.releaseDigest = calculateReleaseDigest('edge', canonicalBase.components, canonicalBase.trust);
  const target = componentTarget(canonicalBase, '2'.repeat(40), [
    'osaaGateway',
    'osaaGovernedAdapter'
  ]);
  target.baseReleaseDigest = previous.releaseDigest;
  target.releaseDigest = calculateReleaseDigest(
    target.channel,
    target.components,
    target.trust,
    undefined,
    {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents,
      componentPublication: target.componentPublication
    }
  );
  return { previous, target };
}

function bootstrapBoundComponentTarget(previous, revision) {
  const target = componentTarget(previous, revision, ['backend']);
  target.componentPublication.bootstrapFrom = {
    contract: 'opensphere-backend-component-bootstrap/v1',
    requestId: '11111111-2222-4333-8444-555555555555',
    releaseDigest: `sha256:${'9'.repeat(64)}`,
    sourceRevision: '9'.repeat(40),
    image: `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'9'.repeat(64)}`,
    mergeRevision: '8'.repeat(40),
    receiptOperationId: 'operation:bootstrap-a',
    governedDocumentSha256: `sha256:${'7'.repeat(64)}`,
    receiptSha256: `sha256:${'6'.repeat(64)}`,
    handoffState: 'BootstrapApplied',
    convergenceState: 'PendingConvergence',
    foundationFeatureGate: 'Closed',
    trustConfigUid: '11111111-2222-4333-8444-555555555555',
    trustConfigResourceVersion: '12345',
    trustKeySpkiSha256: `sha256:${'5'.repeat(64)}`,
  };
  target.releaseDigest = calculateReleaseDigest(target.channel, target.components, target.trust,
    undefined, {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents,
      componentPublication: target.componentPublication,
    });
  return target;
}

function runtime(previous, events, {
  failTarget = false,
  failMigration = false,
  recordedInventory = null
} = {}) {
  return {
    verifyReleaseLock: async (release, options) =>
      events.push(`supply:${release.sourceRevision}:${options?.allowLegacyComponentSet === true}`),
    ensureManagedNamespaces: () => events.push('namespaces'),
    ensurePlatformReleaseAuthorityTls: async () => {
      events.push('release-tls');
      return { secret: {}, configMap: {}, service: {} };
    },
    cleanupBootstrapAInitializer: async ({ bootstrapFrom, targetReleaseDigest }) => {
      events.push(`cleanup-bootstrap-a:${bootstrapFrom.sourceRevision}:${targetReleaseDigest}`);
      return { contract: 'opensphere-bootstrap-a-initializer-cleanup/v1', residueCount: 0 };
    },
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
        foundation: {
          root: release.sourceRevision,
          release: [],
          ...(includeMigrations && changedComponents.includes('backend') ? {
            migration: { manifest: { setDigest: release.componentPublication?.migrationSetDigest } }
          } : {})
        },
        base: [{ path: 'component.yaml', yaml: release.sourceRevision }],
        all: [{ path: 'component.yaml', yaml: release.sourceRevision }]
      };
    },
    installPreparedRelease: (release, prepared, storageClass, consoleUrl, label) =>
      events.push(`install:${label}:${prepared.all[0].yaml}`),
    installPreparedComponentRelease: (release, prepared, storageClass, consoleUrl, label, changed, _progress, options = {}) =>
      events.push(`install-component:${label}:${release.sourceRevision}:${changed.join(',')}:migrations=${options.applyMigrations !== false}`),
    runComponentMigrations: () => {
      events.push('migrate-agent-identity');
      if (failMigration) throw new Error('identity migration failed');
    },
    releaseResourceInventory: (release) => [{
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'opensphere-console',
      name: `release-${release[0].yaml}`
    }],
    readReleaseInventory: () => recordedInventory,
    recordReleaseInventory: (release) => events.push(`inventory:${release.sourceRevision}`),
    pruneReleaseResources: (from, to) => events.push(`prune:${from[0].name}->${to[0].name}`),
    deleteAgentIdentityNamespace: (namespace) => events.push(`delete-namespace:${namespace}`),
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

test('OSAA identity cutover stages canonical workloads, commits migration once, and removes only legacy resources', async () => {
  const { previous, target } = agentIdentityCutoverLocks();
  const events = [];
  const result = await upgrade(previous, target, {
    runtime: runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] })
  });
  assert.equal(result.lock, target);
  assert.ok(events.includes(
    `prepare-component:${previous.sourceRevision}:oaaGateway,oaaGovernedAdapter:migrations=false`
  ));
  assert.ok(events.includes(
    `install-component:업그레이드:${target.sourceRevision}:osaaGateway,osaaGovernedAdapter:migrations=false`
  ));
  assert.equal(events.filter((event) => event === 'migrate-agent-identity').length, 1);
  assert.ok(events.includes(`wait-component:osaaGateway,osaaGovernedAdapter`));
  assert.ok(events.includes(`verify:${target.sourceRevision}:osaaGateway,osaaGovernedAdapter`));
  assert.ok(events.includes(`delete-namespace:${LEGACY_INSTALLED_AGENT_NAMESPACE}`));
  assert.equal(events.includes(`delete-namespace:${CANONICAL_AGENT_NAMESPACE}`), false);
  assert.equal(events.some((event) => event.includes('install-component:롤백')), false);
});

test('OSAA identity cutover failure before migration keeps the installed lock and removes staged canonical resources', async () => {
  const { previous, target } = agentIdentityCutoverLocks();
  const events = [];
  await assert.rejects(
    upgrade(previous, target, {
      runtime: runtime(previous, events, {
        failMigration: true,
        recordedInventory: [{ name: 'complete-release' }]
      })
    }),
    /failed before migration; previous installation retained/u
  );
  assert.ok(events.includes(`delete-namespace:${CANONICAL_AGENT_NAMESPACE}`));
  assert.equal(events.includes(`delete-namespace:${LEGACY_INSTALLED_AGENT_NAMESPACE}`), false);
  assert.equal(events.some((event) => event === `record:${target.sourceRevision}`), false);
});

test('OSAA identity cutover never performs a false legacy rollback after the one-way database migration', async () => {
  const { previous, target } = agentIdentityCutoverLocks();
  const events = [];
  await assert.rejects(
    upgrade(previous, target, {
      runtime: runtime(previous, events, {
        failTarget: true,
        recordedInventory: [{ name: 'complete-release' }]
      })
    }),
    /requires attention after its one-way database migration/u
  );
  assert.ok(events.includes(`record:${target.sourceRevision}`));
  assert.equal(events.some((event) => event.includes('install-component:롤백')), false);
  assert.equal(events.some((event) => event.startsWith(`verify:${previous.sourceRevision}:`)), false);
});

test('Bootstrap B cleans A initializer only after target verify and returns exact receipt evidence key', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = bootstrapBoundComponentTarget(previous, '2'.repeat(40));
  const events = [];
  const result = await upgrade(previous, target, {
    runtime: runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] })
  });
  const verify = events.indexOf(`verify:${target.sourceRevision}:backend`);
  const cleanup = events.indexOf(
    `cleanup-bootstrap-a:${target.componentPublication.bootstrapFrom.sourceRevision}:${target.releaseDigest}`);
  assert.ok(verify >= 0 && cleanup > verify);
  assert.equal(events.filter((event) => event === 'release-tls').length, 2);
  assert.deepEqual(result.evidence.bootstrapAInitializerCleanup,
    { contract: 'opensphere-bootstrap-a-initializer-cleanup/v1', residueCount: 0 });
  assert.equal('bootstrapACleanup' in result.evidence, false);
  assert.equal('bootstrapAInitializerCleanup' in result, false);
});

test('already-current Bootstrap B replays immutable cleanup journal convergence', async () => {
  const base = lock('1'.repeat(40), 'a');
  base.trust = LOCAL_EDGE_TRUST;
  delete base.releaseBom;
  base.releaseDigest = calculateReleaseDigest('edge', base.components, LOCAL_EDGE_TRUST);
  const target = bootstrapBoundComponentTarget(base, '2'.repeat(40));
  const events = [];
  const result = await upgrade(target, structuredClone(target), {
    runtime: runtime(target, events, { recordedInventory: [{ name: 'complete-release' }] })
  });
  assert.equal(result.changed, false);
  assert.ok(events.includes(
    `cleanup-bootstrap-a:${target.componentPublication.bootstrapFrom.sourceRevision}:${target.releaseDigest}`));
  assert.deepEqual(result.evidence.bootstrapAInitializerCleanup,
    { contract: 'opensphere-bootstrap-a-initializer-cleanup/v1', residueCount: 0 });
  assert.equal(events.some((event) => event.startsWith('install-component:')), false);
});

test('partial Bootstrap A cleanup fails NeedsAttention without rollback or authority recreation', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = bootstrapBoundComponentTarget(previous, '2'.repeat(40));
  const events = [];
  const injected = runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] });
  injected.cleanupBootstrapAInitializer = async () => {
    events.push('cleanup-partial');
    throw new Error('simulated partial cleanup');
  };
  await assert.rejects(upgrade(previous, target, { runtime: injected }),
    /NeedsAttention: Bootstrap A initializer cleanup did not complete; rollback was not attempted/);
  assert.equal(events.filter((event) => event === 'release-tls').length, 2);
  assert.equal(events.some((event) => event.startsWith('install-component:롤백:')), false);
});

test('component release preparation selects only manifests that own changed images', () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = componentTarget(previous, '2'.repeat(40), ['dupaController']);
  const selected = componentReleaseManifestSpecs(target);
  assert.deepEqual(selected.foundation, []);
  assert.deepEqual(selected.base.map(({ path }) => path), [
    'backend/dupa-control/ui-plugin-crds.yaml',
    'backend/dupa-control/opensphere-console-dupa-controller.yaml'
  ]);
  assert.equal(selected.base[0].artifactSourceRevision, target.sourceRevision);
  assert.equal(selected.base[1].artifactSourceRevision, target.sourceRevision);

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

test('Backend component release binds the signed migration set before any target mutation', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  const events = [];
  const baseRuntime = runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] });
  const prepare = baseRuntime.prepareComponentRelease;
  baseRuntime.prepareComponentRelease = async (...args) => {
    const prepared = await prepare(...args);
    if (args[0] === target) prepared.foundation.migration.manifest.setDigest = `sha256:${'f'.repeat(64)}`;
    return prepared;
  };
  await assert.rejects(
    upgrade(previous, target, { runtime: baseRuntime }),
    /migration set differs from the materialized target migrations/
  );
  assert.equal(events.some((event) => event.startsWith('install-component:')), false);
  assert.equal(events.some((event) => event.startsWith('record:')), false);
});

test('component rollout waits for every workload sharing the changed image', () => {
  assert.deepEqual(COMPONENT_ROLLOUTS.backend.map(([, workload]) => workload), [
    'deployment/opensphere-console-backend',
    'deployment/foundation-bootstrap-reconciler',
    'deployment/platform-release-reconciler',
    'deployment/foundation-owner-release-reconciler'
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

test('Bootstrap A backend manifest refuses an incomplete initializer document set', () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['backend']);
  assert.throws(() => componentReleaseWorkloadManifests(target, {
    foundation: { release: [] },
    base: [{ path: 'backend/opensphere-console-backend/deploy.yaml', yaml: [
        'apiVersion: rbac.authorization.k8s.io/v1',
        'kind: Role',
        'metadata: { name: platform-release-tls-initializer }',
        '---',
        'apiVersion: v1',
        'kind: ServiceAccount',
        'metadata: { name: platform-release-tls-initializer }',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata: { name: opensphere-platform-release-authority }',
        'spec: { ports: [{ port: 8446 }] }',
        '---',
        'apiVersion: batch/v1',
        'kind: Job',
        'metadata: { name: opensphere-tls-init-a }',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        `        - image: ${target.components.backend.image}`,
        '---',
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata: { name: opensphere-console-backend }',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        `        - image: ${target.components.backend.image}`
      ].join('\n') }]
  }), /Bootstrap initializer|Unexpected Bootstrap initializer/);
});

test('a component release applies its explicitly owned static CRD before the DUPA workload', () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, LOCAL_EDGE_TRUST);
  const target = componentTarget(previous, '2'.repeat(40), ['dupaController']);
  const selected = componentReleaseWorkloadManifests(target, {
    foundation: { release: [] },
    base: [
      {
        path: 'backend/dupa-control/ui-plugin-crds.yaml',
        yaml: [
          'apiVersion: apiextensions.k8s.io/v1',
          'kind: CustomResourceDefinition',
          'metadata: { name: uipluginpackages.plugins.opensphere.io }'
        ].join('\n')
      },
      {
        path: 'backend/dupa-control/opensphere-console-dupa-controller.yaml',
        yaml: [
          'apiVersion: apps/v1',
          'kind: Deployment',
          'metadata: { name: opensphere-console-dupa-controller }',
          'spec:',
          '  template:',
          '    spec:',
          '      containers:',
          `        - image: ${target.components.dupaController.image}`
        ].join('\n')
      }
    ]
  });
  assert.deepEqual(selected.map(({ path }) => path), [
    'backend/dupa-control/ui-plugin-crds.yaml#dupaController',
    'backend/dupa-control/opensphere-console-dupa-controller.yaml#dupaController'
  ]);
  assert.match(selected[0].yaml, /kind: CustomResourceDefinition/);
  assert.match(selected[1].yaml, new RegExp(target.components.dupaController.image.replaceAll('.', '\\.')));
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
