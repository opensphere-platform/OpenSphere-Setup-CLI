import test from 'node:test';
import assert from 'node:assert/strict';
import {BINDINGS} from '../src/psss-crossplane-handoff-preflight.mjs';
import {POLICY,BINDING} from '../src/psss-crossplane-writer-fence.mjs';
import {planPsssCrossplaneWriterTransfer,applyPsssCrossplaneWriterTransfer,
 createPsssCrossplaneWriterTransferClient} from '../src/psss-crossplane-writer-transition.mjs';

const uid='8cdee47b-abb7-4dba-b989-cf9ca292efcb';
const scope={context:'default',clusterUid:uid,
 consoleUrl:'https://console.opensphere.triangles.com',channel:'edge'};
const at=()=>new Date('2026-09-29T00:00:00Z');
const CM={kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',
 namespace:'opensphere-console'};
const PSSS={kind:'ServiceAccount',name:'opensphere-platform-support-runtime',
 namespace:'opensphere-console'};
function identity(row){return row.kind+'/'+(row.namespace||'')+'/'+row.name;}
function record(row,i,subject=CM){return {apiVersion:'rbac.authorization.k8s.io/v1',
 kind:row.kind,metadata:{name:row.name,...(row.namespace?{namespace:row.namespace}:{}),
  uid:'binding-'+i,resourceVersion:'1'},
 roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:row.roleKind,name:row.roleName},
 subjects:[structuredClone(subject)]};}
function fixture(subjects=[CM,CM,CM]){
 const bindings=new Map(BINDINGS.map((row,i)=>[identity(row),record(row,i,subjects[i])]));
 const policy={...structuredClone(POLICY),metadata:{...POLICY.metadata,uid:'policy',resourceVersion:'3'}};
 const binding={...structuredClone(BINDING),metadata:{...BINDING.metadata,uid:'fence-binding',resourceVersion:'4'}};
 const f={bindings,policy,binding,clusterUid:uid,writes:[],
  async readClusterUid(){return this.clusterUid;},
  async preflightHandoff(){return {modules:[{id:'cluster-manager',state:'Verified'},
   {id:'platform-support',state:'Verified'}],
   operation:{state:'NoRecord',suspended:true,uid:'drain',resourceVersion:'2'},
   drain:{state:'Ready',uid:'drain',resourceVersion:'2'},core:'Absent',
   bindings:BINDINGS.map(row=>{
    const value=this.bindings.get(identity(row));
    return {name:row.name,state:value.subjects[0].name===CM.name?'ClusterManager':'PlatformSupport',
     uid:value.metadata.uid,resourceVersion:value.metadata.resourceVersion};})};},
  async readFence(){return [structuredClone(this.policy),structuredClone(this.binding)];},
  async readBinding(row){return structuredClone(this.bindings.get(identity(row)));},
  async verifyFence(){return this.enforcement||'Verified';},
  async admit(row,value){
   if(this.denyAdmission)throw Error('denied');
   if(this.concurrentChange){this.bindings.get(identity(row)).metadata.resourceVersion='2';
    this.concurrentChange=false;}
   const next=structuredClone(value);next.subjects=[PSSS];return next;
  },
  async patch(row,value){
   this.writes.push(identity(row));
   if(this.loseResponse){this.loseResponse=false;throw Error('lost');}
   const current=this.bindings.get(identity(row));
   if(current.metadata.resourceVersion!==value.metadata.resourceVersion)throw Error('CAS conflict');
   current.subjects=[structuredClone(PSSS)];
   current.metadata.resourceVersion=String(Number(current.metadata.resourceVersion)+1);
   return structuredClone(current);
  },
 };return f;
}
test('reviewed transfer patches only the three fixed bindings in executor-first order',async()=>{
 const f=fixture(),plan=await planPsssCrossplaneWriterTransfer(scope,{client:f,now:at});
 assert.equal(plan.state,'NeedsTransfer');assert.equal(plan.applicable,true);
 assert.equal(f.writes.length,0);
 const result=await applyPsssCrossplaneWriterTransfer(scope,{client:f,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at});
 assert.equal(result.state,'Transferred');assert.equal(result.exclusiveWriterVerified,true);
 assert.deepEqual(f.writes,BINDINGS.map(identity));
 assert.equal(result.resources.every(row=>row.state==='PlatformSupport'),true);
});
test('partially transferred bindings resume from a fresh review without rewriting the first',async()=>{
 const f=fixture([PSSS,CM,CM]);
 const plan=await planPsssCrossplaneWriterTransfer(scope,{client:f,now:at});
 assert.equal(plan.applicable,true);
 const result=await applyPsssCrossplaneWriterTransfer(scope,{client:f,
  planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at});
 assert.equal(result.state,'Transferred');
 assert.deepEqual(f.writes,BINDINGS.slice(1).map(identity));
});
test('missing or ineffective fence, active Core, or foreign binding blocks before writes',async()=>{
 for(const change of [
  f=>{f.policy=null;},
  f=>{f.enforcement='Unverified';},
  f=>{const previous=f.preflightHandoff.bind(f);
   f.preflightHandoff=async()=>({...await previous(),
    operation:{state:'ActiveOrUncertain'},drain:{state:'Unverified'}});},
  f=>{f.bindings.get(identity(BINDINGS[0])).subjects[0].name='other';},
 ]){
  const f=fixture();change(f);
  const plan=await planPsssCrossplaneWriterTransfer(scope,{client:f,now:at});
  assert.equal(plan.applicable,false);
  await assert.rejects(applyPsssCrossplaneWriterTransfer(scope,{client:f,
   planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
   {code:'PRECONDITION_FAILED'});
  assert.equal(f.writes.length,0);
 }
});
test('admission conflict, concurrent change and lost response do not continue to a second binding',async()=>{
 for(const failure of ['denyAdmission','concurrentChange','loseResponse']){
  const f=fixture(),plan=await planPsssCrossplaneWriterTransfer(scope,{client:f,now:at});
  f[failure]=true;
  await assert.rejects(applyPsssCrossplaneWriterTransfer(scope,{client:f,
   planRevision:plan.planRevision,reviewedAt:plan.observedAt,now:at}),
   {code:failure==='denyAdmission'?'ADMISSION_REJECTED':
    failure==='concurrentChange'?'PLAN_CHANGED':'OUTCOME_UNKNOWN'});
  assert.equal(f.writes.length,failure==='loseResponse'?1:0);
 }
});
test('adapter proves deny and HISS allow only through server dry-run and patches with CAS tests',async()=>{
 const calls=[];
 const client=createPsssCrossplaneWriterTransferClient({context:'default',runner:(_exe,args,options)=>{
  calls.push({args,options});
  if(args.includes('can-i'))return 'yes';
  if(args.includes('get'))return '';
  if(args.includes('create')){
   const value=JSON.parse(options.input);
   if(value.metadata.namespace==='crossplane-system')
    throw Error("ValidatingAdmissionPolicy 'opensphere-psss-crossplane-writer-fence' denied request");
   return JSON.stringify(value);
  }
  if(args.includes('patch')){
   const value=record(BINDINGS[0],0,PSSS);return JSON.stringify(value);
  }
  throw Error('unexpected');
 }});
 assert.equal(await client.verifyFence(),'Verified');
 const dryruns=calls.filter(call=>call.args.includes('create')&&!call.args.includes('can-i'));
 assert.equal(dryruns.length,2);
 assert.equal(dryruns.every(call=>
  call.args.includes('--dry-run=server')),true);
 await client.admit(BINDINGS[0],record(BINDINGS[0],0));
 const patchCall=calls.at(-1),ops=JSON.parse(patchCall.args[patchCall.args.indexOf('--patch')+1]);
 assert.deepEqual(ops.map(row=>row.path),
  ['/metadata/uid','/metadata/resourceVersion','/roleRef','/subjects','/subjects']);
 assert.equal(patchCall.args.includes('--dry-run=server'),true);
});
