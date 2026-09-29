import test from 'node:test';
import assert from 'node:assert/strict';
import {planPsssCrossplaneDrain,applyPsssCrossplaneDrain,
 createPsssCrossplaneDrainClient} from '../src/psss-crossplane-drain-transition.mjs';

const uid='8cdee47b-abb7-4dba-b989-cf9ca292efcb';
const scope={context:'default',clusterUid:uid,
 consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const at=()=>new Date('2026-09-29T00:00:00Z');
const terminal=()=>({apiVersion:'v1',kind:'ConfigMap',metadata:{
 name:'opensphere-his-operation-crossplane-core',namespace:'opensphere-console',
 uid:'operation-uid',resourceVersion:'4',labels:{
  'opensphere.io/platform-core-operation':'crossplane-core'}},
 data:{operation:JSON.stringify({itemId:'crossplane-core',
  id:'11111111-1111-4111-8111-111111111111',phase:'Ready'})}});
function fixture(record=null){
 const f={record,clusterUid:uid,writes:0,
  async readClusterUid(){return this.clusterUid;},
  async readOperation(){return structuredClone(this.record);},
  async preflightHandoff(){
   const suspended=this.record?.metadata?.labels?.['opensphere.io/platform-core-handoff']==='suspended';
   const phase=this.record?.data?.operation?JSON.parse(this.record.data.operation).phase:null;
   const operation={state:phase==='Installing'?'ActiveOrUncertain':phase?'Terminal':'NoRecord',
    ...(this.record?{uid:this.record.metadata.uid,
     resourceVersion:this.record.metadata.resourceVersion}:{}),...(suspended?{suspended:true}:{})};
   return {state:suspended?'Ready':'Unverified',
    modules:[{id:'cluster-manager',state:'Verified'},{id:'platform-support',state:'Verified'}],
    bindings:[{state:'ClusterManager'},{state:'ClusterManager'},{state:'ClusterManager'}],
    core:this.core||'Absent',operation,drain:{state:suspended?'Ready':'Unverified'}};
  },
  async admit(record){
   if(this.deny)throw Error('denied');
   if(this.changeDuringAdmission)this.record={...terminal(),metadata:{...terminal().metadata,
    resourceVersion:'5'}};
   return {kind:'ConfigMap',metadata:{name:'opensphere-his-operation-crossplane-core',
    namespace:'opensphere-console',labels:{'opensphere.io/platform-core-handoff':'suspended'}}};
  },
  async suspend(record){
   this.writes++;
   if(this.loseResponse)throw Error('lost');
   if(record){
    this.record=structuredClone(record);
    this.record.metadata.labels['opensphere.io/platform-core-handoff']='suspended';
    this.record.metadata.resourceVersion='5';
   }else this.record={apiVersion:'v1',kind:'ConfigMap',metadata:{
    name:'opensphere-his-operation-crossplane-core',namespace:'opensphere-console',
    uid:'operation-uid',resourceVersion:'1',labels:{
     'opensphere.io/platform-core-operation':'crossplane-core',
     'opensphere.io/platform-core-handoff':'suspended'}},data:{}};
  },
 };return f;
}
test('reviewed absent record is suspended by a single create and re-observed',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneDrain(scope,{client:f,now:at});
 assert.equal(plan.state,'NeedsSuspension');assert.equal(plan.applicable,true);
 assert.equal(f.writes,0);
 const result=await applyPsssCrossplaneDrain(scope,{client:f,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at});
 assert.equal(result.state,'Suspended');assert.equal(result.handoff.drain.state,'Ready');
 assert.equal(f.writes,1);
});
test('terminal operation is marked without replacing its receipt',async()=>{
 const f=fixture(terminal()),before=f.record.data.operation;
 const plan=await planPsssCrossplaneDrain(scope,{client:f,now:at});
 assert.equal(plan.applicable,true);
 await applyPsssCrossplaneDrain(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at});
 assert.equal(f.record.data.operation,before);
 assert.equal(f.record.metadata.labels['opensphere.io/platform-core-handoff'],'suspended');
});
test('active work, stale review, changed cluster or concurrent CM write never suspends',async()=>{
 const busy=terminal();busy.data.operation=JSON.stringify({...JSON.parse(busy.data.operation),phase:'Installing'});
 const f=fixture(busy),blocked=await planPsssCrossplaneDrain(scope,{client:f,now:at});
 assert.equal(blocked.state,'Blocked');assert.equal(blocked.applicable,false);
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:f,
  planRevision:blocked.planRevision,reviewedAt:blocked.observedAt,now:at}),
  {code:'PRECONDITION_FAILED'});
 assert.equal(f.writes,0);
 const g=fixture(),plan=await planPsssCrossplaneDrain(scope,{client:g,now:at});
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:g,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,
  now:()=>new Date('2026-09-29T00:06:00Z')}),{code:'REVIEW_EXPIRED'});
 g.clusterUid='11111111-1111-4111-8111-111111111111';
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:g,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),{code:'WRONG_CLUSTER'});
 const h=fixture(),review=await planPsssCrossplaneDrain(scope,{client:h,now:at});
 h.changeDuringAdmission=true;
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:h,
  planRevision:review.planRevision,reviewedAt:review.observedAt,now:at}),
  {code:'PLAN_CHANGED'});
 assert.equal(h.writes,0);
});
test('admission refusal and lost write response remain non-success',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneDrain(scope,{client:f,now:at});
 f.deny=true;
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:f,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'ADMISSION_REJECTED'});
 assert.equal(f.writes,0);
 f.deny=false;f.loseResponse=true;
 await assert.rejects(applyPsssCrossplaneDrain(scope,{client:f,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
  {code:'OUTCOME_UNKNOWN'});
});
test('adapter uses server dry-run and UID/RV/operation JSON Patch tests',async()=>{
 const calls=[];
 const client=createPsssCrossplaneDrainClient({context:'default',runner:(_exe,args,options)=>{
  calls.push({args,options});
  return JSON.stringify(args.includes('patch')?{kind:'ConfigMap',metadata:{
   name:'opensphere-his-operation-crossplane-core',namespace:'opensphere-console',
   labels:{'opensphere.io/platform-core-handoff':'suspended'}}}:{});
 }});
 await client.admit(terminal());await client.suspend(terminal());
 assert.equal(calls.length,2);
 assert.ok(calls[0].args.includes('--dry-run=server'));
 assert.equal(calls[1].args.includes('--dry-run=server'),false);
 const patch=JSON.parse(calls[0].args[calls[0].args.indexOf('--patch')+1]);
 assert.deepEqual(patch.slice(0,3).map(row=>row.path),
  ['/metadata/uid','/metadata/resourceVersion','/data/operation']);
 assert.equal(patch[3].value,'suspended');
});

test('new CM Core work is suspended while the existing Core still runs (Codex 2026-09-29 order)',async()=>{
 // localhost 2026-09-29: Core 2.3.3 installed by CM, retained legacy-id operation Ready.
 const legacy=terminal();legacy.data.operation=JSON.stringify({itemId:'crossplane-core',id:'mtqo42en-353622ea',phase:'Ready'});
 const f=fixture(legacy);f.core='PresentOrPartial';
 const before=f.record.data.operation;
 const plan=await planPsssCrossplaneDrain(scope,{client:f,now:at});
 assert.equal(plan.prerequisites,true);assert.equal(plan.applicable,true);
 const result=await applyPsssCrossplaneDrain(scope,{client:f,planRevision:plan.planRevision,
  reviewedAt:plan.observedAt,now:at});
 assert.equal(result.state,'Suspended');
 assert.equal(f.record.data.operation,before,'the retained receipt is not rewritten');
 assert.equal(f.record.metadata.labels['opensphere.io/platform-core-handoff'],'suspended');
});
