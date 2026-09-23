import test from 'node:test';
import assert from 'node:assert/strict';
import { listClusterWideCustomResourceInstances, uninstallManagedInstallation } from '../src/bootstrap.mjs';
import { MANAGED_NAMESPACES, MANAGED_CLUSTER_SCOPED_RESOURCES as resources } from '../src/installation-contract.mjs';
import { CLUSTER_SCOPED_MANAGED_CRDS, assertNoManagedClusterResiduals, assertManagedAdmissionParameters } from '../src/installation-residuals.mjs';

test('actual Foundation cluster scopes are inventoried without a namespace assumption', () => {
  for (const name of resources.customResourceDefinitions) {
    const cluster = CLUSTER_SCOPED_MANAGED_CRDS.includes(name);
    const calls = [];
    const run = args => {
      calls.push(args);
      return JSON.stringify(args.includes('customresourcedefinition')
        ? { metadata: { name }, spec: { scope: cluster ? 'Cluster' : 'Namespaced' } }
        : { items: [{ metadata: { name: 'existing', ...(cluster ? {} : { namespace: 'outside' }) } }] });
    };
    assert.deepEqual(listClusterWideCustomResourceInstances(name, { run }), [cluster ? 'existing' : 'outside/existing']);
    assert.equal(calls[1].includes('--all-namespaces'), !cluster);
  }
});

test('empty Cluster definitions pass, unexpected scopes and malformed inventories fail closed', () => {
  const name = CLUSTER_SCOPED_MANAGED_CRDS[0];
  const run = args => JSON.stringify(args.includes('customresourcedefinition') ? {metadata:{name},spec:{scope:'Cluster'}} : {items:[]});
  assert.deepEqual(listClusterWideCustomResourceInstances(name, {run}), []);
  assert.throws(() => listClusterWideCustomResourceInstances(name, {run: () => JSON.stringify({metadata:{name},spec:{scope:'Namespaced'}})}), /unexpected identity or scope/);
  assert.throws(() => listClusterWideCustomResourceInstances('foreign.example', {run: () => assert.fail()}), /Unknown managed/);
  assert.throws(() => listClusterWideCustomResourceInstances(name, {run: args => args.includes('customresourcedefinition') ? run(args) : '{}'}), /exact Kubernetes List/);
});

test('fresh bootstrap detects exact old cluster resources even with zero namespaces', () => {
  assert.throws(() => assertNoManagedClusterResiduals({run: args => args[1].endsWith('/opensphere-ceph-preparation-job') ? args[1] : ''}), /Complete the managed uninstall/);
  assertNoManagedClusterResiduals({run: () => ''});
});

test('resume detects missing Ceph parameters without weakening Deny or writing replacements', () => {
  const binding = {metadata:{name:'opensphere-ceph-preparation-job'},spec:{paramRef:{name:'opensphere-ceph-preparation-policy',namespace:'opensphere-console',parameterNotFoundAction:'Deny'}}};
  const run = args => {
    assert.ok(args.includes('get'));
    return args.includes('validatingadmissionpolicybinding/opensphere-ceph-preparation-job') ? JSON.stringify(binding) : '';
  };
  assert.throws(() => assertManagedAdmissionParameters({run}), /missing ConfigMap opensphere-console\/opensphere-ceph-preparation-policy/);
  assertManagedAdmissionParameters({run: args => args.includes('configmap') ? 'configmap/opensphere-ceph-preparation-policy' : run(args)});
});

function runtime() {
  const events = [];
  const state = {releaseDigest:'sha256:test', managedNamespaces:[...MANAGED_NAMESPACES],managedClusterScopedResources:structuredClone(resources)};
  return {events, operations:{
    readInstallationLock:()=>({releaseDigest:state.releaseDigest}), readInstallationState:()=>state,
    existingManagedNamespaces:()=>[...MANAGED_NAMESPACES],listManagedPersistentVolumes:()=>[],
    listManagedCrdInstances:()=>[],listManagedClusterResiduals:()=>[],
    deleteManagedClusterRbac:r=>events.push(r),purgeBeszelHostState:()=>events.push('host-cleanup'),
    purgeExternalConsoleRbac:()=>{},deleteManagedNamespace:n=>events.push('namespace/'+n),
    waitForManagedNamespaceDeletion:()=>{},deleteManagedCrd:()=>{}
  }};
}

test('policy deletion failure cannot delete parameter namespaces or ownership evidence', async () => {
  const {events,operations}=runtime();
  operations.deleteManagedClusterRbac=()=>{throw Error('admission API failure');};
  await assert.rejects(uninstallManagedInstallation({runtime:operations}), /admission API failure/);
  assert.deepEqual(events,[]);
});

test('uninstall cannot report success while a cluster-scoped resource remains', async () => {
  const {operations}=runtime(); let reads=0;
  operations.listManagedClusterResiduals=()=>++reads===1?[]:['clusterrole/opensphere-registry'];
  await assert.rejects(uninstallManagedInstallation({runtime:operations}), /remain after uninstall/);
});

test('cluster custom data is refused before any deletion', async () => {
  const {events,operations}=runtime();
  operations.listManagedCrdInstances=crd=>crd===CLUSTER_SCOPED_MANAGED_CRDS[0]?['external-model']:[];
  await assert.rejects(uninstallManagedInstallation({runtime:operations}), /cluster-wide instances remain: external-model/);
  assert.deepEqual(events,[]);
});
