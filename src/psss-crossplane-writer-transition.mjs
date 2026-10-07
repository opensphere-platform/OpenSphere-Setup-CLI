// Reviewed CM -> PSSS transfer of the three fixed Crossplane Core bindings.
// The CM drain and a live, denying admission fence must already be in place.
import {createHash} from 'node:crypto';
import {run} from './process.mjs';
import {BINDINGS,observePsssCrossplaneHandoff,createPsssCrossplaneHandoffClient}
 from './psss-crossplane-handoff-preflight.mjs';
import {POLICY,BINDING,CM_USERNAME,matchesWriterFence}
 from './psss-crossplane-writer-fence.mjs';

const PSSS={kind:'ServiceAccount',name:'opensphere-platform-support-runtime',
 namespace:'opensphere-console'};
const CM={kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',
 namespace:'opensphere-console'};
const fail=(code,message,changed)=>Object.assign(Error(message),{code,
 ...(changed?{changed}:{})});
const canonical=value=>JSON.stringify(order(value));
function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
const sha=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const bindingKey=row=>row.kind+'/'+(row.namespace||'')+'/'+row.name;
function validate(scope){
 if(!scope||typeof scope.context!=='string'||!scope.context||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope.clusterUid||'')||
  scope.channel!=='edge')throw fail('INVALID_SCOPE','Explicit context, cluster UID and edge channel required');
 let url;try{url=new URL(scope.consoleUrl);}catch{throw fail('INVALID_SCOPE','HTTPS Console origin required');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
  !/^[a-z0-9.-]+$/i.test(url.hostname))throw fail('INVALID_SCOPE','HTTPS Console origin required');
 return {context:scope.context,clusterUid:scope.clusterUid.toLowerCase(),
  consoleUrl:url.origin,channel:'edge'};
}
function bindingState(row,value){
 if(!value||value.kind!==row.kind||value.apiVersion!=='rbac.authorization.k8s.io/v1'||
  value.metadata?.name!==row.name||(value.metadata.namespace||null)!==row.namespace||
  !value.metadata.uid||!value.metadata.resourceVersion||value.metadata.deletionTimestamp||
  value.roleRef?.apiGroup!=='rbac.authorization.k8s.io'||
  value.roleRef.kind!==row.roleKind||value.roleRef.name!==row.roleName||
  value.subjects?.length!==1)return 'Conflict';
 const subject=value.subjects[0];
 if(canonical(subject)===canonical(CM))return 'ClusterManager';
 if(canonical(subject)===canonical(PSSS))return 'PlatformSupport';
 return 'Conflict';
}
const fenceIdentity=value=>value?{uid:value.metadata?.uid||null,
 resourceVersion:value.metadata?.resourceVersion||null}:null;
// localhost 2026-09-29: every status write changes a Pod's resourceVersion, and one changed right after
// the first binding moved. The module identity is its verified image, registration, package, deployment
// and Pod UIDs; a replaced Pod still stops the transfer.
const moduleIdentity=modules=>Array.isArray(modules)?modules.map(({pods,...row})=>({...row,
 pods:Array.isArray(pods)?pods.map(pod=>({uid:pod?.uid??null})):pods})):modules;
function fixedEvidence(handoff,policy,binding){
 return {modules:moduleIdentity(handoff.modules),operation:handoff.operation,
  drain:handoff.drain,core:handoff.core,
  policy:fenceIdentity(policy),binding:fenceIdentity(binding)};
}
// The executor binding (BINDINGS[0]) is CM's only Crossplane write grant here. While CM holds it, the fence
// must be seen denying a write RBAC allows. Once it moved, RBAC itself denies CM, so the policy denial can
// no longer be observed: that is accepted only with the executor already transferred (localhost
// 2026-09-29, where the old rule stopped every transfer after its first binding).
const enforced=(enforcement,resources)=>enforcement==='Verified'||
 (enforcement==='RbacWithdrawn'&&resources[0]?.state==='PlatformSupport');
async function snapshot(client,scope,observedAt){
 scope=validate(scope);
 let clusterUid,handoff,policy,binding,records;
 try{
  clusterUid=await client.readClusterUid();
  if(clusterUid!==scope.clusterUid)throw fail('WRONG_CLUSTER','kube-system UID changed');
  [handoff,[policy,binding],records]=await Promise.all([
   client.preflightHandoff(),client.readFence(),
   Promise.all(BINDINGS.map(row=>client.readBinding(row)))]);
 }catch(error){
  if(error.code==='WRONG_CLUSTER')throw error;
  throw fail('OBSERVATION_UNAVAILABLE','Crossplane writer transfer observation failed');
 }
 const fenceReady=matchesWriterFence(policy,binding)&&
  !!policy?.metadata?.uid&&!!policy.metadata.resourceVersion&&
  !!binding?.metadata?.uid&&!!binding.metadata.resourceVersion;
 let enforcement='Unverified';
 if(fenceReady){try{enforcement=await client.verifyFence();}catch{enforcement='Unverified';}}
 const resources=BINDINGS.map((row,i)=>({kind:row.kind,name:row.name,namespace:row.namespace,
  state:bindingState(row,records[i]),uid:records[i]?.metadata?.uid||null,
  resourceVersion:records[i]?.metadata?.resourceVersion||null}));
 const bindingReadsAgree=resources.every((row,i)=>{
  const observed=handoff.bindings?.[i];
  return observed?.name===row.name&&observed?.state===row.state&&
   observed?.uid===row.uid&&observed?.resourceVersion===row.resourceVersion;
 });
 const prerequisite=handoff.modules?.every(row=>row.state==='Verified')&&
  ['NoRecord','Terminal'].includes(handoff.operation?.state)&&
  handoff.drain?.state==='Ready'&&handoff.core==='Absent'&&
  fenceReady&&enforced(enforcement,resources)&&
  bindingReadsAgree&&resources.every(row=>['ClusterManager','PlatformSupport'].includes(row.state));
 const state=!prerequisite?'Blocked':resources.every(row=>row.state==='PlatformSupport')
  ?'Transferred':'NeedsTransfer';
 const fixed=fixedEvidence(handoff,policy,binding);
 const planRevision=sha({scope,observedAt,state,fixed,resources});
 return {schema:'opensphere.psss-crossplane-writer-transfer/v1',scope,observedAt,
  planRevision,state,applicable:state==='NeedsTransfer',
  fence:{state:fenceReady?'Prepared':'Unverified',enforcement,
   policy:fenceIdentity(policy),binding:fenceIdentity(binding)},
  handoff,resources,fixed,records};
}
export async function planPsssCrossplaneWriterTransfer(scope,{client,now=()=>new Date()}={}){
 if(!client||!['readClusterUid','preflightHandoff','readFence','readBinding','verifyFence']
  .every(name=>typeof client[name]==='function'))throw Error('Kubernetes review client required');
 const {fixed,records,...plan}=await snapshot(client,scope,now().toISOString());
 return plan;
}
export async function applyPsssCrossplaneWriterTransfer(scope,{client,planRevision,reviewedAt,
 now=()=>new Date(),onProgress=()=>{}}={}){
 if(!client||typeof client.admit!=='function'||typeof client.patch!=='function')
  throw Error('Kubernetes CAS client required');
 const age=now().getTime()-Date.parse(reviewedAt);
 if(typeof reviewedAt!=='string'||!Number.isFinite(age)||age< -30000||age>300000)
  throw fail('REVIEW_EXPIRED','Review must be less than five minutes old');
 const initial=await snapshot(client,scope,reviewedAt);
 if(initial.planRevision!==planRevision)throw fail('PLAN_CHANGED','Writer binding differs from reviewed plan');
 if(!initial.applicable)throw fail('PRECONDITION_FAILED','CM drain, signed images and effective fence required');
 const pending=initial.resources.map((value,i)=>({row:BINDINGS[i],value,record:initial.records[i]}))
  .filter(row=>row.value.state==='ClusterManager');
 for(const {row,record} of pending){
  let result;try{result=await client.admit(row,record);}catch{
   throw fail('ADMISSION_REJECTED','Writer binding server dry-run failed');
  }
  if(bindingState(row,result)!=='PlatformSupport'||result.metadata.uid!==record.metadata.uid)
   throw fail('ADMISSION_REJECTED','Server changed the fixed writer binding');
 }
 const changed=[];
 const expected=initial.resources.map(row=>({state:row.state,uid:row.uid,
  resourceVersion:row.resourceVersion}));
 for(const {row} of pending){
  const before=await snapshot(client,scope,reviewedAt);
  if(before.state!=='NeedsTransfer'||canonical(before.fixed)!==canonical(initial.fixed)||
   before.resources.some((value,i)=>value.state!==expected[i].state||
    value.uid!==expected[i].uid||value.resourceVersion!==expected[i].resourceVersion))
   throw fail('PLAN_CHANGED','Writer evidence changed during transfer',changed);
  const i=BINDINGS.indexOf(row),record=before.records[i];
  try{await client.patch(row,record);}catch{
   throw fail('OUTCOME_UNKNOWN','Writer patch outcome unknown; inspect before resuming',changed);
  }
  let after;try{after=await client.readBinding(row);}catch{
   throw fail('OUTCOME_UNKNOWN','Patched writer binding cannot be observed',changed);
  }
  if(bindingState(row,after)!=='PlatformSupport'||after.metadata.uid!==record.metadata.uid)
   throw fail('OUTCOME_UNKNOWN','Writer binding postcondition unverified',changed);
  expected[i]={state:'PlatformSupport',uid:after.metadata.uid,
   resourceVersion:after.metadata.resourceVersion};
  changed.push(bindingKey(row));
  try{onProgress({resource:bindingKey(row),state:'PlatformSupport'});}catch{/* progress is not authority */}
 }
 const final=await snapshot(client,scope,now().toISOString());
 if(final.state!=='Transferred'||canonical(final.fixed)!==canonical(initial.fixed)||
  final.resources.some((value,i)=>value.uid!==expected[i].uid||
   value.state!=='PlatformSupport'))
  throw fail('OUTCOME_UNKNOWN','Writer transfer final state unverified',changed);
 const {fixed,records,...result}=final;
 return {...result,changed:changed.length>0,updated:changed,
  // snapshot re-runs the CM server dry-runs after all CAS writes: HISS still allowed, Crossplane denied
  // (by RBAC now that the executor moved). PSSS independently rechecks the exact fence, drain and bindings.
  exclusiveWriterVerified:true};
}

const probeName='opensphere-psss-writer-fence-probe';
const probe=namespace=>({apiVersion:'apps/v1',kind:'Deployment',metadata:{
 name:probeName,namespace},spec:{replicas:0,selector:{matchLabels:{app:probeName}},
 template:{metadata:{labels:{app:probeName}},spec:{containers:[{
  name:'probe',image:'registry.k8s.io/pause:3.10'}]}}}});
export function createPsssCrossplaneWriterTransferClient({context,kubectl='kubectl',kubeconfig='',runner=run}={}){
 if(!context||typeof context!=='string'||!/^[A-Za-z0-9_.:@/-]+$/.test(context)||
  !kubectl||typeof kubectl!=='string'||(kubeconfig&&typeof kubeconfig!=='string'))
  throw fail('INVALID_SCOPE','Explicit kubectl context and executable required');
 const base=[...(kubeconfig?['--kubeconfig',kubeconfig]:[]),'--context',context];
 const handoff=createPsssCrossplaneHandoffClient({context,kubectl,kubeconfig,runner});
 const execute=(args,input)=>runner(kubectl,[...base,...args,'--request-timeout=10s','-o','json'],
  {capture:true,input,spawn:{maxBuffer:2*1024*1024,timeout:30000}});
 const get=(kind,name,namespace)=>{const args=['get',kind,name,'--ignore-not-found'];
  if(namespace)args.push('-n',namespace);
  const raw=execute(args);return raw?JSON.parse(raw):null;};
 const patch=row=>[
  {op:'test',path:'/metadata/uid',value:row.metadata.uid},
  {op:'test',path:'/metadata/resourceVersion',value:row.metadata.resourceVersion},
  {op:'test',path:'/roleRef',value:row.roleRef},
  {op:'test',path:'/subjects',value:[CM]},
  {op:'replace',path:'/subjects',value:[PSSS]},
 ];
 const mutate=(row,current,dryRun)=>JSON.parse(execute(['patch',row.kind.toLowerCase(),
  row.name,...(row.namespace?['-n',row.namespace]:[]),'--type=json',
  ...(dryRun?['--dry-run=server']:[]),'--patch',JSON.stringify(patch(current))]));
 return {
  async readClusterUid(){return get('namespace','kube-system')?.metadata?.uid;},
  async preflightHandoff(){return observePsssCrossplaneHandoff(handoff);},
  async readFence(){return [get('validatingadmissionpolicy',POLICY.metadata.name),
   get('validatingadmissionpolicybinding',BINDING.metadata.name)];},
  async readBinding(row){return handoff.readBinding(row);},
  async verifyFence(){
   // Server dry-runs as the exact CM identity; `auth can-i` is not evidence. The HISS path must still
   // work. In crossplane-system either the fence denies a write RBAC allowed (Verified), or, once the
   // executor binding moved, RBAC denies it first (RbacWithdrawn; the snapshot accepts that only then).
   // An admitted Crossplane write is never fenced.
   for(const namespace of ['crossplane-system','cert-manager'])
    if(get('deployment',probeName,namespace)!==null)return 'Unverified';
   let allowed;
   try{allowed=JSON.parse(execute(['create','--dry-run=server','--as='+CM_USERNAME,
    '-f','-'],JSON.stringify(probe('cert-manager'))));}catch{return 'Unverified';}
   if(allowed?.kind!=='Deployment'||allowed.metadata?.name!==probeName||
    allowed.metadata?.namespace!=='cert-manager')return 'Unverified';
   try{execute(['create','--dry-run=server','--as='+CM_USERNAME,'-f','-'],
    JSON.stringify(probe('crossplane-system')));}catch(error){
    const message=String(error.message||'');
    if(message.includes(`ValidatingAdmissionPolicy '${POLICY.metadata.name}'`)&&message.includes('denied request'))
     return 'Verified';
    if(message.includes(`User "${CM_USERNAME}" cannot create resource "deployments" in API group "apps" in the namespace "crossplane-system"`))
     return 'RbacWithdrawn';
   }
   return 'Unverified';
  },
  async admit(row,current){return mutate(row,current,true);},
  async patch(row,current){return mutate(row,current,false);},
 };
}
