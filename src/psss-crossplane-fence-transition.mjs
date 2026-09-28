import {createHash} from 'node:crypto';
import {run} from './process.mjs';
import {POLICY,BINDING,matchesWriterFence} from './psss-crossplane-writer-fence.mjs';
import {observePsssCrossplaneHandoff,createPsssCrossplaneHandoffClient} from './psss-crossplane-handoff-preflight.mjs';

const PINNED_SHA='ec055d3d18d1371117d772dce0d8cdb52d267ab093de0849ff83fda76b4f9fef';
const resources=[POLICY,BINDING];
const canonical=value=>JSON.stringify(order(value));
function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
const sha=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const fail=(code,message,evidence)=>Object.assign(Error(message),{code,...(evidence?{evidence}:{})});
const shape=value=>({apiVersion:value?.apiVersion,kind:value?.kind,
  metadata:{name:value?.metadata?.name},spec:value?.spec});
function verifyContract(){
 if(sha(resources)!=='sha256:'+PINNED_SHA||!matchesWriterFence(POLICY,BINDING))
  throw fail('UNTRUSTED_PROFILE','Crossplane writer fence differs from the pinned PSSS contract');
}
function validateScope(scope){
 if(!scope||typeof scope.context!=='string'||!scope.context||
   typeof scope.clusterUid!=='string'||!isUuid(scope.clusterUid)||scope.channel!=='edge')
  throw fail('INVALID_SCOPE','Explicit context, kube-system UID and edge channel are required');
 let url;try{url=new URL(scope.consoleUrl);}catch{throw fail('INVALID_SCOPE','HTTPS Console origin required');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
   !/^[a-z0-9.-]+$/i.test(url.hostname))
  throw fail('INVALID_SCOPE','HTTPS Console origin required');
 return {context:scope.context,clusterUid:scope.clusterUid.toLowerCase(),
  consoleUrl:url.origin,channel:'edge'};
}
function isUuid(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function classify(expected,actual){
 if(actual===null)return 'Missing';
 if(!actual||actual.metadata?.deletionTimestamp||!actual.metadata?.uid||
   !actual.metadata?.resourceVersion||canonical(shape(actual))!==canonical(expected))
  return 'Conflict';
 return 'Prepared';
}
async function snapshot(client,scope,observedAt){
 verifyContract();scope=validateScope(scope);
 let uid,actual,handoff;
 try{
  uid=await client.readClusterUid();
  if(uid!==scope.clusterUid)throw fail('WRONG_CLUSTER','kube-system UID differs from reviewed RKE2 cluster');
  actual=await Promise.all(resources.map(row=>client.read(row)));
  try{handoff=typeof client.preflightHandoff==='function'?await client.preflightHandoff():
   {state:'Unverified',blockers:['HandoffClientUnavailable']};}
  catch{handoff={state:'Unverified',blockers:['HandoffObservationUnavailable']};}
 }catch(error){
  if(error.code==='WRONG_CLUSTER')throw error;
  throw fail('OBSERVATION_UNAVAILABLE','Writer fence observation failed; absence was not inferred');
 }
 const rows=resources.map((row,i)=>({kind:row.kind,name:row.metadata.name,
  state:classify(row,actual[i]),uid:actual[i]?.metadata?.uid||null,
  resourceVersion:actual[i]?.metadata?.resourceVersion||null}));
 const state=rows.some(row=>row.state==='Conflict')?'Blocked':
  rows.every(row=>row.state==='Prepared')?'Prepared':'NeedsPreparation';
 const handoffReadiness=handoff?.state==='Ready'?'Ready':'Unverified';
 const planRevision=sha({contractSha256:PINNED_SHA,scope,observedAt,rows,handoff});
 return {schema:'opensphere.psss-crossplane-fence-plan/v1',owner:'platform-support',
  scope,contractSha256:'sha256:'+PINNED_SHA,observedAt,planRevision,state,
  handoffReadiness,handoff,applicable:state==='NeedsPreparation'&&handoffReadiness==='Ready',
  changed:false,resources:rows,actual};
}
export async function planPsssCrossplaneFence(scope,{client,now=()=>new Date()}={}){
 if(!client||typeof client.readClusterUid!=='function'||typeof client.read!=='function')
  throw Error('Read-only Kubernetes client required');
 const {actual,...plan}=await snapshot(client,scope,now().toISOString());
 return plan;
}
export async function applyPsssCrossplaneFence(scope,{client,planRevision,reviewedAt,
 now=()=>new Date(),onProgress=()=>{}}={}){
 if(!client||typeof client.create!=='function'||typeof client.admit!=='function')
  throw Error('Kubernetes create and admission client required');
 const age=now().getTime()-Date.parse(reviewedAt);
 if(typeof reviewedAt!=='string'||!Number.isFinite(age)||age< -30000||age>300000)
  throw fail('REVIEW_EXPIRED','A plan observed within five minutes is required');
 const initial=await snapshot(client,scope,reviewedAt);
 if(initial.planRevision!==planRevision)throw fail('PLAN_CHANGED','Writer fence differs from reviewed plan');
 if(initial.state==='Blocked')throw fail('PRECONDITION_FAILED','Foreign writer fence exists; no write performed');
 if(initial.handoffReadiness!=='Ready')
  throw fail('HANDOFF_UNVERIFIED','CM operation drain, deployed guard and PSSS authority must be verified before the fence is installed');
 const missing=resources.filter((_,i)=>initial.resources[i].state==='Missing');
 for(const row of missing){
  let admitted;try{admitted=await client.admit(row);}catch{
   throw fail('ADMISSION_REJECTED','Writer fence server dry-run failed; no write performed');
  }
  if(admitted?.kind!==row.kind||admitted?.metadata?.name!==row.metadata.name||
    canonical(shape(admitted))!==canonical(row))
   throw fail('ADMISSION_REJECTED','Server dry-run changed the fixed writer fence; no write performed');
 }
 const changed=[];
 for(const row of missing){
  let currentHandoff;
  try{currentHandoff=await client.preflightHandoff();}catch{
   throw fail('OUTCOME_UNKNOWN','Handoff observation failed; inspect before resuming',{changed});
  }
  if(currentHandoff?.state!=='Ready'||canonical(currentHandoff)!==canonical(initial.handoff))
   throw fail('PLAN_CHANGED','CM/PSSS handoff evidence changed; no further writes',{changed});
  let before;
  try{before=await client.read(row);}catch{
   throw fail('OUTCOME_UNKNOWN','Writer fence reinspection failed; inspect before resuming',{changed});
  }
  if(before!==null)throw fail('PLAN_CHANGED','Writer fence appeared during review; no further writes',{changed});
  try{await client.create(row);}catch{
   throw fail('OUTCOME_UNKNOWN','Create outcome unknown; inspect before resuming',{changed});
  }
  let after;
  try{after=await client.read(row);}catch{
   throw fail('OUTCOME_UNKNOWN','Created writer fence could not be re-observed',{changed});
  }
  if(classify(row,after)!=='Prepared')
   throw fail('OUTCOME_UNKNOWN','Created writer fence differs from fixed policy',{changed});
  changed.push(row.kind+'/'+row.metadata.name);
  try{onProgress({resource:changed.at(-1),state:'Prepared'});}catch{/* progress is not authority */}
 }
 const final=await snapshot(client,scope,now().toISOString());
 if(final.state!=='Prepared')
  throw fail('OUTCOME_UNKNOWN','Writer fence postcondition is incomplete',{changed});
 const {actual,...plan}=final;
 return {...plan,changed:changed.length>0,updated:changed,
  // Exact objects are a necessary prerequisite, not proof of admission enforcement.
  enforcementVerified:false};
}
export function createPsssCrossplaneFenceClient({context,kubectl='kubectl',kubeconfig='',runner=run}={}){
 if(!context||typeof context!=='string'||!/^[A-Za-z0-9_.:@/-]+$/.test(context)||
   !kubectl||typeof kubectl!=='string'||(kubeconfig&&typeof kubeconfig!=='string'))
  throw fail('INVALID_SCOPE','Explicit kubectl context and executable required');
 const base=[...(kubeconfig?['--kubeconfig',kubeconfig]:[]),'--context',context];
 const handoffClient=createPsssCrossplaneHandoffClient({context,kubectl,kubeconfig,runner});
 const execute=(args,input)=>runner(kubectl,[...base,...args,'--request-timeout=10s','-o','json'],
  {capture:true,input,spawn:{maxBuffer:2*1024*1024,timeout:30000}});
 return {
  async readClusterUid(){return JSON.parse(execute(['get','namespace','kube-system'])).metadata?.uid;},
  async read(row){
   const raw=execute(['get',row.kind.toLowerCase(),row.metadata.name,'--ignore-not-found']);
   return raw?JSON.parse(raw):null;
  },
  async create(row){
   return JSON.parse(execute(['create','-f','-'],JSON.stringify(row)));
  },
  async admit(row){
   return JSON.parse(execute(['create','--dry-run=server','-f','-'],JSON.stringify(row)));
  },
  async preflightHandoff(){return observePsssCrossplaneHandoff(handoffClient);},
 };
}

export {PINNED_SHA};
