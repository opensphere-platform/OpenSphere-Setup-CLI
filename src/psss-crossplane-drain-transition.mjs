// Suspend new CM Crossplane Core admissions on the operation ConfigMap itself.
// CM's operation write uses the same Kubernetes resourceVersion, so a request
// racing this marker either commits first and invalidates review or is denied.
import {createHash} from 'node:crypto';
import {run} from './process.mjs';
import {observePsssCrossplaneHandoff,createPsssCrossplaneHandoffClient}
 from './psss-crossplane-handoff-preflight.mjs';

const NAME='opensphere-his-operation-crossplane-core';
const NAMESPACE='opensphere-console';
const LABEL='opensphere.io/platform-core-handoff';
const PATH='/metadata/labels/opensphere.io~1platform-core-handoff';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>Object.assign(Error(message),{code});
const canonical=value=>JSON.stringify(order(value));
function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
const sha=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');

function validate(scope){
 if(!scope||typeof scope.context!=='string'||!scope.context||!UUID.test(scope.clusterUid||'')||
  scope.channel!=='edge')throw fail('INVALID_SCOPE','Explicit context, cluster UID and edge channel required');
 let url;try{url=new URL(scope.consoleUrl);}catch{throw fail('INVALID_SCOPE','HTTPS Console origin required');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
  !/^[a-z0-9.-]+$/i.test(url.hostname))throw fail('INVALID_SCOPE','HTTPS Console origin required');
 return {context:scope.context,clusterUid:scope.clusterUid.toLowerCase(),consoleUrl:url.origin,channel:'edge'};
}
function classify(record,handoff){
 const operation=handoff.operation;
 if(operation.state==='Conflict'||operation.state==='ActiveOrUncertain')return 'Blocked';
 if(operation.state==='ObservationUnavailable')return 'Unverified';
 if(record===null)return 'NeedsSuspension';
 if(record?.metadata?.labels?.[LABEL]==='suspended'&&handoff.drain.state==='Ready')
  return 'Suspended';
 if(!record?.metadata?.uid||!record?.metadata?.resourceVersion||
  record.metadata.name!==NAME||record.metadata.namespace!==NAMESPACE||
  record.metadata.labels?.['opensphere.io/platform-core-operation']!=='crossplane-core'||
  record.metadata.labels?.[LABEL]!==undefined)return 'Blocked';
 return 'NeedsSuspension';
}
async function snapshot(client,scope,observedAt){
 scope=validate(scope);
 let uid,record,handoff;
 try{
  uid=await client.readClusterUid();
  if(uid!==scope.clusterUid)throw fail('WRONG_CLUSTER','kube-system UID changed');
  record=await client.readOperation();
  handoff=await client.preflightHandoff();
 }catch(error){
  if(error.code==='WRONG_CLUSTER')throw error;
  throw fail('OBSERVATION_UNAVAILABLE','Crossplane drain observation failed');
 }
 const state=classify(record,handoff);
 const prerequisites=handoff.modules.every(row=>row.state==='Verified')&&
  handoff.bindings.every(row=>row.state==='ClusterManager')&&handoff.core==='Absent';
 const recordIdentity=record?{uid:record.metadata?.uid||null,
  resourceVersion:record.metadata?.resourceVersion||null,
  operationSha256:sha(record.data?.operation??null)}:null;
 const planRevision=sha({scope,observedAt,state,prerequisites,recordIdentity,handoff});
 return {schema:'opensphere.psss-crossplane-drain-plan/v1',scope,observedAt,planRevision,
  state,prerequisites,applicable:state==='NeedsSuspension'&&prerequisites,
  handoff,recordIdentity,record};
}
export async function planPsssCrossplaneDrain(scope,{client,now=()=>new Date()}={}){
 if(!client||typeof client.readClusterUid!=='function'||typeof client.readOperation!=='function'||
  typeof client.preflightHandoff!=='function')throw Error('Read-only Kubernetes client required');
 const {record,...plan}=await snapshot(client,scope,now().toISOString());return plan;
}
export async function applyPsssCrossplaneDrain(scope,{client,planRevision,reviewedAt,
 now=()=>new Date()}={}){
 if(!client||typeof client.admit!=='function'||typeof client.suspend!=='function')
  throw Error('Kubernetes admission and CAS client required');
 const age=now().getTime()-Date.parse(reviewedAt);
 if(typeof reviewedAt!=='string'||!Number.isFinite(age)||age< -30000||age>300000)
  throw fail('REVIEW_EXPIRED','Review must be less than five minutes old');
 const initial=await snapshot(client,scope,reviewedAt);
 if(initial.planRevision!==planRevision)throw fail('PLAN_CHANGED','Drain differs from reviewed plan');
 if(!initial.applicable)throw fail('PRECONDITION_FAILED','Verified CM/PSSS images and idle Core are required');
 let admitted;try{admitted=await client.admit(initial.record);}catch{
  throw fail('ADMISSION_REJECTED','Kubernetes server dry-run rejected the fixed drain marker');
 }
 if(admitted?.metadata?.labels?.[LABEL]!=='suspended'||admitted.metadata?.name!==NAME||
  admitted.metadata?.namespace!==NAMESPACE)
  throw fail('ADMISSION_REJECTED','Server changed the fixed drain marker');
 const before=await snapshot(client,scope,reviewedAt);
 if(before.planRevision!==planRevision)throw fail('PLAN_CHANGED','Core state changed during admission');
 try{await client.suspend(before.record);}catch{
  throw fail('OUTCOME_UNKNOWN','Drain write outcome unknown; inspect before retrying');
 }
 const after=await snapshot(client,scope,now().toISOString());
 if(after.state!=='Suspended'||after.handoff.drain.state!=='Ready')
  throw fail('OUTCOME_UNKNOWN','New CM Core work is not proven suspended');
 const {record,...result}=after;
 return {...result,changed:true};
}
export function createPsssCrossplaneDrainClient({context,kubectl='kubectl',kubeconfig='',runner=run}={}){
 if(!context||typeof context!=='string'||!/^[A-Za-z0-9_.:@/-]+$/.test(context)||
  !kubectl||typeof kubectl!=='string'||(kubeconfig&&typeof kubeconfig!=='string'))
  throw fail('INVALID_SCOPE','Explicit kubectl context and executable required');
 const base=[...(kubeconfig?['--kubeconfig',kubeconfig]:[]),'--context',context];
 const handoff=createPsssCrossplaneHandoffClient({context,kubectl,kubeconfig,runner});
 const execute=(args,input)=>runner(kubectl,[...base,...args,'--request-timeout=10s','-o','json'],
  {capture:true,input,spawn:{maxBuffer:2*1024*1024,timeout:30000}});
 const placeholder={apiVersion:'v1',kind:'ConfigMap',metadata:{name:NAME,namespace:NAMESPACE,
  labels:{'app.kubernetes.io/managed-by':'opensphere-cluster-manager',
   'opensphere.io/platform-core-operation':'crossplane-core',[LABEL]:'suspended'}},data:{}};
 const patch=record=>[
  {op:'test',path:'/metadata/uid',value:record.metadata.uid},
  {op:'test',path:'/metadata/resourceVersion',value:record.metadata.resourceVersion},
  {op:'test',path:'/data/operation',value:record.data.operation},
  {op:'add',path:PATH,value:'suspended'},
 ];
 const mutate=(record,dryRun)=>record
  ?JSON.parse(execute(['patch','configmap',NAME,'-n',NAMESPACE,'--type=json',
    ...(dryRun?['--dry-run=server']:[]),'--patch',JSON.stringify(patch(record))]))
  :JSON.parse(execute(['create',...(dryRun?['--dry-run=server']:[]),'-f','-'],
    JSON.stringify(placeholder)));
 return {
  async readClusterUid(){return JSON.parse(execute(['get','namespace','kube-system'])).metadata?.uid;},
  async readOperation(){const raw=execute(['get','configmap',NAME,'-n',NAMESPACE,
   '--ignore-not-found']);return raw?JSON.parse(raw):null;},
  async preflightHandoff(){return observePsssCrossplaneHandoff(handoff);},
  async admit(record){return mutate(record,true);},
  async suspend(record){return mutate(record,false);},
 };
}
