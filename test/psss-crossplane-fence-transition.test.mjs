import test from 'node:test';
import assert from 'node:assert/strict';
import {POLICY,BINDING} from '../src/psss-crossplane-writer-fence.mjs';
import {planPsssCrossplaneFence,applyPsssCrossplaneFence,
 createPsssCrossplaneFenceClient} from '../src/psss-crossplane-fence-transition.mjs';

const uid='8cdee47b-abb7-4dba-b989-cf9ca292efcb';
const scope={context:'default',clusterUid:uid,consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const at=()=>new Date('2026-09-29T11:00:00.000Z');
const key=row=>row.kind+'/'+row.metadata.name;
function installed(row,index){
 return {...structuredClone(row),metadata:{...row.metadata,uid:'uid-'+index,resourceVersion:String(index+1)}};
}
function fixture(){
 const rows=new Map(),creates=[],f={
  rows,creates,clusterUid:uid,
  async readClusterUid(){return this.clusterUid;},
  async preflightHandoff(){return this.handoffReadiness||'Ready';},
  async read(row){return structuredClone(rows.get(key(row))??null);},
  async admit(row){if(this.denyAdmission)throw Error('denied');return installed(row,9);},
  async create(row){
   if(rows.has(key(row)))throw Error('already exists');
   const actual=installed(row,creates.length);rows.set(key(row),actual);creates.push(key(row));
   if(this.loseResponse){this.loseResponse=false;throw Error('connection lost');}
   return structuredClone(actual);
  },
 };return f;
}
test('RKE2-scoped review reports two missing resources without a write',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneFence(scope,{client:f,now:at});
 assert.equal(plan.state,'NeedsPreparation');assert.equal(plan.resources.length,2);
 assert.equal(plan.resources.every(row=>row.state==='Missing'),true);
 assert.match(plan.planRevision,/^sha256:[0-9a-f]{64}$/);
 assert.equal(f.creates.length,0);
 f.clusterUid='00000000-0000-4000-8000-000000000000';
 await assert.rejects(planPsssCrossplaneFence(scope,{client:f,now:at}),{code:'WRONG_CLUSTER'});
});
test('reviewed preparation creates only the exact policy and binding, then is idempotent',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneFence(scope,{client:f,now:at});
 const result=await applyPsssCrossplaneFence(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:()=>new Date('2026-09-29T11:01:00.000Z')});
 assert.equal(result.state,'Prepared');assert.equal(result.enforcementVerified,false);
 assert.deepEqual(f.creates,[key(POLICY),key(BINDING)]);
 const repeat=await planPsssCrossplaneFence(scope,{client:f,now:at});
 assert.equal(repeat.state,'Prepared');assert.equal(repeat.applicable,false);
});
test('foreign policy, old review and wrong scope stop before a write',async()=>{
 const f=fixture();f.rows.set(key(POLICY),{...installed(POLICY,1),
  spec:{...POLICY.spec,failurePolicy:'Ignore'}});
 const conflict=await planPsssCrossplaneFence(scope,{client:f,now:at});
 assert.equal(conflict.state,'Blocked');
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:conflict.planRevision,
  reviewedAt:conflict.observedAt,now:at}),{code:'PRECONDITION_FAILED'});
 f.rows.clear();
 const fresh=await planPsssCrossplaneFence(scope,{client:f,now:at});
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:fresh.planRevision,
  reviewedAt:fresh.observedAt,now:()=>new Date('2026-09-29T11:06:00.000Z')}),{code:'REVIEW_EXPIRED'});
 await assert.rejects(planPsssCrossplaneFence({...scope,consoleUrl:'http://console.opensphere.triangles.com'},
  {client:f,now:at}),{code:'INVALID_SCOPE'});
 assert.equal(f.creates.length,0);
});
test('unverified live handoff is visible in the plan and blocks policy creation',async()=>{
 const f=fixture();f.handoffReadiness='Unverified';
 const plan=await planPsssCrossplaneFence(scope,{client:f,now:at});
 assert.equal(plan.handoffReadiness,'Unverified');assert.equal(plan.applicable,false);
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at}),{code:'HANDOFF_UNVERIFIED'});
 assert.equal(f.creates.length,0);
});
test('admission failure or a concurrent object creation stops safely',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneFence(scope,{client:f,now:at});
 f.denyAdmission=true;
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at}),{code:'ADMISSION_REJECTED'});
 assert.equal(f.creates.length,0);
 f.denyAdmission=false;
 const original=f.admit;
 f.admit=async row=>{
  const admitted=await original.call(f,row);
  if(row.kind===BINDING.kind)f.rows.set(key(POLICY),installed(POLICY,8));
  return admitted;
 };
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at}),{code:'PLAN_CHANGED'});
 assert.equal(f.creates.length,0);
});
test('unknown create outcome requires a new review and never duplicates the first resource',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneFence(scope,{client:f,now:at});
 f.loseResponse=true;
 await assert.rejects(applyPsssCrossplaneFence(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at}),{code:'OUTCOME_UNKNOWN'});
 assert.deepEqual(f.creates,[key(POLICY)]);
 const resumed=await planPsssCrossplaneFence(scope,{client:f,now:()=>new Date('2026-09-29T11:02:00.000Z')});
 assert.deepEqual(resumed.resources.map(row=>row.state),['Prepared','Missing']);
 const done=await applyPsssCrossplaneFence(scope,{client:f,planRevision:resumed.planRevision,
  reviewedAt:resumed.observedAt,now:()=>new Date('2026-09-29T11:03:00.000Z')});
 assert.equal(done.state,'Prepared');
 assert.deepEqual(f.creates,[key(POLICY),key(BINDING)]);
});
test('kubectl adapter sends fixed stdin to server dry-run and create',async()=>{
 const calls=[],client=createPsssCrossplaneFenceClient({context:'default',
  kubectl:'/var/lib/rancher/rke2/bin/kubectl',kubeconfig:'/etc/rancher/rke2/rke2.yaml',
  runner:(_executable,args,options)=>{
   calls.push({args,options});
   return JSON.stringify(installed(JSON.parse(options.input),0));
  }});
 await client.admit(POLICY);await client.create(BINDING);
 assert.equal(await client.preflightHandoff(),'Unverified');
 assert.equal(calls[0].args.includes('--dry-run=server'),true);
 assert.equal(calls[1].args.includes('--dry-run=server'),false);
 assert.equal(calls.every(row=>row.args.includes('--context')&&row.args.includes('default')),true);
 assert.equal(calls[0].options.input,JSON.stringify(POLICY));
 assert.equal(calls[1].options.input,JSON.stringify(BINDING));
});
