import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  hasDurableBeszelBootstrapEvidence,
  captureBeszelBootstrapHistory,
  hasBeszelBootstrapHistory,
  isBeszelBootstrapWorkload,
  isRetryableInstallationReadinessError,
  releaseWorkloadSpecs
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

test('every bootstrap core component, including the R2D2 Hermes worker sidecar, has a verified workload container', () => {
  const specs = releaseWorkloadSpecs();
  for (const component of BOOTSTRAP_CORE_COMPONENTS) {
    assert.ok(specs.some((spec) => spec.component === component), component);
  }
  const worker = specs.filter((spec) => spec.component === 'r2d2HermesWorker');
  assert.deepEqual(worker, [{
    component: 'r2d2HermesWorker',
    namespace: 'opensphere-console',
    kind: 'deployment',
    name: 'opensphere-console-osaa-gateway',
    container: 'hermes-worker'
  }]);
  const gateway = specs.find((spec) => spec.component === 'osaaGateway');
  assert.equal(gateway.name, worker[0].name);
  assert.equal(gateway.container, 'gateway');
});
