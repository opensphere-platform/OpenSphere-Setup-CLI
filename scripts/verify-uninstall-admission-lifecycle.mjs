// Disposable Kubernetes integration test. Never points at an installed Console.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { kubectl } from '../src/process.mjs';
import { MANAGED_NAMESPACES, MANAGED_CLUSTER_SCOPED_RESOURCES as resources } from '../src/installation-contract.mjs';
import { CLUSTER_SCOPED_MANAGED_CRDS, assertNoManagedClusterResiduals, assertManagedAdmissionParameters } from '../src/installation-residuals.mjs';
import { uninstallManagedInstallation, listClusterWideCustomResourceInstances } from '../src/bootstrap.mjs';
import profile from '../src/ceph-preparation-profile.json' with {type:'json'};

assert.match(process.env.OPENSPHERE_KUBE_CONTEXT ?? '', /^kind-setup-lifecycle-[a-z0-9-]+$/);
assert.ok(process.env.KUBECONFIG, 'Use an isolated kubeconfig');
const run = (args, options = {}) => kubectl([...args, '--request-timeout=20s'], {capture:true, ...options});
const apply = items => run(['apply','-f','-'], {input:JSON.stringify({apiVersion:'v1',kind:'List',items})});
const ns = name => ({apiVersion:'v1',kind:'Namespace',metadata:{name}});
const outside = 'unrelated-test-product';
apply([...MANAGED_NAMESPACES, outside].map(ns));
const outsideUid = JSON.parse(run(['get','namespace',outside,'-o','json'])).metadata.uid;

// These real API definitions reproduce the previously rejected Foundation scopes.
for (const name of CLUSTER_SCOPED_MANAGED_CRDS) {
  const [plural,...parts] = name.split('.');
  apply([{apiVersion:'apiextensions.k8s.io/v1',kind:'CustomResourceDefinition',metadata:{name},
    spec:{group:parts.join('.'),scope:'Cluster',names:{plural,singular:plural.slice(0,-1),kind:plural[0].toUpperCase()+plural.slice(1)},
      versions:[{name:'v1alpha1',served:true,storage:true,schema:{openAPIV3Schema:{type:'object'}}}]}}]);
  run(['wait','--for=condition=Established','crd/'+name,'--timeout=30s']);
  assert.deepEqual(listClusterWideCustomResourceInstances(name), []);
}
const policies = profile.resources.filter(r => r.metadata.name === 'opensphere-ceph-preparation-job');
assert.equal(policies.length,2);
apply(policies);
const job = {apiVersion:'batch/v1',kind:'Job',metadata:{name:'beszel-bootstrap-regression',namespace:'opensphere-monitoring'},
  spec:{template:{spec:{restartPolicy:'Never',containers:[{name:'test',image:'registry.k8s.io/pause:3.10'}]}}}};
let denial = '';
for (let attempt=0;attempt<30;attempt++) {
  try {run(['create','--dry-run=server','-f','-'], {input:JSON.stringify(job)});} catch(error) {denial=error.message;break;}
  await delay(500);
}
assert.match(denial,/no params found for policy binding/);
assert.throws(()=>assertManagedAdmissionParameters(), /missing ConfigMap/);
assert.throws(()=>assertNoManagedClusterResiduals(), /cluster-scoped resources remain/);
console.log('REPRODUCED: missing Ceph parameter rejects unrelated Beszel Job; preflight identifies it');

const state={releaseDigest:'sha256:'+'a'.repeat(64),managedNamespaces:[...MANAGED_NAMESPACES],managedClusterScopedResources:structuredClone(resources)};
await uninstallManagedInstallation({onProgress:console.log,runtime:{
  readInstallationLock:()=>({releaseDigest:state.releaseDigest}),readInstallationState:()=>state,
  // This is an admission/lifecycle test, not a Beszel host-data purge acceptance.
  // Probe the real API at the exact point production starts its cleanup Jobs.
  purgeBeszelHostState:async()=>{
    for(let i=0;i<30;i++) {
      try {run(['create','--dry-run=server','-f','-'],{input:JSON.stringify(job)});return;}
      catch(error){if(i===29)throw error;await delay(500);}
    }
  },
  purgeExternalConsoleRbac:()=>{}
}});
assertNoManagedClusterResiduals();
assert.equal(JSON.parse(run(['get','namespace',outside,'-o','json'])).metadata.uid,outsideUid);
apply([ns('opensphere-monitoring')]);
run(['create','--dry-run=server','-f','-'],{input:JSON.stringify(job)});
console.log('PASS: production cleanup handles six Cluster CRDs, removes bindings before cleanup Jobs/namespace deletion, and permits the next Beszel Job');
console.log('Scope: disposable API lifecycle regression only; no Console image installation or browser acceptance claimed');
