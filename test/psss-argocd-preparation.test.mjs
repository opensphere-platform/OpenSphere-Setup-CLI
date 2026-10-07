import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE} from '../src/psss-argocd-rbac-profile.mjs';
import {BOOTSTRAP_RESOURCES,planPsssArgoPreparation,applyPsssArgoPreparation} from '../src/psss-argocd-preparation.mjs';
import {createPsssArgoRbacClient} from '../src/psss-argocd-rbac-transition.mjs';

const uid='8cdee47b-abb7-4dba-b989-cf9ca292efcb';
const scope={context:'default',clusterUid:uid,consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const when=()=>new Date('2026-09-29T11:00:00Z');
const key=row=>`${row.kind}/${row.namespace||row.metadata?.namespace}/${row.name||row.metadata?.name}`;
function fixture({prepared=false}={}){
 const rows=new Map(),patched=[],created=[];let sequence=0;
 const add=(manifest)=>{const row=structuredClone(manifest);row.metadata={...row.metadata,
   uid:`uid-${++sequence}`,resourceVersion:String(sequence)};rows.set(key(row),row);return row;};
 for(const row of PROFILE.resources)add({apiVersion:'rbac.authorization.k8s.io/v1',kind:row.kind,
   metadata:{name:row.name,...(row.namespace?{namespace:row.namespace}:{})},rules:structuredClone(row.previous)});
 if(prepared)for(const row of BOOTSTRAP_RESOURCES)add(row);
 const client={rows,patched,created,
  async readClusterUid(){return uid;},
  async read(row){return structuredClone(rows.get(key(row))??null);},
  async admit(row,before){return {...structuredClone(before),rules:structuredClone(row.next)};},
  async patch(row,before){const live=rows.get(key(row));assert.equal(live.metadata.uid,before.metadata.uid);
   assert.equal(live.metadata.resourceVersion,before.metadata.resourceVersion);
   live.rules=structuredClone(row.next);live.metadata.resourceVersion=String(++sequence);
   patched.push(key(row));return structuredClone(live);},
  async admitCreate(row){return structuredClone(row);},
  async create(row){if(rows.has(key(row)))throw Error('already exists');created.push(key(row));return structuredClone(add(row));},
 };
 return client;
}
test('one reviewed preparation covers the six existing roles and three missing bootstrap objects',async()=>{
 const client=fixture(),plan=await planPsssArgoPreparation(scope,{client,now:when});
 assert.equal(plan.state,'NeedsPreparation');assert.equal(plan.resources.length,9);
 assert.equal(plan.resources.filter(row=>row.state==='Missing').length,3);
 assert.equal(client.patched.length,0);assert.equal(client.created.length,0);
 const result=await applyPsssArgoPreparation(scope,{client,planRevision:plan.planRevision,
   reviewedAt:plan.observedAt,now:()=>new Date('2026-09-29T11:01:00Z')});
 assert.equal(result.state,'Prepared');assert.equal(client.patched.length,6);
 assert.deepEqual(client.created,BOOTSTRAP_RESOURCES.map(key));
 assert.deepEqual(client.rows.get('AppProject/argocd/default').spec,
   {description:'Closed default project; reviewed projects are required for deployments',
     sourceRepos:[],destinations:[],clusterResourceWhitelist:[]});
 const repeat=await planPsssArgoPreparation(scope,{client,now:when});assert.equal(repeat.state,'Prepared');
 assert.equal(repeat.applicable,false);
});
test('foreign or widened bootstrap objects stop before any existing role changes',async()=>{
 for(const mutate of [
   client=>client.rows.get('AppProject/argocd/default').spec.sourceRepos.push('*'),
   client=>client.rows.get('Role/argocd/opensphere-platform-support-core-plan-reader').rules[0].verbs.push('patch'),
   client=>client.rows.get('RoleBinding/argocd/opensphere-platform-support-core-plan-reader').subjects[0].name='other',
 ]){
   const client=fixture({prepared:true});mutate(client);
   const plan=await planPsssArgoPreparation(scope,{client,now:when});assert.equal(plan.state,'Blocked');
   await assert.rejects(applyPsssArgoPreparation(scope,{client,planRevision:plan.planRevision,
     reviewedAt:plan.observedAt,now:when}),{code:'PRECONDITION_FAILED'});
   assert.equal(client.patched.length,0);assert.equal(client.created.length,0);
 }
});
test('stale review and changed bootstrap stop before writes; admitted resources are checked first',async()=>{
 const client=fixture(),plan=await planPsssArgoPreparation(scope,{client,now:when});
 await assert.rejects(applyPsssArgoPreparation(scope,{client,planRevision:plan.planRevision,
   reviewedAt:plan.observedAt,now:()=>new Date('2026-09-29T11:06:00Z')}),{code:'REVIEW_EXPIRED'});
 client.rows.set('AppProject/argocd/default',{...structuredClone(BOOTSTRAP_RESOURCES[2]),
   metadata:{...BOOTSTRAP_RESOURCES[2].metadata,uid:'new',resourceVersion:'10'}});
 await assert.rejects(applyPsssArgoPreparation(scope,{client,planRevision:plan.planRevision,
   reviewedAt:plan.observedAt,now:when}),{code:'PLAN_CHANGED'});
 assert.equal(client.patched.length,0);assert.equal(client.created.length,0);
 const denied=fixture(),reviewed=await planPsssArgoPreparation(scope,{client:denied,now:when});
 denied.admitCreate=async()=>{throw Error('admission denied');};
 await assert.rejects(applyPsssArgoPreparation(scope,{client:denied,planRevision:reviewed.planRevision,
   reviewedAt:reviewed.observedAt,now:when}),{code:'ADMISSION_REJECTED'});
 assert.equal(denied.patched.length,0);assert.equal(denied.created.length,0);
});
test('kubectl adapter submits only a fixed object through stdin for server dry-run and create',async()=>{
 const calls=[];
 const client=createPsssArgoRbacClient({context:'default',runner:(_command,args,options)=>{
   calls.push({args,options});return JSON.stringify({...BOOTSTRAP_RESOURCES[0],metadata:{...BOOTSTRAP_RESOURCES[0].metadata,
     uid:'new',resourceVersion:'1'}});
 }});
 await client.admitCreate(BOOTSTRAP_RESOURCES[0]);await client.create(BOOTSTRAP_RESOURCES[0]);
 assert.equal(calls.length,2);
 assert.equal(calls[0].args.includes('--dry-run=server'),true);
 assert.equal(calls[1].args.includes('--dry-run=server'),false);
 assert.deepEqual(JSON.parse(calls[0].options.input),BOOTSTRAP_RESOURCES[0]);
 assert.equal(calls.every(call=>!call.args.includes('--force-conflicts')),true);
});
