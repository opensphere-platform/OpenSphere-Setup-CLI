import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertForwardRepair,installationRecordDigest} from '../src/forward-repair.mjs';
import {chainVerdict,describeChainVerdict} from '../src/one-way-migrations.mjs';
import {
  bootstrap,
  COMPONENT_ROLLOUTS,
  componentReleaseManifestSpecs,
  componentReleaseWorkloadManifests,
  renderManifest,
  terminalPodError,
  upgrade,
  completeInstallationVerification,
  confirmRecordWrite,
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

// The installation record ConfigMap as upgrade() sees it: a Ready record of the installed release,
// a uid and a resourceVersion that every write advances, and the recordPrecondition check.
function recordStore(release, state = { phase: 'Ready', verification: { evidenceConfigMap: 'opensphere-installation-evidence', verifiedAt: '2026-09-26T00:00:00Z' } }) {
  const store = { uid: 'installation-record-uid', rv: 1, release, state: { releaseDigest: release.releaseDigest, ...state } };
  store.read = () => ({ apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { namespace: 'opensphere-console', name: 'opensphere-installation-lock', uid: store.uid, resourceVersion: String(store.rv) },
    data: { 'release.json': JSON.stringify(store.release), 'config.json': JSON.stringify({ architecture: 'supabase-data-identity+gitea-change-authority', releaseDigest: store.release.releaseDigest,
        consoleUrl: 'https://localhost:8090', storageClass: 'hostpath', authEnvironment: 'development', initialAdmin: { username: 'opensphere-admin' } }),
      'state.json': JSON.stringify({ apiVersion: 'bootstrap.opensphere.io/v1alpha1', kind: 'OpenSphereInstallationState', ...store.state }) } });
  store.write = (written, phase = 'Preparing', options = {}) => {
    const p = options.recordPrecondition;
    if (p && (p.uid !== store.uid || p.resourceVersion !== String(store.rv))) throw new Error('installation record precondition failed');
    store.release = written;
    store.state = { phase, releaseDigest: written.releaseDigest,
      ...(options.failureCode ? { failureCode: options.failureCode } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
      ...(options.transition ? { transition: options.transition } : {}) };
    store.rv += 1;
    // What a PATCH response reports: this write's own resulting version.
    return { record: { uid: store.uid, resourceVersion: String(store.rv) } };
  };
  return store;
}

function runtime(previous, events, {
  failTarget = false,
  failMigration = false,
  recordedInventory = null,
  store = recordStore(previous)
} = {}) {
  return {
    store,
    readInstallationRecord: () => store.read(),
    verifyReleaseLock: async (release, options) =>
      events.push(`supply:${release.sourceRevision}:${options?.allowLegacyComponentSet === true}`),
    ensureManagedNamespaces: () => events.push('namespaces'),
    ensureRegistryPullSecrets: () => events.push('registry'),
    readInstallationLock: () => previous,
    readBeszelBootstrapHistory: () => null,
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
    prepareForwardRepairInventory: async()=>({inventory:recordedInventory ?? [],manifests:[]}),
    runForwardRepairBootstrap: ()=>{events.push('bootstrap-proof');return {completed:true};},
    recordReleaseInventory: (release) => events.push(`inventory:${release.sourceRevision}`),
    pruneReleaseResources: (from, to) => {
      events.push(`prune:${from[0]?.name ?? 'none'}->${to[0]?.name ?? 'none'}`);
      return [];
    },
    deleteAgentIdentityNamespace: (namespace) => events.push(`delete-namespace:${namespace}`),
    recordInstallationState: (release, _storageClass, _admin, _url, _auth, _tls, phase, options) => {
      const written = store.write(release, phase, options);
      events.push(`record:${release.sourceRevision}`);
      return written;
    },
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

test('normal upgrade captures bootstrap history before Installing and retains it for failed-target rollback', async()=>{
  for(const failTarget of [false,true]) {
    const previous=lock('a'.repeat(40),'a'),target=lock('b'.repeat(40),'b');
    const events=[],operations=runtime(previous,events,{failTarget});
    const history=Object.freeze({scope:'test-bootstrap-history'});
    let captured=false,verified=0;
    operations.readBeszelBootstrapHistory=release=>{
      assert.equal(release,previous);assert.equal(events.some(e=>e.startsWith('record:')),false);
      captured=true;return history;
    };
    const record=operations.recordInstallationState,verify=operations.verifyInstallation;
    operations.recordInstallationState=(...args)=>{assert.equal(captured,true);return record(...args);};
    operations.verifyInstallation=async(release,options)=>{
      assert.equal(options.bootstrapHistory,history);verified++;return verify(release,options);
    };
    if(failTarget)await assert.rejects(upgrade(previous,target,{runtime:operations}),/previous release was restored/);
    else await upgrade(previous,target,{runtime:operations});
    assert.equal(verified,failTarget?2:1);
  }
});

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

test('missing inventory is reconstructed only for explicit repair and never adopts arbitrary live objects',async()=>{
  const {previous,target,record,config}=repairFixture(),events=[];
  const operations=runtime(previous,events),states=[];
  operations.readInstallationRecord=()=>structuredClone(record);
  operations.readInstallationConfig=()=>config;
  operations.currentKubeContext=()=> 'docker-desktop';
  const fixed=[{apiVersion:'v1',kind:'Service',namespace:'opensphere-console-data',name:'declared-backbone'}];
  operations.prepareForwardRepairInventory=async release=>{
    assert.equal(release.releaseDigest,target.releaseDigest);events.push('recover-inventory');return {inventory:fixed,manifests:[]};
  };
  operations.recordReleaseInventory=(_release,items)=>{
    assert.ok(items.some(i=>i.name==='declared-backbone'));
    assert.ok(!items.some(i=>i.name==='unrelated-live-object'));
  };
  operations.recordInstallationState=(release,_sc,_admin,_url,_env,_tls,phase,options)=>{
    assert.equal(options.forwardRepair.inventoryReconstruction,'governed-source-manifests');
    record.data['release.json']=JSON.stringify(release);record.metadata.resourceVersion+='1';states.push(phase);
  };
  operations.verifyInstallation=async()=>({verifiedAt:'2026-09-12T00:00:00Z'});
  await upgrade(previous,target,{runtime:operations,forwardRepairRecordDigest:installationRecordDigest(record)});
  assert.equal(states.at(-1),'Ready');assert.ok(events.includes('recover-inventory'));
  assert.ok(!events.some(e=>e.startsWith('prune:')));
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
  operations.recordInstallationState=(release,_sc,_admin,_url,_env,_tls,phase,options)=>{records.push({release:structuredClone(release),phase});return operations.store.write(release,phase,options);};
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

function preWorkerLock() {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  delete previous.components.r2d2HermesWorker;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, previous.trust, undefined, { auxiliaryArtifacts: previous.auxiliaryArtifacts });
  return previous;
}

test('integrated upgrade adds the R2D2 Hermes worker to a pre-worker installation', async () => {
  const previous = preWorkerLock();
  const target = lock('2'.repeat(40), 'b');
  target.trust = LOCAL_EDGE_TRUST;
  delete target.releaseBom;
  target.releaseDigest = calculateReleaseDigest('edge', target.components, target.trust, undefined, { auxiliaryArtifacts: target.auxiliaryArtifacts });
  assert.equal(Object.hasOwn(target.components, 'r2d2HermesWorker'), true);
  const events = [];
  const result = await upgrade(previous, target, { runtime: runtime(previous, events) });
  assert.equal(result.changed, true);
  assert.equal(result.lock.components.r2d2HermesWorker.image, target.components.r2d2HermesWorker.image);
  assert.ok(events.includes(`supply:${previous.sourceRevision}:true`));
  assert.ok(events.includes(`supply:${target.sourceRevision}:false`));
  assert.ok(events.includes(`install:업그레이드:${target.sourceRevision}`));
  assert.ok(events.includes(`record:${target.sourceRevision}`));
});

test('a component-scope release cannot introduce the R2D2 Hermes worker', async () => {
  const previous = preWorkerLock();
  const target = structuredClone(previous);
  target.releaseScope = RELEASE_SCOPE_COMPONENT;
  target.baseReleaseDigest = previous.releaseDigest;
  target.changedComponents = ['r2d2HermesWorker'];
  target.sourceRevision = '2'.repeat(40);
  target.components.r2d2HermesWorker = {
    repository: COMPONENTS.r2d2HermesWorker,
    image: `ghcr.io/opensphere-platform/${COMPONENTS.r2d2HermesWorker}@sha256:${'c'.repeat(64)}`,
    sourceRevision: target.sourceRevision
  };
  target.releaseDigest = calculateReleaseDigest(target.channel, target.components, target.trust, undefined, {
    releaseScope: target.releaseScope,
    baseReleaseDigest: target.baseReleaseDigest,
    changedComponents: target.changedComponents,
    auxiliaryArtifacts: target.auxiliaryArtifacts
  });
  const events = [];
  await assert.rejects(
    upgrade(previous, target, { runtime: runtime(previous, events) }),
    /cannot change the installed component set/u
  );
  assert.deepEqual(events, []);
});

test('worker and Gateway component releases apply the complete shared Gateway manifest', () => {
  const previous = lock('1'.repeat(40), 'a');
  previous.trust = LOCAL_EDGE_TRUST;
  delete previous.releaseBom;
  previous.releaseDigest = calculateReleaseDigest('edge', previous.components, previous.trust, undefined, { auxiliaryArtifacts: previous.auxiliaryArtifacts });
  for (const changed of [['r2d2HermesWorker'], ['osaaGateway'], ['osaaGateway', 'r2d2HermesWorker']]) {
    const target = componentTarget(previous, '2'.repeat(40), changed);
    const specs = componentReleaseManifestSpecs(target);
    assert.deepEqual(specs.foundation, []);
    assert.deepEqual(specs.base.map(({ path }) => path), ['apps/osaa-gateway/deploy.yaml']);
    assert.equal(specs.base[0].artifactSourceRevision, target.sourceRevision);
    const yaml = [
      'apiVersion: v1',
      'kind: ServiceAccount',
      'metadata: { name: opensphere-console-osaa-gateway }',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata: { name: opensphere-console-osaa-gateway }',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: gateway',
      `          image: ${target.components.osaaGateway.image}`,
      '        - name: hermes-worker',
      `          image: ${target.components.r2d2HermesWorker.image}`,
      ''
    ].join('\n');
    const selected = componentReleaseWorkloadManifests(target, {
      foundation: { release: [] },
      base: [{ path: 'apps/osaa-gateway/deploy.yaml', yaml }]
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].yaml, yaml);
    assert.match(selected[0].yaml, /kind: ServiceAccount/u);
  }
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
  assert.deepEqual(COMPONENT_ROLLOUTS.r2d2HermesWorker, [
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
  operations.ensureRegistryPullSecrets = (release, supplied, options) => {
    assert.equal(release.releaseDigest, target.releaseDigest);
    assert.equal(supplied, null, 'runtime credential authority must be preserved');
    assert.deepEqual(options,{requireRuntimeReady:true});
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
      return operations.store.write(release, phase, options);
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

// Review R1 and re-review F1–F3 (2026-09-26): the R2D2 task engine cutover is one-way. The ledger
// must be an exact prefix of the target chain; after the cutover commits, or when that cannot be
// established, no earlier release is installed; an ordinary upgrade starts only from Ready; a
// Failed or stale installation is recovered explicitly and never rolled back.
const CHAIN_REVISION = '3'.repeat(40);
const chainEntry = (n, semanticKey, previousNumber) => ({
  globalId: `opensphere-console/20260924/00${n}`, semanticKey,
  predecessorGlobalId: previousNumber ? `opensphere-console/20260924/00${previousNumber}` : '',
  sha256: `sha256:${String(n % 10).repeat(64)}`, sourceRevision: CHAIN_REVISION,
  setDigest: `sha256:${'5'.repeat(64)}`, setSize: n
});
const BEFORE = chainEntry(76, 'console.shell.module_mfa_retry', 75);
const CUTOVER = chainEntry(80, 'console.osdst.task_engine_cutover', 76);
const AFTER = chainEntry(88, 'console.osaa.semantic_routing_policy', 80);
const CHAIN = Object.freeze({ schemaVersion: 1, migrations: [BEFORE, CUTOVER, AFTER] });
const PRE_CUTOVER_CHAIN = Object.freeze({ schemaVersion: 1, migrations: [BEFORE] });
const row = (e) => [e.globalId, e.semanticKey, e.predecessorGlobalId, e.sha256, e.sourceRevision, e.setDigest, String(e.setSize)];
const localEdge = (release) => {
  release.trust = LOCAL_EDGE_TRUST;
  delete release.releaseBom;
  release.releaseDigest = calculateReleaseDigest('edge', release.components, release.trust, undefined, { auxiliaryArtifacts: release.auxiliaryArtifacts });
  return release;
};
function cutoverRuntime(previous, target, events, {
  ledger, failTarget = false, recordedInventory = null, store = recordStore(previous), previousChain = PRE_CUTOVER_CHAIN, chain = CHAIN,
  rollbackChain = previousChain, ownerChain = previousChain, on = {}
}) {
  const base = runtime(previous, events, { failTarget, recordedInventory, store });
  const withChain = (release, prepared, manifest = chain) => release.releaseDigest !== target.releaseDigest ? prepared
    : { ...prepared, foundation: { ...prepared.foundation, migration: { manifest } } };
  // Like the real preparation: the target gets its own chain; the previous release gets the target's
  // chain when prepared as the ordinary rollback (migrationSourceRevision), otherwise its own.
  const prepared = (release, result, options = {}) => {
    if (release.releaseDigest === target.releaseDigest) return withChain(release, result);
    const own = !options.migrationSourceRevision;
    if (own) events.push(`prepare-own-chain:${release.sourceRevision}`);
    return { ...result, foundation: { ...result.foundation, migration: { manifest: own ? previousChain : chain, source: own ? 'own' : 'target' } } };
  };
  return {
    ...base,
    readInstallationLock: () => store.release,
    prepareRelease: async (release, root, sc, url, auth, options = {}) => {
      on.prepare?.(release, options);
      return prepared(release, await base.prepareRelease(release, root, sc, url, auth, options), options);
    },
    prepareComponentRelease: async (release, ...rest) => withChain(release, await base.prepareComponentRelease(release, ...rest)),
    readMigrationLedger: () => {
      events.push('ledger');
      if (on.ledger) return on.ledger();
      return ledger.map(row);
    },
    // The migration owners' chains (does the release fit a crossed cutover) and the chain a rollback
    // hands its installers (does it apply nothing) are separate reads, as in the product.
    readReleaseMigrationManifests: async (release) => { events.push(`previous-chain:${release.sourceRevision}`); if (on.ownerChain) return on.ownerChain(); return [ownerChain]; },
    readRollbackMigrationChain: async (release) => { events.push(`rollback-chain-read:${release.sourceRevision}`); if (on.rollbackChain) return on.rollbackChain(); return rollbackChain; },
    installPreparedRelease: (release, prepared, storageClass, consoleUrl, label) => {
      events.push(`install:${label}:${release.sourceRevision}`);
      if (label === '롤백') {
        // The installers apply every migration of the chain they are given that the ledger lacks.
        events.push(`rollback-chain:${prepared.foundation?.migration?.source ?? 'none'}`);
      }
      if (label === '업그레이드') on.install?.();
    },
    installPreparedComponentRelease: (release, prepared, storageClass, consoleUrl, label, changed) => {
      events.push(`install-component:${label}:${release.sourceRevision}:${changed.join(',')}`);
      if (label === '업그레이드') on.install?.();
    },
    waitForCoreRollouts: () => { events.push('wait'); on.wait?.(); },
    recordInstallationState: (release, _storageClass, _admin, _url, _auth, _tls, phase = 'Preparing', options = {}) => {
      on.record?.(phase, options);
      const written = store.write(release, phase, options);
      events.push(`record:${release.sourceRevision}:${phase}:${options.failureCode ?? ''}`);
      on.afterRecord?.(phase, options);
      return written;
    },
  };
}
const installs = (events) => events.filter((e) => e.startsWith('install'));
const earlierInstalls = (events) => events.filter((e) => e.startsWith('install:롤백') || e.startsWith('install-component:롤백'));
const activation = () => ({ previous: preWorkerLock(), target: localEdge(lock('2'.repeat(40), 'b')) });
function assertTargetKept(events, store, target, failureCode) {
  assert.deepEqual(earlierInstalls(events), [], 'no earlier release is installed after the cutover');
  assert.equal(events.some((e) => e.startsWith('prune:')), false, 'nothing is pruned, the worker included');
  assert.ok(events.includes(`inventory:${target.sourceRevision}`));
  assert.equal(store.release.releaseDigest, target.releaseDigest);
  assert.equal(store.state.phase, 'Failed'); assert.equal(store.state.failureCode, failureCode);
  assert.equal(store.state.transition.targetReleaseDigest, target.releaseDigest);
  assert.equal(store.state.transition.outcome.rollbackAvailable, false);
}

test('one-way cutover: a failure before any target migration restores the previous release with its own chain', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, {
    ledger: [BEFORE], store, on: { install: () => { throw new Error('Gitea bootstrap failed'); } } }) }),
  /previous release was restored: Gitea bootstrap failed/);
  assert.deepEqual(earlierInstalls(events), [`install:롤백:${previous.sourceRevision}`]);
  // Given the target's chain, the previous release's installers would apply the cutover while "rolling back".
  assert.deepEqual(events.filter((e) => e.startsWith('rollback-chain:')), ['rollback-chain:own']);
  assert.ok(events.indexOf(`prepare-own-chain:${previous.sourceRevision}`) < events.findIndex((e) => e.startsWith('record:')),
    'the own-chain rollback is prepared before the first change');
  assert.equal(store.release.releaseDigest, previous.releaseDigest); assert.equal(store.state.phase, 'Ready');
});

// A chain with a target migration between the installed release and the cutover.
const MID = chainEntry(77, 'console.agent.turn_budget', 76);
const CUTOVER_AFTER_MID = chainEntry(80, 'console.osdst.task_engine_cutover', 77);
const CHAIN_WITH_MID = Object.freeze({ schemaVersion: 1, migrations: [BEFORE, MID, CUTOVER_AFTER_MID, AFTER] });

test('one-way cutover: target migrations before it without it keep the target; no installer goes back through it', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous), ledger = [BEFORE];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store, chain: CHAIN_WITH_MID,
    on: { install: () => { ledger.push(MID); throw new Error('migration 0078 failed'); } } }) }),
  (e) => /partial-migration-recovery-required: upgrade failed and 1 target migration\(s\) committed before R2D2 task engine cutover \(opensphere-console\/20260924\/0080\), which did not/.test(e.message)
    && /earlier release was not reinstalled/.test(e.message));
  assertTargetKept(events, store, target, 'partial-migration-recovery-required');
  assert.deepEqual(store.state.transition.outcome.committed, []);
  assert.equal(store.state.transition.outcome.appliedMigrations, 2);
  assert.match(store.state.transition.outcome.reason, /1 target migration\(s\) committed before R2D2 task engine cutover .*no longer fits the database without applying it/);
});

for (const [name, previousChain, ledger, pattern] of [
  ['lacks a migration the database has', Object.freeze({ schemaVersion: 1, migrations: [] }), [BEFORE],
    /cannot promise a rollback that applies nothing .*: the database has 1 migration\(s\) beyond the previous release's chain.*Stopped before any change/],
  ['has migrations the database lacks (its installers would apply them)', CHAIN_WITH_MID, [BEFORE],
    /cannot promise a rollback that applies nothing .*: the previous release's installers would apply 3 migration\(s\) the database lacks.*Stopped before any change/],
  ['differs from the database at a row', Object.freeze({ schemaVersion: 1, migrations: [{ ...BEFORE, sha256: `sha256:${'e'.repeat(64)}` }] }), [BEFORE],
    /cannot promise a rollback that applies nothing .*: the database differs from the previous release's chain at migration 1/],
]) {
  test(`one-way cutover: a previous release whose own chain ${name} stops the upgrade before any change`, async () => {
    const { previous, target } = activation(), events = [], store = recordStore(previous);
    await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store, previousChain }) }),
      pattern);
    assert.deepEqual(installs(events), []); assert.equal(store.rv, 1, 'the installation record is untouched');
  });
}

test('one-way cutover: the own-chain rollback cannot be prepared, so the upgrade stops before any change', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store,
    on: { prepare: (release, options) => { if (release.releaseDigest === previous.releaseDigest && !options.migrationSourceRevision) throw new Error('previous migration manifest unavailable'); } } }) }),
  /previous migration manifest unavailable/);
  assert.deepEqual(installs(events), []); assert.equal(store.rv, 1);
});

for (const [name, on, failTarget, pattern] of [
  ['right after it commits (rollout timeout)', (ledger) => ({ install: () => ledger.push(CUTOVER), wait: () => { throw new Error('rollout timed out'); } }), false, /rollout timed out/],
  ['when a later migration fails after it', (ledger) => ({ install: () => { ledger.push(CUTOVER); throw new Error('migration 0081 failed'); } }), false, /migration 0081 failed/],
  ['when verification fails after every migration', (ledger) => ({ install: () => ledger.push(CUTOVER, AFTER) }), true, /target is unhealthy/],
]) {
  test(`one-way cutover: the target is kept ${name}`, async () => {
    const { previous, target } = activation(), events = [], store = recordStore(previous), ledger = [BEFORE];
    await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store, failTarget, on: on(ledger) }) }),
      (e) => /one-way-migration-recovery-required: .*R2D2 task engine cutover \(opensphere-console\/20260924\/0080\) committed; the earlier release was not reinstalled/.test(e.message) && pattern.test(e.message));
    assertTargetKept(events, store, target, 'one-way-migration-recovery-required');
    assert.deepEqual(store.state.transition.outcome.committed, [CUTOVER.globalId]);
  });
}

for (const [name, after] of [
  ['unreadable', () => { throw new Error('database unavailable'); }],
  ['shrunk (a row it had is gone)', () => []],
  ['changed at a known row (same id, other key)', () => [[BEFORE.globalId, 'console.other', ...row(BEFORE).slice(2)]]],
  ['malformed', () => [['only', 'two']]],
]) {
  test(`one-way cutover: a ledger that is ${name} after a failure counts as unknown`, async () => {
    const { previous, target } = activation(), events = [], store = recordStore(previous);
    let failed = false;
    await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store,
      on: { ledger: () => failed ? after() : [row(BEFORE)], install: () => { failed = true; throw new Error('database pod restarted'); } } }) }),
    /one-way-migration-state-unknown: .*cannot be established whether R2D2 task engine cutover/);
    assertTargetKept(events, store, target, 'one-way-migration-state-unknown');
    assert.equal(store.state.transition.outcome.committed, null);
  });
}

for (const [name, rows] of [
  ['unreadable', () => { throw new Error('no Ready database pod'); }],
  ['a row with the same id and another key', () => [[BEFORE.globalId, 'console.other', ...row(BEFORE).slice(2)]]],
  ['a row with another file hash', () => [[...row(BEFORE).slice(0, 3), `sha256:${'f'.repeat(64)}`, ...row(BEFORE).slice(4)]]],
  ['a row at the wrong position (same key, other id)', () => [row(CUTOVER)]],
  ['ahead of the target chain', () => [row(BEFORE), row(CUTOVER), row(AFTER), row(AFTER)]],
  ['malformed', () => 'not rows'],
]) {
  test(`one-way cutover: a ledger that is ${name} before the upgrade stops it before any workload, migration or record change`, async () => {
    const { previous, target } = activation(), events = [], store = recordStore(previous);
    await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [], store, on: { ledger: rows } }) }),
      /stopped before any workload, migration or installation record change/);
    assert.deepEqual(installs(events), []); assert.equal(store.rv, 1, 'the installation record is untouched');
  });
}

test('one-way cutover: when recording the failure also fails, a retry from the unchanged lock is refused (F1)', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous), ledger = [BEFORE];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store,
    on: { install: () => { ledger.push(CUTOVER); throw new Error('migration 0081 failed'); }, record: (phase) => { if (phase === 'Failed') throw new Error('API server unavailable'); } } }) }),
  /the earlier release was not reinstalled, and the installation record could not be updated \(API server unavailable\)/);
  assert.deepEqual(earlierInstalls(events), []);
  // The claim written before the first change still names the interrupted transition.
  assert.equal(store.release.releaseDigest, previous.releaseDigest); assert.equal(store.state.phase, 'Installing');
  assert.equal(store.state.transition.targetReleaseDigest, target.releaseDigest);
  // The CLI reads the current lock, so it retries upgrade(previous, target): refused before any change.
  const again = [];
  await assert.rejects(upgrade(store.release, target, { runtime: cutoverRuntime(previous, target, again, { ledger, store, failTarget: true }) }),
    /installation is Installing; an ordinary upgrade starts only from a Ready installation/);
  assert.deepEqual(installs(again), []);
});

test('one-way cutover: a Ready record of a release that predates a crossed cutover is refused, then recovered forward only (F1)', async () => {
  const { previous, target } = activation(), store = recordStore(previous), ledger = [BEFORE, CUTOVER];
  const refused = [];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, refused, { ledger, store }) }),
    /already passed R2D2 task engine cutover .* predates it .* Stopped before any workload, migration or installation record change/);
  assert.deepEqual(installs(refused), []); assert.equal(store.rv, 1);
  // An unreadable previous chain is not taken as fitting either.
  const unknown = [];
  const failingChain = { ...cutoverRuntime(previous, target, unknown, { ledger, store }), readReleaseMigrationManifests: async () => { throw new Error('source unavailable'); } };
  await assert.rejects(upgrade(previous, target, { runtime: failingChain }), /predates it or that cannot be established/);
  // Explicit recovery bound to the reviewed record goes forward and, failing again, never goes back.
  const recovered = [];
  await assert.rejects(upgrade(previous, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(previous, target, recovered, { ledger, store, failTarget: true }) }),
  /one-way-migration-recovery-required: .*committed; the earlier release was not reinstalled/);
  assert.deepEqual(earlierInstalls(recovered), []);
  assert.ok(recovered.includes(`install:업그레이드:${target.sourceRevision}`));
  assert.equal(recovered.some((e) => e.startsWith('supply:1111')), false, 'the earlier release is not fetched for a rollback');
  assert.equal(store.state.transition.mode, 'one-way-recovery');
  assert.equal(store.state.transition.rollback, 'never');
});

test('one-way cutover: a Failed target is not an ordinary rollback point; recovery never restores it (F2)', async () => {
  const { target } = activation(), next = localEdge(lock('4'.repeat(40), 'c'));
  const store = recordStore(target, { phase: 'Failed', failureCode: 'one-way-migration-recovery-required' });
  const ledger = [BEFORE, CUTOVER];
  const ordinary = [];
  await assert.rejects(upgrade(target, next, { runtime: cutoverRuntime(target, next, ordinary, { ledger, store, previousChain: CHAIN }) }),
    /installation is Failed \(one-way-migration-recovery-required\); an ordinary upgrade starts only from a Ready installation/);
  assert.deepEqual(installs(ordinary), []);
  const stale = [];
  await assert.rejects(upgrade(target, next, { oneWayRecoveryRecordDigest: `sha256:${'0'.repeat(64)}`,
    runtime: cutoverRuntime(target, next, stale, { ledger, store, previousChain: CHAIN }) }), /review a fresh recovery plan/);
  assert.deepEqual(installs(stale), []);
  const recovered = [];
  await assert.rejects(upgrade(target, next, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(target, next, recovered, { ledger, store, previousChain: CHAIN, failTarget: true }) }),
  /one-way-migration-recovery-required: .*the earlier release was not reinstalled/);
  assert.deepEqual(earlierInstalls(recovered), [], 'the Failed target is never restored');
  assert.equal(store.release.releaseDigest, next.releaseDigest); assert.equal(store.state.phase, 'Failed');
});

test('one-way cutover: recovery re-applies the same Failed target forward and ends Ready only with verification', async () => {
  const { target } = activation();
  const store = recordStore(target, { phase: 'Failed', failureCode: 'one-way-migration-recovery-required' });
  const events = [];
  const result = await upgrade(target, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(target, target, events, { ledger: [BEFORE, CUTOVER, AFTER], store, previousChain: CHAIN }) });
  assert.equal(result.changed, true);
  assert.deepEqual(installs(events), [`install:업그레이드:${target.sourceRevision}`]);
  assert.equal(store.state.phase, 'Ready'); assert.equal(store.state.verification?.evidenceConfigMap, 'opensphere-installation-evidence');
  // Observing the same release without recovery installs nothing and leaves a Failed state Failed.
  const failed = recordStore(target, { phase: 'Failed', failureCode: 'one-way-migration-recovery-required' });
  const observe = [];
  await upgrade(target, target, { runtime: cutoverRuntime(target, target, observe, { ledger: [BEFORE, CUTOVER], store: failed }) });
  assert.deepEqual(installs(observe), []); assert.equal(failed.state.phase, 'Failed');
});

test('one-way cutover: recovery is refused for a Ready installation whose release fits the database', async () => {
  const previous = localEdge(lock('1'.repeat(40), 'a')), target = localEdge(lock('2'.repeat(40), 'b'));
  const store = recordStore(previous), events = [];
  await assert.rejects(upgrade(previous, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE, CUTOVER], store, previousChain: CHAIN }) }), /use an ordinary upgrade/);
  assert.deepEqual(installs(events), []);
});

test('one-way cutover: a Ready release whose own chain the database outgrew is no dead end; recovery goes forward', async () => {
  const { previous, target } = activation(), store = recordStore(previous), ledger = [BEFORE, MID];
  const events = [];
  // An ordinary upgrade cannot promise a rollback that applies nothing, so it stops before any change ...
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store, chain: CHAIN_WITH_MID }) }),
    /cannot promise a rollback that applies nothing .*database has 1 migration\(s\) beyond .*--one-way-recovery-plan/);
  assert.deepEqual(installs(events), []); assert.equal(store.rv, 1);
  // ... and the reviewed forward-only recovery is accepted from Ready.
  const recovered = [];
  const result = await upgrade(previous, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(previous, target, recovered, { ledger, store, chain: CHAIN_WITH_MID,
      on: { install: () => ledger.push(CUTOVER_AFTER_MID, AFTER) } }) });
  assert.equal(result.changed, true);
  assert.deepEqual(installs(recovered), [`install:업그레이드:${target.sourceRevision}`]);
  assert.equal(store.release.releaseDigest, target.releaseDigest); assert.equal(store.state.phase, 'Ready');
});

// Re-review 5, F5-1: the ordinary upgrade and a Ready recovery decide from one judgement of the chain
// a rollback hands its installers, not from the migration owners' chains, and a read failure is
// never a verdict.
const MID_CHAIN = Object.freeze({ schemaVersion: 1, migrations: [BEFORE, MID] });
async function attemptOverMid({ ledger, recovery = false, on = {}, ...options }) {
  const { previous, target } = activation(), store = recordStore(previous), events = [], live = [...ledger];
  let error = null, result = null;
  try {
    result = await upgrade(previous, target, { ...(recovery ? { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()) } : {}),
      runtime: cutoverRuntime(previous, target, events, { ledger: live, store, chain: CHAIN_WITH_MID, ...options,
        on: { install: () => { if (live.length === 1) live.push(MID); live.push(CUTOVER_AFTER_MID, AFTER); }, ...on } }) });
  } catch (e) { error = e.message; }
  return { error, changed: result?.changed ?? false, installs: installs(events), events, store };
}

test('F5-1: the rollback chain behind the ledger while the owners\' chain matches it: the upgrade stops, recovery goes forward', async () => {
  const setup = { ledger: [BEFORE, MID], rollbackChain: PRE_CUTOVER_CHAIN, ownerChain: MID_CHAIN };
  const ordinary = await attemptOverMid(setup);
  assert.match(ordinary.error, /database has 1 migration\(s\) beyond the previous release's chain.*--one-way-recovery-plan/);
  assert.deepEqual(ordinary.installs, []); assert.equal(ordinary.store.rv, 1);
  const recovered = await attemptOverMid({ ...setup, recovery: true });
  assert.equal(recovered.error, null); assert.equal(recovered.changed, true);
  assert.deepEqual(recovered.installs, [`install:업그레이드:${'2'.repeat(40)}`]);
});

test('F5-1: the rollback chain equal to the ledger while the owners\' chain differs: the upgrade runs, recovery is refused', async () => {
  const setup = { ledger: [BEFORE], rollbackChain: PRE_CUTOVER_CHAIN, ownerChain: MID_CHAIN };
  const ordinary = await attemptOverMid(setup);
  assert.equal(ordinary.error, null); assert.equal(ordinary.changed, true);
  const recovery = await attemptOverMid({ ...setup, recovery: true });
  assert.match(recovery.error, /Ready and its release fits the database; use an ordinary upgrade/);
  assert.deepEqual(recovery.installs, []); assert.equal(recovery.store.rv, 1);
});

test('F5-1: an unreadable rollback chain is not a verdict; neither route proceeds and recovery is not admitted', async () => {
  const unreadable = { ledger: [BEFORE], on: { rollbackChain: () => { throw new Error('manifest transport unavailable'); } } };
  for (const recovery of [false, true]) {
    const attempt = await attemptOverMid({ ...unreadable, recovery });
    assert.match(attempt.error, /could not be established \(manifest transport unavailable\); stopped before any change/, `recovery=${recovery}`);
    assert.deepEqual(attempt.installs, []); assert.equal(attempt.store.rv, 1);
  }
  // The owners' chains answer another question; their read failing does not admit a Ready recovery.
  const ownerUnreadable = await attemptOverMid({ ledger: [BEFORE], recovery: true, on: { ownerChain: () => { throw new Error('owner manifest unavailable'); } } });
  assert.match(ownerUnreadable.error, /use an ordinary upgrade/); assert.deepEqual(ownerUnreadable.installs, []);
});

test('F5-1 control: matching chains run the ordinary upgrade and refuse a Ready recovery', async () => {
  const ordinary = await attemptOverMid({ ledger: [BEFORE] });
  assert.equal(ordinary.error, null); assert.equal(ordinary.changed, true);
  assert.ok(ordinary.events.includes(`rollback-chain-read:${preWorkerLock().sourceRevision}`));
  const recovery = await attemptOverMid({ ledger: [BEFORE], recovery: true });
  assert.match(recovery.error, /use an ordinary upgrade/); assert.deepEqual(recovery.installs, []);
});

test('F5-1 control: past the cutover, a Ready release that includes it is refused recovery without judging the rollback chain', async () => {
  const previous = localEdge(lock('1'.repeat(40), 'a')), target = localEdge(lock('2'.repeat(40), 'b'));
  const store = recordStore(previous), events = [];
  await assert.rejects(upgrade(previous, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE, CUTOVER], store, previousChain: CHAIN, rollbackChain: PRE_CUTOVER_CHAIN }) }),
  /use an ordinary upgrade/);
  assert.equal(events.some((e) => e.startsWith('rollback-chain-read:')), false);
  assert.deepEqual(installs(events), []);
});

test('F5-1: a prepared rollback that carries another chain than the judged one stops before any change', async () => {
  const attempt = await attemptOverMid({ ledger: [BEFORE], rollbackChain: PRE_CUTOVER_CHAIN, previousChain: MID_CHAIN });
  assert.match(attempt.error, /prepared rollback carries a different migration chain from the one judged; stopped before any change/);
  assert.deepEqual(attempt.installs, []); assert.equal(attempt.store.rv, 1);
});

test('F5-1: the chain verdict separates fits, would-apply, database-ahead and diverged, and throws on malformed input', () => {
  const rows = [row(BEFORE), row(MID)];
  assert.equal(chainVerdict(MID_CHAIN, rows).kind, 'fits');
  assert.deepEqual({ ...chainVerdict(CHAIN_WITH_MID, rows) }, { kind: 'would-apply', databaseRows: 2, chainLength: 4 });
  assert.deepEqual({ ...chainVerdict(PRE_CUTOVER_CHAIN, rows) }, { kind: 'database-ahead', databaseRows: 2, chainLength: 1 });
  const other = { schemaVersion: 1, migrations: [BEFORE, { ...MID, sha256: `sha256:${'e'.repeat(64)}` }] };
  assert.deepEqual({ ...chainVerdict(other, rows) }, { kind: 'diverged', at: 2, databaseRows: 2, chainLength: 2 });
  assert.notEqual(describeChainVerdict(chainVerdict(CHAIN_WITH_MID, rows)), describeChainVerdict(chainVerdict(PRE_CUTOVER_CHAIN, rows)));
  assert.throws(() => chainVerdict(undefined, rows), /chain is unavailable or malformed/);
  assert.throws(() => chainVerdict(MID_CHAIN, [['only', 'two']]), /ledger answer is malformed/);
});

test('one-way cutover: an interrupted run cannot be papered over by completing the earlier release', async () => {
  // A canonical earlier release (a pre-worker lock cannot be completed at all and must be recovered).
  const previous = localEdge(lock('1'.repeat(40), 'a')), target = localEdge(lock('2'.repeat(40), 'b'));
  const interrupted = (ledgerRows) => {
    const store = recordStore(previous, { phase: 'Installing', transition: { runId: '00000000-0000-4000-8000-000000000000',
      previousReleaseDigest: previous.releaseDigest, targetReleaseDigest: target.releaseDigest,
      oneWay: { migrations: [{ globalId: CUTOVER.globalId, semanticKey: CUTOVER.semanticKey }], committedAtStart: [] } } });
    const verified = [];
    const ops = { readInstallationRecord: () => store.read(), readReleaseInventory: () => [{ name: 'complete-release' }],
      recordInstallationState: (release, _s, _a, _u, _e, _t, phase, options) => {
        store.write(release, phase, options);
        const written = store.read();
        return { config: JSON.parse(written.data['config.json']), state: JSON.parse(written.data['state.json']) };
      },
      verifyInstallation: async (release) => { verified.push(release.sourceRevision); return { releaseDigest: release.releaseDigest, verifiedAt: '2026-09-26T01:00:00Z' }; },
      readMigrationLedger: ledgerRows };
    return { store, verified, ops };
  };
  const crossed = interrupted(() => [row(BEFORE), row(CUTOVER)]);
  await assert.rejects(completeInstallationVerification(previous, { runtime: crossed.ops }), /interrupted and the database has passed, or may have passed/);
  assert.deepEqual(crossed.verified, []);
  const unreadable = interrupted(() => { throw new Error('no database'); });
  await assert.rejects(completeInstallationVerification(previous, { runtime: unreadable.ops }), /may have passed/);
  // Interrupted before the cutover: the earlier release may still be completed.
  const before = interrupted(() => [row(BEFORE)]);
  await completeInstallationVerification(previous, { runtime: before.ops });
  assert.deepEqual(before.verified, [previous.sourceRevision]); assert.equal(before.store.state.phase, 'Ready');
  // And an ordinary upgrade from the interrupted record is refused either way.
  const events = [];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store: interrupted(() => [row(BEFORE)]).store }) }),
    /installation is Installing/);
  assert.deepEqual(installs(events), []);
});

test('one-way cutover: another writer between the Ready check and the claim stops the run before any change', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store,
    on: { prepare: () => { store.rv += 1; } } }) }), /installation record changed before the Installing record write; another writer owns it now. Already done by this run: nothing beyond namespace and pull-secret checks/);
  assert.deepEqual(installs(events), []);
});

test('one-way cutover: another writer during the run means no rollback and no record change', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store,
    on: { install: () => { store.rv += 1; throw new Error('Gitea bootstrap failed'); } } }) }),
  /Upgrade failed \(Gitea bootstrap failed\); the installation record changed meanwhile; another writer owns it now\. Already done by this run: recorded .* Installing\. Not done: any further install, prune, inventory, rollback or record write/);
  assert.deepEqual(earlierInstalls(events), []);
});

test('one-way cutover: between releases that both include it, an ordinary rollback still works', async () => {
  const previous = localEdge(lock('1'.repeat(40), 'a')), target = localEdge(lock('2'.repeat(40), 'b'));
  const events = [], store = recordStore(previous);
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, {
    ledger: [BEFORE, CUTOVER], store, previousChain: CHAIN, failTarget: true }) }), /previous release was restored: target is unhealthy/);
  assert.deepEqual(earlierInstalls(events), [`install:롤백:${previous.sourceRevision}`]);
  // Nothing one-way is pending, so the ordinary rollback with the target's chain is unchanged.
  assert.deepEqual(events.filter((e) => e.startsWith('rollback-chain:')), ['rollback-chain:target']);
  assert.equal(events.some((e) => e.startsWith('prepare-own-chain:')), false);
  assert.equal(store.release.releaseDigest, previous.releaseDigest); assert.equal(store.state.phase, 'Ready');
});

test('one-way cutover: a component release crossing it keeps the target components', async () => {
  const previous = localEdge(lock('1'.repeat(40), 'a'));
  const target = componentTarget(previous, '2'.repeat(40), ['osaaGateway', 'osdst']);
  const events = [], store = recordStore(previous), ledger = [BEFORE];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, {
    ledger, store, failTarget: true, recordedInventory: [{ name: 'complete-release' }], on: { install: () => ledger.push(CUTOVER) } }) }),
  /one-way-migration-recovery-required/);
  assertTargetKept(events, store, target, 'one-way-migration-recovery-required');
});

// Re-review N1: a version is this run's only when its own write's response says so.
test('record ownership: only the PATCH response of this write confirms the new version', () => {
  const data = { 'release.json': '{"a":1}', 'state.json': '{"phase":"Installing"}' };
  const ok = JSON.stringify({ metadata: { uid: 'u', resourceVersion: '8' }, data });
  assert.deepEqual(confirmRecordWrite(ok, 'u', '7', data), { uid: 'u', resourceVersion: '8' });
  for (const output of [
    '', 'not json',
    JSON.stringify({ metadata: { uid: 'other', resourceVersion: '8' }, data }),
    JSON.stringify({ metadata: { uid: 'u', resourceVersion: '7' }, data }),
    JSON.stringify({ metadata: { uid: 'u' }, data }),
    JSON.stringify({ metadata: { uid: 'u', resourceVersion: '8' }, data: { ...data, 'state.json': '{"phase":"Ready"}' } }),
  ]) assert.throws(() => confirmRecordWrite(output, 'u', '7', data), /not confirmed by its own response/);
});

test('record ownership: a writer between the claim write and the next read is never adopted (N1)', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  let foreign = false;
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger: [BEFORE], store,
    on: { afterRecord: (phase) => {
      if (phase !== 'Installing' || foreign) return;
      foreign = true;
      store.rv += 1; store.state = { ...store.state, transition: { ...store.state.transition, runId: '11111111-1111-4111-8111-111111111111' } };
    } } }) }),
  /changed before installing the target; another writer owns it now\. Already done by this run: recorded .* Installing\./);
  assert.deepEqual(installs(events), [], 'nothing is installed after the foreign write');
  assert.equal(store.state.transition.runId, '11111111-1111-4111-8111-111111111111', 'the other writer\'s record is not overwritten');
});

test('record ownership: a write whose response is lost or unconfirmed stops the run (N1)', async () => {
  for (const [name, respond] of [
    ['lost', () => { throw new Error('kubectl patch: connection reset after send'); }],
    ['without a new version', (written) => ({ record: { uid: written.record.uid, resourceVersion: '1' } })],
  ]) {
    const { previous, target } = activation(), events = [], store = recordStore(previous);
    const operations = cutoverRuntime(previous, target, events, { ledger: [BEFORE], store });
    const record = operations.recordInstallationState;
    operations.recordInstallationState = (...args) => respond(record(...args));
    await assert.rejects(upgrade(previous, target, { runtime: operations }), name === 'lost' ? /connection reset after send/ : /no confirmed new version; ownership is unknown/);
    assert.deepEqual(installs(events), [], name);
    assert.equal(store.state.phase, 'Installing', `${name}: the claim may have landed; recovery is explicit`);
  }
});

test('record ownership: lost during a successful verification means no prune, inventory or Ready (N2)', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  const operations = cutoverRuntime(previous, target, events, { ledger: [BEFORE], store, on: { install: () => {} } });
  const verify = operations.verifyInstallation;
  operations.verifyInstallation = async (release, options) => {
    const result = await verify(release, options);
    if (release.releaseDigest === target.releaseDigest) store.rv += 1;
    return result;
  };
  await assert.rejects(upgrade(previous, target, { runtime: operations }),
    (e) => /changed during target verification; another writer owns it now/.test(e.message)
      && /applied the target workloads and migrations; recorded .* Installing; verified the target/.test(e.message)
      && /Not done: any further install, prune, inventory, rollback or record write/.test(e.message));
  assert.equal(events.some((e) => e.startsWith('prune:') || e.startsWith('inventory:')), false);
  assert.equal(events.some((e) => e.includes(':Ready:')), false);
  assert.deepEqual(earlierInstalls(events), []);
});

test('record ownership: lost during rollback verification means no prune, inventory or Ready (N2)', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous);
  const operations = cutoverRuntime(previous, target, events, { ledger: [BEFORE], store, on: { install: () => { throw new Error('Gitea bootstrap failed'); } } });
  const verify = operations.verifyInstallation;
  operations.verifyInstallation = async (release, options) => {
    const result = await verify(release, options);
    if (options?.mode === 'rollback') store.rv += 1;
    return result;
  };
  await assert.rejects(upgrade(previous, target, { runtime: operations }),
    (e) => /rollback also failed/.test(e.message) && /changed during rollback verification/.test(e.message)
      && /reinstalled the previous release; recorded .* Installing; verified the previous release/.test(e.message));
  assert.equal(events.some((e) => e.startsWith('prune:') || e.startsWith('inventory:')), false);
  assert.equal(events.some((e) => e.includes(':Ready:')), false);
});

test('record ownership: lost before the kept target is recorded means no inventory write (N2)', async () => {
  const { previous, target } = activation(), events = [], store = recordStore(previous), ledger = [BEFORE];
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, events, { ledger, store,
    on: { install: () => { ledger.push(CUTOVER); store.rv += 1; throw new Error('migration 0081 failed'); } } }) }),
  /Upgrade failed \(migration 0081 failed\); the installation record changed meanwhile/);
  assert.equal(events.some((e) => e.startsWith('inventory:') || e.startsWith('prune:')), false);
  assert.deepEqual(earlierInstalls(events), []);
});

// Re-review N3: a Console Knowledge release holds the record until its own completion; Setup
// neither upgrades, recovers nor completes over it.
test('record ownership: Setup never acts over a Console Knowledge claim (N3)', async () => {
  const previous = localEdge(lock('1'.repeat(40), 'a')), target = localEdge(lock('2'.repeat(40), 'b'));
  const operationId = '22222222-2222-4222-8222-222222222222';
  const knowledgeClaim = () => recordStore(previous, { phase: 'Installing',
    knowledgeUpdate: { schema: 'opensphere.knowledge-installation-transition/v1', operationId },
    transition: { runId: operationId, mode: 'knowledge', previousReleaseDigest: previous.releaseDigest, targetReleaseDigest: `sha256:${'e'.repeat(64)}` } });
  const ordinary = [], store = knowledgeClaim();
  await assert.rejects(upgrade(previous, target, { runtime: cutoverRuntime(previous, target, ordinary, { ledger: [BEFORE, CUTOVER], store, previousChain: CHAIN }) }),
    /Console Knowledge release \(operation 22222222-2222-4222-8222-222222222222\) holds the installation record/);
  const recovery = [];
  await assert.rejects(upgrade(previous, target, { oneWayRecoveryRecordDigest: installationRecordDigest(store.read()),
    runtime: cutoverRuntime(previous, target, recovery, { ledger: [BEFORE, CUTOVER], store, previousChain: CHAIN }) }),
  /Setup neither upgrades nor recovers over it/);
  assert.deepEqual([...installs(ordinary), ...installs(recovery)], []); assert.equal(store.rv, 1);
  const verified = [], claimed = knowledgeClaim();
  await assert.rejects(completeInstallationVerification(previous, { runtime: {
    readInstallationRecord: () => claimed.read(), readReleaseInventory: () => [{ name: 'complete-release' }],
    recordInstallationState: () => { throw new Error('must not write'); },
    verifyInstallation: async (release) => { verified.push(release); return {}; }, readMigrationLedger: () => [] } }),
  /holds the installation record; let it complete in Console/);
  assert.deepEqual(verified, []); assert.equal(claimed.rv, 1);
});
