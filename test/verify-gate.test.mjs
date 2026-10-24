import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  hasDurableBeszelBootstrapEvidence,
  captureBeszelBootstrapHistory,
  hasBeszelBootstrapHistory,
  isBeszelBootstrapWorkload,
  isRetryableInstallationReadinessError,
  releaseWorkloadSpecs,
  verifyNativeRuntimeReferences
} from '../src/verify.mjs';
import { BOOTSTRAP_CORE_COMPONENTS } from '../src/release.mjs';

test('only transient endpoint and pod readiness failures are retried', () => {
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Required Service has no ready EndpointSlice endpoint: opensphere-console/opensphere-console-ext')
  ), true);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('OpenSphere Pods are not Ready: opensphere-console/opensphere-console-abc')
  ), true);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Runtime image differs from release lock: opensphere-console/opensphere-console')
  ), false);
  assert.equal(isRetryableInstallationReadinessError(
    new Error('Workload does not reference the governed registry pull Secret: opensphere-console/opensphere-console')
  ), false);
});

test('transaction history survives a release transition only for identical Beszel images and installation UID', () => {
  const {lock,state,evidence}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-installation-v1.json',import.meta.url)));
  const history=captureBeszelBootstrapHistory(lock,state,evidence,'same-installation');
  assert.ok(history);
  const target=structuredClone(lock);target.releaseDigest='sha256:'+'f'.repeat(64);
  assert.equal(hasBeszelBootstrapHistory(history,target,'same-installation'),true);
  assert.equal(hasBeszelBootstrapHistory(history,lock,'same-installation'),true); // rollback
  assert.equal(hasBeszelBootstrapHistory(history,target,'replacement-installation'),false);
  for(const key of ['beszelHub','beszelAgent','beszelBootstrap']) {
    const changed=structuredClone(target);changed.components[key].image+='different';
    assert.equal(hasBeszelBootstrapHistory(history,changed,'same-installation'),false);
  }
  for(const fake of [null,{},JSON.parse(JSON.stringify(history))])
    assert.equal(hasBeszelBootstrapHistory(fake,target,'same-installation'),false);
  for(const phase of ['Installing','Failed',undefined])
    assert.equal(captureBeszelBootstrapHistory(lock,{...state,phase},evidence,'same-installation'),null);
  for(const mutate of [e=>{e.releaseDigest='sha256:'+'f'.repeat(64);},e=>{e.historicalBootstrap.images.beszelHub+='different';},e=>{e.schema='unknown/v1';}]) {
    const invalid=structuredClone(evidence);mutate(invalid);
    assert.equal(captureBeszelBootstrapHistory(lock,state,invalid,'same-installation'),null);
  }
  assert.equal(captureBeszelBootstrapHistory(lock,{...state,verification:{}},evidence,'same-installation'),null);
});

test('historical proof never excuses another ephemeral workload, namespace, kind or container', () => {
  const spec={component:'beszelBootstrap',namespace:'opensphere-monitoring',kind:'job',name:'beszel-bootstrap-v0187',container:'configure',ephemeral:true};
  assert.equal(isBeszelBootstrapWorkload(spec),true);
  for(const key of Object.keys(spec)) {
    assert.equal(isBeszelBootstrapWorkload({...spec,[key]:'other'}),false);
    const missing={...spec};delete missing[key];assert.equal(isBeszelBootstrapWorkload(missing),false);
  }
});

test('Knowledge component receipt supplies only exact historical Beszel bootstrap evidence to normal Setup',()=>{
  const {evidence,lock,state}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-installation-v1.json',import.meta.url)));
  assert.equal(evidence.runtimeState,'NotObserved');assert.equal(evidence.runtimeImagesMatchLock,undefined);
  assert.equal(hasDurableBeszelBootstrapEvidence(evidence,lock,state),true);
  for(const mutate of [e=>{e.scope='whole-console';},e=>{e.runtimeState='Ready';},e=>{e.historicalBootstrap.images.beszelHub+='changed';},
    e=>{e.schema='unknown/v1';e.runtimeImagesMatchLock=true;e.beszel={bootstrapJobComplete:true,agentPublicKeyPublished:true};},
    e=>{e.activation.sha256='0'.repeat(64);},e=>{e.semanticSearch.observedAt='2026-09-10T00:00:00.000Z';}]){
    const invalid=structuredClone(evidence);mutate(invalid);assert.equal(hasDurableBeszelBootstrapEvidence(invalid,lock,state),false);
  }
  assert.equal(hasDurableBeszelBootstrapEvidence(evidence,lock,{...state,phase:'Installing'}),false);
  assert.equal(hasDurableBeszelBootstrapEvidence(evidence,lock,{...state,verification:{...state.verification,operationId:'different'}}),false);
  assert.equal(hasDurableBeszelBootstrapEvidence(evidence,{...lock,releaseDigest:'sha256:'+'f'.repeat(64)},state),false);
});

test('expired Beszel bootstrap Job requires evidence bound to the exact installation state', () => {
  const releaseDigest = `sha256:${'a'.repeat(64)}`;
  const verifiedAt = '2026-09-04T05:48:24.074Z';
  const lock = { releaseDigest };
  const installationState = { verification: { verifiedAt } };
  const evidence = {
    releaseDigest,
    verifiedAt,
    runtimeImagesMatchLock: true,
    beszel: { bootstrapJobComplete: true, agentPublicKeyPublished: true }
  };

  assert.equal(hasDurableBeszelBootstrapEvidence(evidence, lock, installationState), true);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, releaseDigest: `sha256:${'b'.repeat(64)}` },
    lock,
    installationState
  ), false);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, verifiedAt: '2026-09-04T05:48:25.000Z' },
    lock,
    installationState
  ), false);
  assert.equal(hasDurableBeszelBootstrapEvidence(
    { ...evidence, runtimeImagesMatchLock: false },
    lock,
    installationState
  ), false);
});

test('bootstrap workloads exclude private on-demand native Pods and never retain a shared Hermes sidecar', () => {
  const specs = releaseWorkloadSpecs();
  for (const component of BOOTSTRAP_CORE_COMPONENTS.filter(value => value !== 'r2d2OpenClawGateway')) {
    assert.ok(specs.some((spec) => spec.component === component), component);
  }
  assert.deepEqual(specs.filter(spec => spec.component === 'r2d2OpenClawGateway'), []);
  assert.ok(specs.every(spec => spec.container !== 'hermes-worker' && spec.component !== 'r2d2HermesWorker'));
  const gateway = specs.find((spec) => spec.component === 'osaaGateway');
  assert.equal(gateway.name, 'opensphere-console-osaa-gateway');
  assert.equal(gateway.container, 'gateway');
});

function nativeReferenceFixture() {
  const lock = JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json', import.meta.url))).base;
  const installationId = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
  const clusterUid = '6c1a7b2e-3f4d-4a5b-9c8d-7e6f5a4b3c2d';
  const container = { name: 'gateway', image: lock.components.osaaGateway.image, env: [
    { name: 'R2D2_BACKEND', value: 'openclaw-native' },
    { name: 'R2D2_NATIVE_GATEWAY_IMAGE', value: lock.components.r2d2OpenClawGateway.image },
    { name: 'R2D2_NATIVE_BRIDGE_IMAGE', value: lock.components.osaaGateway.image },
    { name: 'OPENSPHERE_INSTALLATION_ID', valueFrom: { configMapKeyRef: { name: 'opensphere-r2d2-runtime-policy', key: 'installationId', optional: false } } },
    { name: 'R2D2_NATIVE_RUNTIME_POLICY', valueFrom: { configMapKeyRef: { name: 'opensphere-r2d2-runtime-policy', key: 'policy.json', optional: false } } },
  ] };
  const policy = { metadata: { name: 'opensphere-r2d2-runtime-policy', namespace: 'opensphere-console', labels: { 'app.kubernetes.io/managed-by': 'opensphere-setup' } }, data: { installationId,
    'policy.json': JSON.stringify({ installationId, image: lock.components.r2d2OpenClawGateway.image, bridgeImage: lock.components.osaaGateway.image }) } };
  const identity = { immutable: true, data: { installationId, clusterUid } };
  return { lock, container, policy, identity, clusterUid };
}

test('native readiness proves exact on-demand images and required policy references without inventing a personal Pod', () => {
  const f = nativeReferenceFixture();
  assert.equal(verifyNativeRuntimeReferences(f.lock, f.container, f), true);
  assert.equal(f.container.env.some(entry => entry.name.startsWith('R2D2_HERMES_')), false);
  const historical = structuredClone(f.lock); delete historical.components.r2d2OpenClawGateway;
  assert.equal(verifyNativeRuntimeReferences(historical, {}, {}), false, 'Installed historical evidence never claims the native engine is ready');
});

for (const [name, mutate] of [
  ['missing native image', f => f.container.env.splice(1, 1)],
  ['duplicate native image', f => f.container.env.push({ ...f.container.env[1] })],
  ['another native image', f => f.container.env[1].value += 'different'],
  ['another bridge image', f => f.container.env[2].value += 'different'],
  ['disabled native backend', f => f.container.env[0].value = 'disabled'],
  ['optional policy reference', f => f.container.env[4].valueFrom.configMapKeyRef.optional = true],
  ['another policy name', f => f.container.env[4].valueFrom.configMapKeyRef.name = 'other'],
  ['another policy key', f => f.container.env[3].valueFrom.configMapKeyRef.key = 'other'],
  ['inline policy override', f => f.container.env[4].value = '{}'],
  ['malformed policy JSON', f => f.policy.data['policy.json'] = '{'],
  ['another policy image', f => { const value = JSON.parse(f.policy.data['policy.json']); value.image += 'different'; f.policy.data['policy.json'] = JSON.stringify(value); }],
  ['another policy bridge', f => { const value = JSON.parse(f.policy.data['policy.json']); value.bridgeImage += 'different'; f.policy.data['policy.json'] = JSON.stringify(value); }],
  ['another policy installation', f => { const value = JSON.parse(f.policy.data['policy.json']); value.installationId = 'different'; f.policy.data['policy.json'] = JSON.stringify(value); }],
  ['mutable installation identity', f => f.identity.immutable = false],
  ['another cluster identity', f => f.clusterUid = 'different'],
  ['another installation identity', f => f.identity.data.installationId = 'different'],
  ['foreign policy owner', f => f.policy.metadata.labels['app.kubernetes.io/managed-by'] = 'foreign'],
  ['retired Hermes activation', f => f.container.env.push({ name: 'R2D2_HERMES_ENABLED', value: 'true' })],
]) {
  test(`native reference verification refuses ${name}`, () => {
    const f = nativeReferenceFixture(); mutate(f);
    assert.throws(() => verifyNativeRuntimeReferences(f.lock, f.container, f));
  });
}
