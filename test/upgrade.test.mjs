import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertForwardRepair,installationRecordDigest} from '../src/forward-repair.mjs';
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
  AUXILIARY_ARTIFACTS,
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
  path: 'migrations/manifest.json',
  sha256: `sha256:${'d'.repeat(64)}`,
  setDigest: `sha256:${'e'.repeat(64)}`,
  latestGlobalId: 'opensphere-console/20260902/0001',
  migrationCount: 1
});

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
  const auxiliaryArtifacts = Object.fromEntries(Object.entries(AUXILIARY_ARTIFACTS).map(([name, repository]) => [
    name,
    {
      repository,
      image: 'ghcr.io/opensphere-platform/' + repository + '@' + imageDigest,
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
    releaseTag: '202609020101',
    artifacts: { supabaseMigrationManifest: { ...MIGRATION_MANIFEST } },
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    components
  };
  const releaseBom = releaseBomPointer(bom);
  return {
    apiVersion: RELEASE_API_VERSION,
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: calculateReleaseDigest('edge', components, RELEASE_TRUST, releaseBom, { auxiliaryArtifacts }),
    source: SOURCE,
    sourceRevision: revision,
    trust: RELEASE_TRUST,
    releaseBom,
    auxiliaryArtifacts,
    components
  };
}

function preRecoveryLock(revision, digestCharacter) {
  const previous = lock(revision, digestCharacter);
  delete previous.components.recovery;
  delete previous.components.osdst;
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

function componentTarget(previous, revision, changedComponents = ['consoleApi']) {
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
      changedComponents: target.changedComponents,
      auxiliaryArtifacts: target.auxiliaryArtifacts
    }
  );
  return target;
}

function registryIntroductionLocks() {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  delete previous.components.registry;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, previous.trust, undefined, { auxiliaryArtifacts: previous.auxiliaryArtifacts });
  const target = structuredClone(previous);
  target.releaseScope = RELEASE_SCOPE_COMPONENT;
  target.baseReleaseDigest = previous.releaseDigest;
  target.changedComponents = ['registry'];
  target.sourceRevision = '2'.repeat(40);
  target.components.registry = {
    repository: COMPONENTS.registry,
    image: `ghcr.io/opensphere-platform/${COMPONENTS.registry}@sha256:${'c'.repeat(64)}`,
    sourceRevision: target.sourceRevision
  };
  target.releaseDigest = calculateReleaseDigest(
    target.channel,
    target.components,
    target.trust,
    undefined,
    {
      releaseScope: target.releaseScope,
      baseReleaseDigest: target.baseReleaseDigest,
      changedComponents: target.changedComponents,
      auxiliaryArtifacts: target.auxiliaryArtifacts
    }
  );
  return { previous, target };
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
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, previous.trust, undefined, { auxiliaryArtifacts: previous.auxiliaryArtifacts });

  const canonicalBase = lock(previous.sourceRevision, 'a');
  canonicalBase.trust = LOCAL_EDGE_TRUST;
  delete canonicalBase.releaseBom;
  canonicalBase.releaseDigest = calculateReleaseDigest('edge', canonicalBase.components, canonicalBase.trust, undefined, { auxiliaryArtifacts: canonicalBase.auxiliaryArtifacts });
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
      auxiliaryArtifacts: target.auxiliaryArtifacts
    }
  );
  return { previous, target };
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
    pruneReleaseResources: (from, to) => {
      events.push(`prune:${from[0]?.name ?? 'none'}->${to[0]?.name ?? 'none'}`);
      return [];
    },
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

function repairFixture() {
  const {base:previous,target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
  const config={architecture:'supabase-data-identity+gitea-change-authority',channel:'edge',
    consoleUrl:'https://localhost:1114',storageClass:'standard',authEnvironment:'development',
    releaseDigest:previous.releaseDigest,initialAdmin:{username:'admin'}};
  const record={apiVersion:'v1',kind:'ConfigMap',metadata:{namespace:'opensphere-console',
    name:'opensphere-installation-lock',uid:'original-object',resourceVersion:'10'},
    data:{'release.json':JSON.stringify(previous),'config.json':JSON.stringify(config),
      'state.json':JSON.stringify({phase:'Failed'})}};
  return {previous,target,record,config};
}

test('forward repair requires the reviewed record and rejects healthy, remote and replaced installations',()=>{
  const {previous,target,record}=repairFixture();
  const args={previous,target,record,context:'docker-desktop',expectedRecordDigest:installationRecordDigest(record)};
  assert.equal(assertForwardRepair(args).rollbackAvailable,false);
  assert.throws(()=>assertForwardRepair({...args,context:'production'}),/restricted/);
  assert.throws(()=>assertForwardRepair({...args,expectedRecordDigest:undefined}),/review/);
  const replaced=structuredClone(record); replaced.metadata.uid='replacement';
  assert.throws(()=>assertForwardRepair({...args,record:replaced}),/review/);
  const ready=structuredClone(record);ready.data['state.json']=JSON.stringify({phase:'Ready'});
  assert.throws(()=>assertForwardRepair({...args,record:ready,expectedRecordDigest:installationRecordDigest(ready)}),/ordinary upgrade/);
  const wrong=structuredClone(record);const config=JSON.parse(wrong.data['config.json']);config.consoleUrl='https://production.example';
  wrong.data['config.json']=JSON.stringify(config);
  assert.throws(()=>assertForwardRepair({...args,record:wrong,expectedRecordDigest:installationRecordDigest(wrong)}),/localhost/);
});

test('forward repair verifies the target, retains failed state and resumes without restoring or pruning old resources',async()=>{
  const fixture=repairFixture(),events=[],records=[];let installed=fixture.previous,record=fixture.record,fail=true;
  const operations=runtime(installed,events,{recordedInventory:[{apiVersion:'v1',kind:'ConfigMap',namespace:'opensphere-console',name:'retained'}]});
  operations.readInstallationLock=()=>installed;
  operations.readInstallationConfig=()=>JSON.parse(record.data['config.json']);
  operations.readInstallationRecord=()=>structuredClone(record);
  operations.currentKubeContext=()=> 'docker-desktop';
  operations.recordInstallationState=(release,_sc,_admin,_url,_env,_tls,phase,options)=>{
    assert.equal(options.recordPrecondition.uid,record.metadata.uid);
    assert.equal(options.recordPrecondition.resourceVersion,record.metadata.resourceVersion);
    assert.equal(options.forwardRepair.rollbackAvailable,false);
    installed=release;record.data['release.json']=JSON.stringify(release);
    record.data['config.json']=JSON.stringify({...fixture.config,releaseDigest:release.releaseDigest});
    record.data['state.json']=JSON.stringify({phase});
    record.metadata.resourceVersion=String(Number(record.metadata.resourceVersion)+1);
    records.push(phase);
  };
  operations.verifyInstallation=async()=>{if(fail)throw Error('owner data unavailable');return {verifiedAt:'2026-09-12T00:00:00Z'};};
  await assert.rejects(upgrade(installed,fixture.target,{runtime:operations,forwardRepairRecordDigest:installationRecordDigest(record)}),/no automatic rollback/);
  assert.equal(records.at(-1),'Failed');assert.ok(!records.includes('Ready'));
  assert.ok(events.filter(e=>e.startsWith('supply:')).length===1);
  assert.ok(!events.some(e=>e.includes('롤백')||e.startsWith('prune:')||e.startsWith('delete-namespace:')));
  fail=false;
  assert.equal((await upgrade(installed,fixture.target,{runtime:operations,forwardRepairRecordDigest:installationRecordDigest(record)})).changed,true);
  assert.equal(records.at(-1),'Ready');
});

test('forward repair does not begin when target provenance fails or the reviewed record changes during preparation',async()=>{
  for(const failure of ['target','record']) {
    const {previous,target,record,config}=repairFixture(),events=[];
    const operations=runtime(previous,events,{recordedInventory:[{apiVersion:'v1',kind:'ConfigMap',namespace:'opensphere-console',name:'retained'}]});
    operations.readInstallationRecord=()=>structuredClone(record);
    operations.readInstallationConfig=()=>config;
    operations.currentKubeContext=()=> 'docker-desktop';
    if(failure==='target') operations.verifyReleaseLock=async()=>{throw Error('Target signature invalid');};
    else {const prepare=operations.prepareComponentRelease;operations.prepareComponentRelease=async(...args)=>{
      const result=await prepare(...args);record.metadata.resourceVersion='changed';return result;};}
    await assert.rejects(upgrade(previous,target,{runtime:operations,forwardRepairRecordDigest:installationRecordDigest(record)}),failure==='target'?/signature/:/fresh repair plan/);
    assert.ok(!events.some(e=>e.startsWith('install')||e.startsWith('record:')||e.startsWith('prune:')));
  }
});

test('Knowledge-only upgrade and failure recovery retain all images and persist the exact data pointer', async()=>{
 const {base:previous,target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
 for(const fail of [false,true]){
  const events=[],records=[],prepared=[],installed=[];
  const operations=runtime(previous,events,{recordedInventory:[{apiVersion:'v1',kind:'ConfigMap',namespace:'opensphere-console',name:'complete-release'}]});
  const prepare=operations.prepareComponentRelease;
  operations.prepareComponentRelease=async(release,...args)=>{prepared.push(structuredClone(release));return prepare(release,...args);};
  const install=operations.installPreparedComponentRelease;
  operations.installPreparedComponentRelease=(release,...args)=>{installed.push(structuredClone(release));return install(release,...args);};
  operations.recordInstallationState=(release,_sc,_admin,_url,_env,_tls,phase)=>records.push({release:structuredClone(release),phase});
  operations.verifyInstallation=async release=>{if(fail&&release.releaseDigest===target.releaseDigest)throw Error('data delivery unhealthy');return {verifiedAt:'2026-09-10T00:00:00Z'};};
  if(fail)await assert.rejects(upgrade(previous,target,{runtime:operations}),/previous release was restored/);
  else assert.equal((await upgrade(previous,target,{runtime:operations})).changed,true);
  assert.deepEqual(prepared.map(r=>r.knowledge.version),[target.knowledge.version,previous.knowledge.version]);
  for(const release of [...prepared,...installed]){assert.deepEqual(release.components,previous.components);assert.deepEqual(release.auxiliaryArtifacts,previous.auxiliaryArtifacts);}
  assert.equal(records.at(-1).phase,'Ready');assert.deepEqual(records.at(-1).release,fail?previous:target);
  assert(events.includes('wait-component:osaaGateway'));assert(!events.some(e=>e.startsWith('install:')));
 }
});

test('identical installed component target is observed again without duplicate apply after a lost response',async()=>{
 const {target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
 const events=[],result=await upgrade(target,structuredClone(target),{runtime:runtime(target,events)});
 assert.equal(result.changed,false);assert(!events.some(e=>/^(prepare|install|record|inventory|prune)/.test(e)));
 assert(events.some(e=>e.startsWith('verify:')));
});

test('deferred Knowledge retirement remains inventoried through successful upgrade and rollback', async () => {
  const previous = lock('1'.repeat(40), 'a'), target = lock('2'.repeat(40), 'b');
  const retained = { apiVersion: 'v1', kind: 'ConfigMap', namespace: 'opensphere-console', name: 'os-knowledge-' + 'a'.repeat(32) };
  for (const failTarget of [false, true]) {
    const events = [], operations = runtime(previous, events, { failTarget }), recorded = [];
    operations.pruneReleaseResources = () => [retained];
    operations.recordReleaseInventory = (release, inventory) => recorded.push({ revision: release.sourceRevision, inventory });
    if (failTarget) await assert.rejects(upgrade(previous, target, { runtime: operations }), /previous release was restored/);
    else await upgrade(previous, target, { runtime: operations });
    const last = recorded.at(-1);
    assert.equal(last.revision, failTarget ? previous.sourceRevision : target.sourceRevision);
    assert(last.inventory.some(item => item.name === retained.name));
  }
});

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

test('current C_API component release is upgrade-only and keeps a complete rollback lock', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest(
    'edge',
    previous.components,
    LOCAL_EDGE_TRUST,
    undefined,
    { auxiliaryArtifacts: previous.auxiliaryArtifacts }
  );
  const target = componentTarget(previous, '2'.repeat(40), ['consoleApi']);
  const events = [];
  const result = await upgrade(previous, target, {
    runtime: runtime(previous, events, { recordedInventory: [{ name: 'complete-release' }] })
  });
  assert.equal(result.changed, true);
  assert.equal(result.lock.components.console.image, previous.components.console.image);
  assert.ok(events.includes(`record:${target.sourceRevision}`));
  assert.ok(events.some((event) =>
    event.startsWith('install-component:') && event.includes(`:${target.sourceRevision}:consoleApi:migrations=true`)));
  assert.ok(events.includes(`prepare-component:${target.sourceRevision}:consoleApi:migrations=true`));
  assert.ok(events.includes(`prepare-component:${previous.sourceRevision}:consoleApi:migrations=false`));
  assert.equal(events.some((event) => event.startsWith('prepare:')), false);
  assert.ok(events.includes('wait-component:consoleApi'));
  assert.ok(events.includes(`verify:${target.sourceRevision}:consoleApi`));
  assert.ok(events.includes(`inventory:${target.sourceRevision}`));

  await assert.rejects(
    bootstrap(target, { progress: undefined }),
    /Component release locks are upgrade-only/
  );
});

test('component release preparation selects only target-owned current manifests', () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = componentTarget(previous, '2'.repeat(40), ['consoleApi']);
  const selected = componentReleaseManifestSpecs(target);
  assert.deepEqual(selected.foundation.map(({ path }) => path), ['apps/console-api/deploy.yaml']);
  assert.deepEqual(selected.base, []);

  const optional = componentTarget(previous, '2'.repeat(40), ['osaaGateway']);
  const optionalSelected = componentReleaseManifestSpecs(optional);
  assert.deepEqual(optionalSelected.foundation, []);
  assert.deepEqual(optionalSelected.base.map(({ path }) => path), ['apps/osaa-gateway/deploy.yaml']);
});

test('component rollout mapping covers bootstrap workloads and the activated OSAA Gateway', () => {
  assert.deepEqual(COMPONENT_ROLLOUTS.consoleApi, [
    ['opensphere-console', 'deployment/opensphere-console-api', '600s']
  ]);
  assert.deepEqual(COMPONENT_ROLLOUTS.extensionController, [
    ['opensphere-console', 'deployment/opensphere-extension-controller', '600s']
  ]);
  assert.deepEqual(COMPONENT_ROLLOUTS.beszelHub, [
    ['opensphere-monitoring', 'statefulset/beszel-hub', '600s']
  ]);
  assert.deepEqual(COMPONENT_ROLLOUTS.beszelAgent, [
    ['opensphere-monitoring', 'daemonset/beszel-agent', '600s']
  ]);
  assert.equal(Object.hasOwn(COMPONENT_ROLLOUTS, 'dupaController'), false);
  assert.deepEqual(COMPONENT_ROLLOUTS.osaaGateway, [
    ['opensphere-console', 'deployment/opensphere-console-osaa-gateway', '600s']
  ]);
  assert.equal(Object.hasOwn(COMPONENT_ROLLOUTS, 'backend'), false);
});

test('component release applies the complete single-owner C_API authority manifest', () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = componentTarget(previous, '2'.repeat(40), ['consoleApi']);
  const image = target.components.consoleApi.image;
  const selected = componentReleaseWorkloadManifests(target, {
    foundation: {
      release: [{
        path: 'apps/console-api/deploy.yaml',
        yaml: [
          'apiVersion: v1',
          'kind: Service',
          'metadata: { name: opensphere-console-api }',
          '---',
          'apiVersion: apps/v1',
          'kind: Deployment',
          'metadata: { name: opensphere-console-api }',
          'spec:',
          '  template:',
          '    spec:',
          '      containers:',
          '        - name: api',
          `          image: ${image}`,
        ].join('\n')
      }]
    },
    base: []
  });
  assert.equal(selected.length, 1);
  assert.match(selected[0].yaml, /name: opensphere-console-api/);
  assert.match(selected[0].yaml, new RegExp(image.replaceAll('.', '\\.')));
  assert.match(selected[0].yaml, /kind: Service/);
});

test('component release refuses to overwrite a missing complete release inventory', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest(
    'edge',
    previous.components,
    LOCAL_EDGE_TRUST,
    undefined,
    { auxiliaryArtifacts: previous.auxiliaryArtifacts }
  );
  const target = componentTarget(previous, '2'.repeat(40), ['consoleApi']);
  await assert.rejects(
    upgrade(previous, target, { runtime: runtime(previous, []) }),
    /requires the existing complete release inventory/
  );
});

test('failed C_API component verification restores only the previous C_API release', async () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest(
    'edge',
    previous.components,
    LOCAL_EDGE_TRUST,
    undefined,
    { auxiliaryArtifacts: previous.auxiliaryArtifacts }
  );
  const target = componentTarget(previous, '2'.repeat(40), ['consoleApi']);
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
  assert.ok(events.includes(`prepare-component:${target.sourceRevision}:consoleApi:migrations=true`));
  assert.ok(events.includes(`prepare-component:${previous.sourceRevision}:consoleApi:migrations=false`));
  assert.ok(events.includes(`verify:${previous.sourceRevision}:consoleApi`));
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

test('OAuth upgrade verifies supply chains but never forwards temporary credentials to runtime Secrets', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const credentials = Object.freeze({username: 'test-user', token: 'ephemeral-test-only-token', lifecycle: {mode: 'github-device'}});
  const checked = [];
  const operations = runtime(previous, events);
  operations.verifyReleaseLock = async (release, options) => {
    assert.equal(options.registryCredentials, credentials);
    checked.push(release.releaseDigest);
  };
  operations.ensureRegistryPullSecrets = (release, supplied) => {
    assert.equal(release.releaseDigest, target.releaseDigest);
    assert.equal(supplied, null, 'runtime credential authority must be preserved');
    events.push('preserved-registry-owner');
    return {credentialSource: 'console-managed'};
  };
  const result = await upgrade(previous, target, {registryCredentials: credentials, runtime: operations});
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(checked), new Set([previous.releaseDigest, target.releaseDigest]));
  assert.ok(events.includes('preserved-registry-owner'));
});

test('OAuth upgrade cannot repair missing runtime credentials with the temporary login', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  const events = [];
  const operations = runtime(previous, events);
  operations.ensureRegistryPullSecrets = (_release, supplied) => {
    assert.equal(supplied, null);
    throw new Error('Runtime-owned registry pull Secrets are incomplete');
  };
  await assert.rejects(upgrade(previous, target, {
    registryCredentials: {lifecycle: {mode: 'github-device'}}, runtime: operations
  }), /Runtime-owned registry pull Secrets are incomplete/);
  assert.equal(events.some(event => event.startsWith('install:')), false);
  assert.equal(events.some(event => event.startsWith('record:')), false);
});

test('upgrade and rollback enter Installing before verification and Ready only with evidence', async () => {
  const previous = lock('1'.repeat(40), 'a');
  const target = lock('2'.repeat(40), 'b');
  for (const failTarget of [false, true]) {
    const phases = [];
    let current;
    const operations = runtime(previous, []);
    operations.recordInstallationState = (release, _storage, _admin, _url, _auth, _tls, phase, options) => {
      assert.ok(['Installing', 'Ready'].includes(phase));
      if (phase === 'Ready') {
        assert.equal(options.verification.evidenceConfigMap, 'opensphere-installation-evidence');
        assert.equal(options.verification.verifiedAt, '2026-09-03T09:00:00.000Z');
      }
      current = { revision: release.sourceRevision, phase };
      phases.push(current);
    };
    operations.verifyInstallation = async (release) => {
      assert.equal(current.phase, 'Installing');
      assert.equal(current.revision, release.sourceRevision);
      if (failTarget && release.sourceRevision === target.sourceRevision) throw new Error('unhealthy target');
      return { releaseDigest: release.releaseDigest, verifiedAt: '2026-09-03T09:00:00.000Z' };
    };
    if (failTarget) await assert.rejects(upgrade(previous, target, { runtime: operations }), /previous release was restored/);
    else await upgrade(previous, target, { runtime: operations });
    assert.deepEqual(phases.at(-1), { revision: failTarget ? previous.sourceRevision : target.sourceRevision, phase: 'Ready' });
    if (failTarget) assert.equal(phases.some(state => state.revision === target.sourceRevision && state.phase === 'Ready'), false);
  }
});
