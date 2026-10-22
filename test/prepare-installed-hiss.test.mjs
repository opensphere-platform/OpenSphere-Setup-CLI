import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareInstalledHiss} from '../src/prepare-installed-hiss.mjs';
import profile from '../src/hiss-preparation-profile.json' with {type:'json'};
import storageObservation from '../src/hiss-storage-observation-artifact.json' with {type:'json'};
import {verifyHissStorageObservationArtifact} from '../src/hiss-prerequisites.mjs';
const storageObservationYaml=()=>verifyHissStorageObservationArtifact(storageObservation.yaml);
const identity=r=>`${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
function fixture(change=false,{longhorn=false}={}){
 let serial=0, cluster='cluster-a',writes=0;
 const applies=[],fenceApplies=[];
 const state=new Map();
 const put=r=>state.set(identity(r),{...structuredClone(r),metadata:{...r.metadata,uid:`uid-${++serial}`}});
 for(const [kind,name,namespace] of [['Namespace','opensphere-console'],['Namespace','kube-system'],['Namespace','opensphere-foundation'],['ServiceAccount','opensphere-cluster-manager-runtime','opensphere-console'],['ClusterRole','system:auth-delegator'],['Role','extension-apiserver-authentication-reader','kube-system']])put({apiVersion:kind==='Namespace'||kind==='ServiceAccount'?'v1':'rbac.authorization.k8s.io/v1',kind,metadata:{name,...(namespace?{namespace}:{})}});
 const runner=(_exe,args,options)=>{
  assert.deepEqual(args.slice(0,2),['--context','rke2']);
  if(args.includes('opensphere-installation-lock'))return JSON.stringify({metadata:{uid:'install-a'},data:{'config.json':JSON.stringify({consoleUrl:'https://console.example.test'}),'release.json':JSON.stringify({channel:'edge',releaseDigest:'sha256:'+'a'.repeat(64)})}});
  if(args.includes('namespace')&&args.includes('kube-system'))return JSON.stringify({metadata:{uid:cluster}});
  if(args.includes('observabilitybindings.observability.opensphere.io'))return '';
  if(args.includes('volumes.longhorn.io')||args.includes('longhorn-system'))return longhorn?args[args.indexOf('get')+1]+'/x\n':'';
  if(args.includes('apply')){assert(args.includes('--server-side'));assert(args.includes('--field-manager=opensphere-setup-hiss'));assert(!args.includes('--force-conflicts'));
   // The chart execution fence is applied as a JSON List; the API server keeps it (generation observed, no warnings).
   if(String(options.input).startsWith('{')){for(const r of JSON.parse(options.input).items){const live=state.get(identity(r));
    put({...structuredClone(r),metadata:{...(live?.metadata||{}),...r.metadata,labels:{...(live?.metadata?.labels||{}),...(r.metadata.labels||{})},generation:1},status:{observedGeneration:1,typeChecking:{}}});}
    fenceApplies.push(options.input);return '';}
   applies.push(options.input);return '';}
  // Fence preparation and the F-6 coverage read (hiss-chart-execution-fence.mjs).
  if(args.includes('--ignore-not-found')&&args.includes('-o')&&args[args.indexOf('-o')+1]==='name'&&args.includes('namespace'))return `namespace/${args[args.indexOf('namespace')+1]}\n`;
  const kinds={clusterrolebindings:'ClusterRoleBinding',rolebindings:'RoleBinding',clusterroles:'ClusterRole',roles:'Role',validatingadmissionpolicies:'ValidatingAdmissionPolicy',validatingadmissionpolicybindings:'ValidatingAdmissionPolicyBinding',serviceaccounts:'ServiceAccount'};
  if(args.includes('get')&&kinds[args[args.indexOf('get')+1]])return JSON.stringify({kind:'List',items:[...state.values()].filter(o=>o.kind===kinds[args[args.indexOf('get')+1]]&&(!args.includes('-n')||o.metadata.namespace===args[args.indexOf('-n')+1]))});
  if(args.includes('get')&&args[args.indexOf('get')+1]==='namespace')return JSON.stringify({kind:'List',items:[...state.values()].filter(o=>o.kind==='Namespace'&&o.metadata.name===args[args.indexOf('get')+2])});
  const input=JSON.parse(options.input);
  // SubjectAccessReviews: the Cluster Manager runtime may create Deployments in monitoring only.
  if(args.includes('create')&&input.kind==='List'&&input.items.every(i=>i.kind==='SubjectAccessReview'))return input.items.map(i=>JSON.stringify({...i,
   status:{allowed:i.spec.resourceAttributes.namespace==='monitoring'&&i.spec.resourceAttributes.resource==='deployments'}})).join('\n');
  if(args.includes('get'))return JSON.stringify({kind:'List',items:input.items.flatMap(r=>state.has(identity(r))?[state.get(identity(r))]:[])});
  assert(args.includes('create'));writes++;put(input);if(change)cluster='cluster-b';return JSON.stringify(state.get(identity(input)));
 };
 return {runner,applies,fenceApplies,get writes(){return writes;}};
}
test('installed HISS preparation binds managed identity, creates missing objects and makes replay read-only',async()=>{
 const f=fixture();const first=await prepareInstalledHiss({context:'rke2',apply:true,runner:f.runner});
 assert.equal(first.status,'Prepared');assert.equal(f.writes,profile.resources.length);
 const second=await prepareInstalledHiss({context:'rke2',apply:true,runner:f.runner});
 assert.equal(second.created.length,0);assert.equal(f.writes,profile.resources.length);assert.equal(second.target.clusterUid,'cluster-a');
 // Fence: policies, then bindings, then Pod Security labels; replay finds them present and monitoring covered.
 assert.equal(first.chartExecutionFence.state,'Applied');assert.equal(f.fenceApplies.length,3);
 assert.ok(JSON.parse(f.fenceApplies[0]).items.every(o=>o.kind==='ValidatingAdmissionPolicy'));
 assert.ok(JSON.parse(f.fenceApplies[1]).items.every(o=>o.kind==='ValidatingAdmissionPolicyBinding'));
 assert.ok(JSON.parse(f.fenceApplies[2]).items.every(o=>o.kind==='Namespace'));
 assert.equal(first.executionCoverage.state,'Covered');assert.deepEqual(first.executionCoverage.namespaces.map(n=>[n.namespace,n.state]),[['monitoring','Covered']]);
 assert.equal(second.chartExecutionFence.state,'Present');
});
test('a plan counts the fence as pending, and an uncovered Pod-producing right blocks preparation',async()=>{
 const f=fixture();const plan=await prepareInstalledHiss({context:'rke2',runner:f.runner});
 assert.equal(plan.chartExecutionFence.state,'NeedsPreparation');assert.equal(plan.executionCoverage.state,'NeedsPreparation');
 assert.equal(plan.executionCoverage.namespaces[0].state,'Pending');assert.notEqual(plan.status,'Blocked');assert.equal(f.fenceApplies.length,0);
 const g=fixture();const runner=(exe,args,options)=>{
  if(args.includes('create')&&String(options?.input||'').includes('SubjectAccessReview')){const input=JSON.parse(options.input);
   return input.items.map(i=>JSON.stringify({...i,status:{allowed:i.spec.resourceAttributes.namespace==='unfenced'&&i.spec.resourceAttributes.resource==='jobs'}})).join('\n');}
  if(args.includes('get')&&args[args.indexOf('get')+1]==='rolebindings')return JSON.stringify({kind:'List',items:[{kind:'RoleBinding',metadata:{name:'x',namespace:'unfenced'},roleRef:{kind:'Role',name:'jobs'},subjects:[{kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',namespace:'opensphere-console'}]}]});
  if(args.includes('get')&&args[args.indexOf('get')+1]==='roles')return JSON.stringify({kind:'List',items:[{kind:'Role',metadata:{name:'jobs',namespace:'unfenced'},rules:[{apiGroups:['batch'],resources:['jobs'],verbs:['create']}]}]});
  return g.runner(exe,args,options);};
 const blocked=await prepareInstalledHiss({context:'rke2',apply:true,runner});
 assert.equal(blocked.status,'Blocked');assert.equal(blocked.blockedBy,'ExecutionCoverage');
 assert.deepEqual(blocked.executionCoverage.namespaces.find(n=>n.namespace==='unfenced'),{namespace:'unfenced',kinds:['jobs'],state:'Uncovered'});
});
test('cluster replacement stops immediately and never rolls back already prepared objects',async()=>{
 const f=fixture(true);await assert.rejects(prepareInstalledHiss({context:'rke2',apply:true,runner:f.runner}),/recheck failed|changed/);
 assert.equal(f.writes,1);
});
test('invalid context is rejected before contacting Kubernetes',async()=>{
 await assert.rejects(prepareInstalledHiss({context:'--other',runner:()=>assert.fail('unexpected I/O')}),/Explicit/);
});
test('storage observation is applied only where Longhorn runs',async()=>{
 const without=fixture();const plain=await prepareInstalledHiss({context:'rke2',apply:true,runner:without.runner});
 assert.equal(plain.storageObservation.state,'NotApplicable');assert.equal(plain.observabilityBindingCrd.state,'Applied');assert.equal(without.applies.length,2);assert.equal(without.fenceApplies.length,3);
 assert.match(without.applies[1],/kind: CustomResourceDefinition/);
 const lh=fixture(false,{longhorn:true});const planned=await prepareInstalledHiss({context:'rke2',runner:lh.runner});
 assert.equal(planned.storageObservation.state,'NeedsPreparation');assert.equal(planned.observabilityBindingCrd.state,'NeedsPreparation');assert.equal(lh.applies.length,0);
 const applied=await prepareInstalledHiss({context:'rke2',apply:true,runner:lh.runner});
 assert.equal(applied.storageObservation.state,'Applied');assert.equal(lh.applies.length,3);
 assert.match(lh.applies[1],/name: opensphere-hiss-storage-observer/);assert.doesNotMatch(lh.applies[1],/kind: ClusterRole/);
});
test('H-P6: the storage observation Role reads one Longhorn setting by name and the backup targets, and writes nothing',()=>{
 const yaml=storageObservationYaml();
 const role=yaml.split('\n---\n')[0];
 assert.match(role,/resources: \[volumes, replicas, engines, nodes\]\n    verbs: \[get, list, watch\]/);
 assert.match(role,/resources: \[settings\]\n    resourceNames: \[replica-soft-anti-affinity\]\n    verbs: \[get\]/);
 assert.match(role,/resources: \[backuptargets\]\n    verbs: \[get, list\]/);
 assert.equal((role.match(/verbs:/g)||[]).length,3);
 assert.doesNotMatch(role,/create|update|patch|delete|escalate|bind|impersonate|\*/);
 assert.doesNotMatch(role,/secrets/);
});
