import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PLATFORM_CORE_ARTIFACT,preparePlatformCorePrerequisites} from '../src/platform-core-prerequisites.mjs';
import {PROFILE as ARGO} from '../src/psss-argocd-rbac-profile.mjs';

// localhost 2026-09-29: the Console upgrade stopped at Core preparation because `prepare-psss-argocd` had
// already narrowed the six Argo roles and the PSSS Core reader predated the writer-fence read.
const scope={context:'docker-desktop',channel:'edge',consoleUrl:'https://localhost:1114'};
const source=process.env.OPENSPHERE_CONSOLE_SOURCE;
const oldRaw=readFileSync(resolve(import.meta.dirname,'fixtures/console-contract-v66',PLATFORM_CORE_ARTIFACT),'utf8');
const newRaw=source&&execFileSync('git',['-C',source,'show',`7aa06cba:${PLATFORM_CORE_ARTIFACT}`],{encoding:'utf8',maxBuffer:8*1024*1024});
const id=r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const READER='rbac.authorization.k8s.io/v1/ClusterRole//opensphere-platform-support-core-reader';
const argoKey=row=>`rbac.authorization.k8s.io/v1/${row.kind}/${row.namespace||''}/${row.name}`;
function client(present){let serial=0;const state=new Map(),creates=[],patches=[];
 const put=r=>{r=structuredClone(r);r.metadata.uid||='uid-'+(++serial);r.metadata.resourceVersion||='1';
  if(r.kind==='CustomResourceDefinition')r.spec={conversion:{strategy:'None'},...r.spec};state.set(id(r),r);return structuredClone(r);};
 for(const n of ['opensphere-console','argocd','crossplane-system'])put({apiVersion:'v1',kind:'Namespace',metadata:{name:n}});
 for(const name of ['opensphere-cluster-manager-runtime','opensphere-platform-support-runtime'])put({apiVersion:'v1',kind:'ServiceAccount',metadata:{name,namespace:'opensphere-console'}});
 present.forEach(put);
 return {state,creates,patches,async read(items){return items.flatMap(r=>state.has(id(r))?[structuredClone(state.get(id(r)))]:[]);},
  async create(r){assert(!state.has(id(r)));creates.push(id(r));return put(r);},
  async patchRules(r,ops){patches.push({identity:id(r),ops});const live=state.get(id(r));
   for(const op of ops.filter(op=>op.op==='test')){const at=op.path==='/rules'?live.rules:live.metadata[op.path.split('/').pop()];if(!same(at,op.value))throw Error('test failed');}
   live.rules=structuredClone(ops.at(-1).value);live.metadata.resourceVersion=String(Number(live.metadata.resourceVersion)+1);return structuredClone(live);}};
}
// Live state after `prepare-psss-argocd`: the six Argo roles carry the PSSS policy v2 rules.
function narrowed(profile){return profile.resources.map(r=>{const row=ARGO.resources.find(row=>argoKey(row)===id(r));return row?{...structuredClone(r),rules:structuredClone(row.next)}:structuredClone(r);});}

test('narrowed Argo roles are a reviewed later state, not a conflict, and are never widened back',async()=>{
 const c=client(narrowed(JSON.parse(oldRaw)));
 const plan=await preparePlatformCorePrerequisites(oldRaw,scope,{client:c});
 assert.equal(plan.status,'Prepared');assert.deepEqual(plan.conflicts,[]);assert.equal(plan.reviewedSuccessors.length,6);
 const done=await preparePlatformCorePrerequisites(oldRaw,scope,{client:c,apply:true});
 assert.equal(done.preserved.length,53);assert.equal(c.creates.length+c.patches.length,0);
 for(const row of ARGO.resources)assert.ok(same(c.state.get(argoKey(row)).rules,row.next));
});
test('an Argo role with any other rules still blocks every write',async()=>{
 const live=narrowed(JSON.parse(oldRaw));live.find(r=>id(r)===argoKey(ARGO.resources[0])).rules.push({apiGroups:[''],resources:['secrets'],verbs:['*']});
 const c=client(live);
 assert.deepEqual((await preparePlatformCorePrerequisites(oldRaw,scope,{client:c})).conflicts,[argoKey(ARGO.resources[0])]);
 await assert.rejects(preparePlatformCorePrerequisites(oldRaw,scope,{client:c,apply:true}),{code:'PRECONDITION_FAILED'});
 assert.equal(c.creates.length+c.patches.length,0);
});
test('the new profile replaces exactly the earlier reviewed reader rules under a guarded patch',{skip:!source&&'OPENSPHERE_CONSOLE_SOURCE not set'},async()=>{
 const old=JSON.parse(oldRaw),next=JSON.parse(newRaw);
 const c=client(narrowed(old));
 const plan=await preparePlatformCorePrerequisites(newRaw,scope,{client:c});
 assert.equal(plan.status,'NeedsPreparation');assert.deepEqual(plan.reviewedUpdates,[READER]);assert.equal(c.patches.length,0);
 const done=await preparePlatformCorePrerequisites(newRaw,scope,{client:c,apply:true});
 assert.deepEqual(done.updated,[READER]);assert.equal(c.creates.length,0);assert.equal(c.patches.length,1);
 assert.deepEqual(c.patches[0].ops.map(op=>op.op+' '+op.path),['test /metadata/uid','test /metadata/resourceVersion','test /rules','replace /rules']);
 assert.ok(same(c.state.get(READER).rules,next.resources.find(r=>id(r)===READER).rules));
 const replay=await preparePlatformCorePrerequisites(newRaw,scope,{client:c,apply:true});
 assert.equal(replay.updated.length,0);assert.equal(c.patches.length,1);
 // Rollback to the earlier release keeps the newer reviewed reader instead of removing the fence read.
 const rollback=await preparePlatformCorePrerequisites(oldRaw,scope,{client:c,apply:true});
 assert.equal(rollback.status,'Prepared');assert.ok(rollback.reviewedSuccessors.includes(READER));assert.equal(c.patches.length,1);
});
test('an unreviewed reader, a missing patch client, or an unknown patch outcome stop without a blind retry',{skip:!source&&'OPENSPHERE_CONSOLE_SOURCE not set'},async()=>{
 const old=JSON.parse(oldRaw);
 const drift=narrowed(old);drift.find(r=>id(r)===READER).rules.push({apiGroups:[''],resources:['secrets'],verbs:['get']});
 const c=client(drift);
 assert.deepEqual((await preparePlatformCorePrerequisites(newRaw,scope,{client:c})).conflicts,[READER]);
 await assert.rejects(preparePlatformCorePrerequisites(newRaw,scope,{client:c,apply:true}),{code:'PRECONDITION_FAILED'});
 const bare=client(narrowed(old));delete bare.patchRules;
 await assert.rejects(preparePlatformCorePrerequisites(newRaw,scope,{client:bare,apply:true}),{code:'PRECONDITION_FAILED'});
 const lost=client(narrowed(old));lost.patchRules=async()=>{lost.patches.push(1);throw Error('timeout');};
 await assert.rejects(preparePlatformCorePrerequisites(newRaw,scope,{client:lost,apply:true}),{code:'PREPARATION_INCOMPLETE'});
 assert.equal(lost.patches.length,1);assert.equal(bare.creates.length+c.creates.length+lost.creates.length,0);
});
test('the Core adapter patches only the reviewed reader between the two reviewed rule sets',async()=>{
 const {createPlatformCoreClient,coreRulesPatch}=await import('../src/platform-core-prerequisites.mjs');
 const without=JSON.parse(oldRaw).resources.find(r=>id(r)===READER).rules;
 const fenceRead={apiGroups:['admissionregistration.k8s.io'],resources:['validatingadmissionpolicies','validatingadmissionpolicybindings'],verbs:['get'],resourceNames:['opensphere-psss-crossplane-writer-fence']};
 const withFence=[...without.slice(0,3),fenceRead,...without.slice(3)];
 const calls=[],reader={apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRole',metadata:{name:'opensphere-platform-support-core-reader',uid:'u',resourceVersion:'7'},rules:without};
 const c=createPlatformCoreClient(scope,(command,args,options)=>{calls.push(args);return args.includes('kube-system')?JSON.stringify({metadata:{uid:'cluster'}}):JSON.stringify(reader);});
 assert.deepEqual(Object.keys(c).sort(),['create','patchRules','read']);
 await c.patchRules(reader,coreRulesPatch(reader,without,withFence));
 const patch=calls.find(args=>args.includes('patch'));
 assert.deepEqual(patch.slice(0,5),['--context','docker-desktop','patch','clusterrole.rbac.authorization.k8s.io','opensphere-platform-support-core-reader']);
 assert.ok(patch.includes('--type=json'));
 const other={...reader,metadata:{...reader.metadata,name:'argocd-server'}};
 const broad=[...withFence,{apiGroups:[''],resources:['secrets'],verbs:['get']}];
 for(const [label,target,ops] of [
  ['other object',other,coreRulesPatch(other,without,withFence)],
  ['operation shape',reader,[{op:'replace',path:'/rules',value:withFence}]],
  ['arbitrary next rules',reader,coreRulesPatch(reader,without,broad)],
  ['arbitrary previous rules',reader,coreRulesPatch(reader,[],withFence)],
  ['reverse direction',reader,coreRulesPatch(reader,withFence,without)],
  ['foreign uid',reader,coreRulesPatch({metadata:{uid:'x',resourceVersion:'7'}},without,withFence)],
  ['foreign resourceVersion',reader,coreRulesPatch({metadata:{uid:'u',resourceVersion:'6'}},without,withFence)],
  ['missing resourceVersion',{...reader,metadata:{...reader.metadata,resourceVersion:''}},coreRulesPatch({metadata:{uid:'u',resourceVersion:''}},without,withFence)],
 ])await assert.rejects(c.patchRules(target,ops),{code:'PRECONDITION_FAILED'},label);
 assert.equal(calls.filter(args=>args.includes('patch')).length,1);
});
test('bindings moved to PSSS by the reviewed writer transfer are kept, any other subject still conflicts',async()=>{
 const psss={kind:'ServiceAccount',name:'opensphere-platform-support-runtime',namespace:'opensphere-console'};
 const moved=new Set(['rbac.authorization.k8s.io/v1/RoleBinding/crossplane-system/opensphere-platform-support-crossplane-executor',
  'rbac.authorization.k8s.io/v1/RoleBinding/opensphere-console/opensphere-platform-support-core-recorder']);
 const live=narrowed(JSON.parse(oldRaw)).map(r=>moved.has(id(r))?{...r,subjects:[psss]}:r);
 const c=client(live);
 const plan=await preparePlatformCorePrerequisites(oldRaw,scope,{client:c});
 assert.equal(plan.status,'Prepared');assert.deepEqual(plan.conflicts,[]);
 assert.equal(plan.reviewedSuccessors.length,8);
 const done=await preparePlatformCorePrerequisites(oldRaw,scope,{client:c,apply:true});
 assert.equal(done.preserved.length,53);assert.equal(c.creates.length+c.patches.length,0);
 for(const key of moved)assert.deepEqual(c.state.get(key).subjects,[psss]);
 const foreign=live.map(r=>id(r)===[...moved][0]?{...r,subjects:[{...psss,name:'someone-else'}]}:r);
 assert.deepEqual((await preparePlatformCorePrerequisites(oldRaw,scope,{client:client(foreign)})).conflicts,[[...moved][0]]);
});
