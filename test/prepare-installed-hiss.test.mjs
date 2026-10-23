import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareInstalledHiss} from '../src/prepare-installed-hiss.mjs';
import profile from '../src/hiss-preparation-profile.json' with {type:'json'};
import storageObservation from '../src/hiss-storage-observation-artifact.json' with {type:'json'};
import {verifyHissStorageObservationArtifact} from '../src/hiss-prerequisites.mjs';
import operatorStackgres from '../src/hiss-operator-stackgres-artifact.json' with {type:'json'};
import {parseAllDocuments} from 'yaml';
const stackgresDocuments=parseAllDocuments(operatorStackgres.yaml).map(d=>d.toJSON()).filter(Boolean);
const stackgresDocs=()=>stackgresDocuments;
const storageObservationYaml=()=>verifyHissStorageObservationArtifact(storageObservation.yaml);
const identity=r=>`${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
function fixture(change=false,{longhorn=false}={}){
 let serial=0, cluster='cluster-a',writes=0;
 const applies=[];
 const state=new Map();
 const put=r=>state.set(identity(r),{...structuredClone(r),metadata:{...r.metadata,uid:`uid-${++serial}`}});
 for(const [kind,name,namespace] of [['Namespace','opensphere-console'],['Namespace','kube-system'],['Namespace','opensphere-foundation'],['ServiceAccount','opensphere-cluster-manager-runtime','opensphere-console'],['ClusterRole','system:auth-delegator'],['Role','extension-apiserver-authentication-reader','kube-system']])put({apiVersion:kind==='Namespace'||kind==='ServiceAccount'?'v1':'rbac.authorization.k8s.io/v1',kind,metadata:{name,...(namespace?{namespace}:{})}});
 const stackgres=new Map();
 const sgIds=new Set(stackgresDocs().map(identity));
 const runner=(_exe,args,options)=>{
  assert.deepEqual(args.slice(0,2),['--context','rke2']);
  // PostgreSQL Provider P2 step (hiss-operator-stackgres-v1): its own get/apply/read-back, type check and Secret guard probe.
  let sgList=null;try{const v=JSON.parse(options?.input||'');if(v.kind==='List'&&v.items.length&&v.items.every(i=>sgIds.has(identity(i))))sgList=v.items;}catch{}
  if(sgList&&args.includes('get'))return JSON.stringify({kind:'List',items:sgList.filter(d=>stackgres.has(identity(d))).map(d=>stackgres.get(identity(d)))});
  if(sgList&&args.includes('apply')){applies.push(options.input);for(const d of sgList)stackgres.set(identity(d),{...d,metadata:{...d.metadata,uid:'sg-'+identity(d),generation:1},...(d.kind==='ValidatingAdmissionPolicy'?{status:{observedGeneration:1,typeChecking:{}}}:{})});return '';}
  if(args.includes('validatingadmissionpolicy'))return JSON.stringify(stackgres.get('ValidatingAdmissionPolicy//'+args[args.indexOf('validatingadmissionpolicy')+1]));
  if(args.includes('--dry-run=server'))throw Object.assign(new Error('denied'),{stderr:"ValidatingAdmissionPolicy 'opensphere-pfss-pg-foundation-names' denied request"});
  if(args.includes('opensphere-installation-lock'))return JSON.stringify({metadata:{uid:'install-a'},data:{'config.json':JSON.stringify({consoleUrl:'https://console.example.test'}),'release.json':JSON.stringify({channel:'edge',releaseDigest:'sha256:'+'a'.repeat(64)})}});
  if(args.includes('namespace')&&args.includes('kube-system'))return JSON.stringify({metadata:{uid:cluster}});
  if(args.includes('observabilitybindings.observability.opensphere.io'))return '';
  if(args.includes('volumes.longhorn.io')||args.includes('longhorn-system'))return longhorn?args[args.indexOf('get')+1]+'/x\n':'';
  if(args.includes('apply')){assert(args.includes('--server-side'));assert(args.includes('--field-manager=opensphere-setup-hiss'));applies.push(options.input);return '';}
  const input=JSON.parse(options.input);
  if(args.includes('get'))return JSON.stringify({kind:'List',items:input.items.flatMap(r=>state.has(identity(r))?[state.get(identity(r))]:[])});
  assert(args.includes('create'));writes++;put(input);if(change)cluster='cluster-b';return JSON.stringify(state.get(identity(input)));
 };
 return {runner,applies,get writes(){return writes;}};
}
test('installed HISS preparation binds managed identity, creates missing objects and makes replay read-only',async()=>{
 const f=fixture();const first=await prepareInstalledHiss({context:'rke2',apply:true,runner:f.runner});
 assert.equal(first.status,'Prepared');assert.equal(f.writes,profile.resources.length);
 const second=await prepareInstalledHiss({context:'rke2',apply:true,runner:f.runner});
 assert.equal(second.created.length,0);assert.equal(f.writes,profile.resources.length);assert.equal(second.target.clusterUid,'cluster-a');
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
 assert.equal(plain.storageObservation.state,'NotApplicable');assert.equal(plain.observabilityBindingCrd.state,'Applied');assert.equal(without.applies.length,4);
 assert.equal(plain.operatorStackgres.state,'Applied');assert.equal(plain.operatorStackgres.guardProbe,'denied');
 assert.match(without.applies[1],/kind: CustomResourceDefinition/);
 const lh=fixture(false,{longhorn:true});const planned=await prepareInstalledHiss({context:'rke2',runner:lh.runner});
 assert.equal(planned.storageObservation.state,'NeedsPreparation');assert.equal(planned.observabilityBindingCrd.state,'NeedsPreparation');assert.equal(lh.applies.length,0);
 assert.equal(planned.operatorStackgres.state,'NeedsPreparation');
 const applied=await prepareInstalledHiss({context:'rke2',apply:true,runner:lh.runner});
 assert.equal(applied.storageObservation.state,'Applied');assert.equal(lh.applies.length,5);
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
