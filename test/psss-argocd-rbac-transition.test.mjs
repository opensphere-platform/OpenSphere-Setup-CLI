import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE} from '../src/psss-argocd-rbac-profile.mjs';
import {planPsssArgoRbac,applyPsssArgoRbac,createPsssArgoRbacClient} from '../src/psss-argocd-rbac-transition.mjs';

const uid='8cdee47b-abb7-4dba-b989-cf9ca292efcb';
const scope={context:'default',clusterUid:uid,consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const at=()=>new Date('2026-09-29T11:00:00.000Z');
const id=row=>`${row.kind}/${row.namespace||''}/${row.name}`;
function fixture(){
 const rows=new Map(PROFILE.resources.map((row,i)=>[id(row),{
  apiVersion:'rbac.authorization.k8s.io/v1',kind:row.kind,
  metadata:{name:row.name,...(row.namespace?{namespace:row.namespace}:{}),uid:'role-uid-'+i,resourceVersion:String(i+1)},
  rules:structuredClone(row.previous),
 }]));
 const f={rows,patches:[],reads:0,clusterUid:uid,
  async readClusterUid(){return this.clusterUid;},
  async read(row){this.reads++;return structuredClone(rows.get(id(row))??null);},
  async admit(row,before){if(this.denyAdmission)throw Error('admission denied');return {...structuredClone(before),rules:structuredClone(row.next)};},
  async patch(row,before){
   const live=rows.get(id(row));assert.equal(before.metadata.uid,live.metadata.uid);
   assert.equal(before.metadata.resourceVersion,live.metadata.resourceVersion);
   live.rules=structuredClone(row.next);live.metadata.resourceVersion=String(Number(live.metadata.resourceVersion)+10);
   this.patches.push(id(row));
   if(this.loseResponse){this.loseResponse=false;throw Error('connection closed');}
   return structuredClone(live);
  },
 };return f;
}
test('fixed six-role plan is read-only and binds the exact RKE2 cluster and review time',async()=>{
 const client=fixture(),plan=await planPsssArgoRbac(scope,{client,now:at});
 assert.equal(plan.state,'NeedsPreparation');assert.equal(plan.resources.length,6);
 assert.equal(plan.resources.every(row=>row.state==='NeedsPreparation'),true);
 assert.match(plan.planRevision,/^sha256:[a-f0-9]{64}$/);assert.equal(client.patches.length,0);
 client.clusterUid='00000000-0000-4000-8000-000000000000';
 await assert.rejects(planPsssArgoRbac(scope,{client,now:at}),{code:'WRONG_CLUSTER'});
 assert.equal(client.patches.length,0);
});
test('fresh reviewed transition changes only six pinned rules and preserves each Role UID',async()=>{
 const client=fixture(),before=[...client.rows.values()].map(row=>row.metadata.uid);
 const plan=await planPsssArgoRbac(scope,{client,now:at});
 const result=await applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,
  now:()=>new Date('2026-09-29T11:01:00.000Z')});
 assert.equal(result.state,'Prepared');assert.equal(client.patches.length,6);
 assert.deepEqual([...client.rows.values()].map(row=>row.metadata.uid),before);
 const repeat=await planPsssArgoRbac(scope,{client,now:at});assert.equal(repeat.state,'Prepared');
 assert.equal(repeat.applicable,false);assert.equal(client.patches.length,6);
});
test('missing, foreign or changed authority never becomes permission to patch',async()=>{
 for(const mutation of [
  f=>f.rows.delete(id(PROFILE.resources[0])),
  f=>f.rows.get(id(PROFILE.resources[0])).rules=[{apiGroups:['*'],resources:['*'],verbs:['*']}],
 ]){
  const client=fixture();mutation(client);const plan=await planPsssArgoRbac(scope,{client,now:at});
  assert.equal(plan.state,'Blocked');
  await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
    {code:'PRECONDITION_FAILED'});
  assert.equal(client.patches.length,0);
 }
});
test('expired or changed review stops before mutation',async()=>{
 const client=fixture(),plan=await planPsssArgoRbac(scope,{client,now:at});
 await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,
  now:()=>new Date('2026-09-29T11:06:00.000Z')}),{code:'REVIEW_EXPIRED'});
 client.rows.get(id(PROFILE.resources[0])).metadata.resourceVersion='changed';
 await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'PLAN_CHANGED'});
 assert.equal(client.patches.length,0);
});
test('server admission rejection is checked for all six roles before any patch',async()=>{
 const client=fixture(),plan=await planPsssArgoRbac(scope,{client,now:at});client.denyAdmission=true;
 await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'ADMISSION_REJECTED'});
 assert.equal(client.patches.length,0);
});
test('concurrent replacement of a reviewed role stops the transition before the first write',async()=>{
 const client=fixture(),plan=await planPsssArgoRbac(scope,{client,now:at});
 const originalAdmit=client.admit;
 client.admit=async function(row,before){
  const result=await originalAdmit.call(this,row,before);
  if(id(row)===id(PROFILE.resources.at(-1)))this.rows.get(id(PROFILE.resources[0])).metadata.resourceVersion='newer';
  return result;
 };
 await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'PLAN_CHANGED'});
 assert.equal(client.patches.length,0);
});
test('non-HTTPS Console origin and invalid channel are rejected before Kubernetes observation',async()=>{
 const client=fixture();
 await assert.rejects(planPsssArgoRbac({...scope,consoleUrl:'http://console.opensphere.triangles.com'},{client,now:at}),
  {code:'INVALID_SCOPE'});
 await assert.rejects(planPsssArgoRbac({...scope,channel:'candidate'},{client,now:at}),
  {code:'INVALID_SCOPE'});
 assert.equal(client.reads,0);
});
test('lost patch response is unknown, then a new plan resumes without reapplying the changed role',async()=>{
 const client=fixture(),plan=await planPsssArgoRbac(scope,{client,now:at});client.loseResponse=true;
 await assert.rejects(applyPsssArgoRbac(scope,{client,planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'OUTCOME_UNKNOWN'});
 assert.equal(client.patches.length,1);
 const reviewed=await planPsssArgoRbac(scope,{client,now:()=>new Date('2026-09-29T11:02:00.000Z')});
 assert.equal(reviewed.resources.filter(row=>row.state==='Prepared').length,1);
 const result=await applyPsssArgoRbac(scope,{client,planRevision:reviewed.planRevision,reviewedAt:reviewed.observedAt,
  now:()=>new Date('2026-09-29T11:03:00.000Z')});
 assert.equal(result.state,'Prepared');assert.equal(client.patches.length,6);
 assert.equal(new Set(client.patches).size,6);
});
test('kubectl adapter uses UID/RV/rules JSON Patch tests and no field takeover',async()=>{
 const calls=[],row=PROFILE.resources[0],before={metadata:{uid:'uid',resourceVersion:'42'}};
 const client=createPsssArgoRbacClient({context:'default',kubectl:'/var/lib/rancher/rke2/bin/kubectl',
  kubeconfig:'/etc/rancher/rke2/rke2.yaml',runner:(_exe,args)=>{
   calls.push(args);return JSON.stringify({kind:row.kind,metadata:before.metadata,rules:row.next});
  }});
 await client.patch(row,before);
 const args=calls[0],ops=JSON.parse(args[args.indexOf('--patch')+1]);
 assert.deepEqual(ops.map(op=>[op.op,op.path]),[
  ['test','/metadata/uid'],['test','/metadata/resourceVersion'],['test','/rules'],['replace','/rules']]);
 assert.equal(args.includes('--force-conflicts'),false);
 await client.admit(row,before);assert.equal(calls[1].includes('--dry-run=server'),true);
 assert.equal(args.includes('--context'),true);assert.equal(args.includes('default'),true);
 assert.equal(args.includes('--kubeconfig'),true);
});
