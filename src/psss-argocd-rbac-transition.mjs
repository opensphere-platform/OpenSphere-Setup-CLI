import {createHash} from 'node:crypto';
import {run} from './process.mjs';
import {PROFILE,PROFILE_SHA256} from './psss-argocd-rbac-profile.mjs';

const pinnedSha='b2ae3e74b70bd617f08cab5ef2a7e555bc0d586d0e9feefa4520e922488fa012';
const names=['argocd-application-controller','argocd-applicationset-controller','argocd-server'];
const canonical=value=>JSON.stringify(order(value));
function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
const digest=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const fail=(code,message,evidence)=>Object.assign(Error(message),{code,...(evidence?{evidence}:{})});
const key=row=>`${row.kind}/${row.namespace||''}/${row.name}`;
export function psssArgoPatchOperations(row,current){return [
  {op:'test',path:'/metadata/uid',value:current.metadata.uid},
  {op:'test',path:'/metadata/resourceVersion',value:current.metadata.resourceVersion},
  {op:'test',path:'/rules',value:row.previous},
  {op:'replace',path:'/rules',value:row.next},
];}

function verifyProfile(){
 if(PROFILE_SHA256!==pinnedSha||digest(PROFILE)!=='sha256:'+pinnedSha||
   PROFILE.schema!=='opensphere.psss-argocd-rbac-transition/v1'||PROFILE.owner!=='platform-support'||
   PROFILE.namespace!=='argocd'||PROFILE.resources?.length!==6||
   PROFILE.source?.policyId!=='opensphere.argocd-core-policy/v2'||
   PROFILE.source.policyRevision!=='c574778de687d8ee3406878e1f2794f579795ac4')
   throw fail('UNTRUSTED_PROFILE','Pinned PSSS Argo authority transition differs from the reviewed source');
 const expected=new Set(['Role','ClusterRole'].flatMap(kind=>names.map(name=>`${kind}/${kind==='Role'?'argocd':''}/${name}`)));
 if(PROFILE.resources.some(row=>!expected.delete(key(row))||!Array.isArray(row.previous)||!Array.isArray(row.next))||expected.size)
   throw fail('UNTRUSTED_PROFILE','Unexpected Argo authority identity');
 return PROFILE;
}
function validateScope(scope){
 if(!scope||typeof scope.context!=='string'||!scope.context||typeof scope.clusterUid!=='string'||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope.clusterUid)||
   scope.channel!=='edge')throw fail('INVALID_SCOPE','Explicit Kubernetes context, kube-system UID and edge channel are required');
 let url;try{url=new URL(scope.consoleUrl);}catch{throw fail('INVALID_SCOPE','HTTPS Console origin required');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
   !/^[a-z0-9.-]+$/i.test(url.hostname))throw fail('INVALID_SCOPE','HTTPS Console origin required');
 return {context:scope.context,clusterUid:scope.clusterUid.toLowerCase(),channel:'edge',consoleUrl:url.origin};
}
function classify(row,actual){
 if(actual===null)return 'Missing';
 if(!actual||actual.kind!==row.kind||actual.apiVersion!=='rbac.authorization.k8s.io/v1'||
   actual.metadata?.name!==row.name||(actual.metadata.namespace||null)!==row.namespace||
   !actual.metadata.uid||!actual.metadata.resourceVersion||actual.metadata.deletionTimestamp||
   actual.aggregationRule)return 'Conflict';
 const rules=canonical(actual.rules);
 return rules===canonical(row.next)?'Prepared':rules===canonical(row.previous)?'NeedsPreparation':'Conflict';
}
async function snapshot(client,scope,observedAt){
 verifyProfile();scope=validateScope(scope);
 let clusterUid,records;
 try{
  clusterUid=await client.readClusterUid();
  if(clusterUid!==scope.clusterUid)throw fail('WRONG_CLUSTER','kube-system UID does not match the reviewed RKE2 cluster');
  records=await Promise.all(PROFILE.resources.map(async row=>({row,actual:await client.read(row)})));
 }catch(error){if(error.code==='WRONG_CLUSTER')throw error;throw fail('OBSERVATION_UNAVAILABLE','Argo authority observation failed; absence was not inferred');}
 const resources=records.map(({row,actual})=>({kind:row.kind,name:row.name,namespace:row.namespace,
  state:classify(row,actual),uid:actual?.metadata?.uid||null,resourceVersion:actual?.metadata?.resourceVersion||null}));
 const state=resources.some(row=>['Conflict','Missing'].includes(row.state))?'Blocked':
   resources.every(row=>row.state==='Prepared')?'Prepared':'NeedsPreparation';
 const planRevision=digest({profileSha256:pinnedSha,scope,observedAt,resources});
 return {schema:'opensphere.psss-argocd-rbac-plan/v1',owner:'platform-support',scope,
  profileSha256:'sha256:'+pinnedSha,source:PROFILE.source,observedAt,planRevision,state,resources,
  applicable:state==='NeedsPreparation',changed:false,records};
}
export async function planPsssArgoRbac(scope,{client,now=()=>new Date()}={}){
 if(!client||typeof client.readClusterUid!=='function'||typeof client.read!=='function')throw Error('Read-only Kubernetes client required');
 const result=await snapshot(client,scope,now().toISOString());
 const {records,...publicPlan}=result;return publicPlan;
}
export async function applyPsssArgoRbac(scope,{client,planRevision,reviewedAt,now=()=>new Date(),onProgress=()=>{}}={}){
 if(!client||typeof client.patch!=='function'||typeof client.admit!=='function')throw Error('Kubernetes patch and admission client required');
 const age=now().getTime()-Date.parse(reviewedAt);
 if(typeof reviewedAt!=='string'||!Number.isFinite(age)||age< -30000||age>300000)
   throw fail('REVIEW_EXPIRED','A plan observed within five minutes is required');
 const initial=await snapshot(client,scope,reviewedAt);
 if(initial.planRevision!==planRevision)throw fail('PLAN_CHANGED','Current authority differs from the reviewed plan');
 if(initial.state==='Blocked')throw fail('PRECONDITION_FAILED','Missing or conflicting Argo authority; no write performed');
 const pending=initial.records.filter(record=>classify(record.row,record.actual)==='NeedsPreparation');
 for(const {row,actual} of pending){
  let admitted;try{admitted=await client.admit(row,actual);}catch{
   throw fail('ADMISSION_REJECTED','Argo authority dry-run was rejected; no write performed');
  }
  if(classify(row,admitted)!=='Prepared'||admitted.metadata.uid!==actual.metadata.uid)
   throw fail('ADMISSION_REJECTED','Argo authority dry-run differed from the fixed policy; no write performed');
 }
 const changed=[];
 for(const record of pending){
  let current;
  try{current=await client.read(record.row);}catch{throw fail('OUTCOME_UNKNOWN','Reinspection failed; no further role changed',{changed});}
  if(classify(record.row,current)!=='NeedsPreparation'||
    current.metadata.uid!==record.actual.metadata.uid||current.metadata.resourceVersion!==record.actual.metadata.resourceVersion)
    throw fail('PLAN_CHANGED','Argo authority changed during the transition; no further role changed',{changed});
  let result;
  try{result=await client.patch(record.row,current);}catch{
   throw fail('OUTCOME_UNKNOWN','Patch outcome is unknown; inspect the original six roles before resuming',{changed});
  }
  if(classify(record.row,result)!=='Prepared'||result.metadata.uid!==current.metadata.uid)
    throw fail('OUTCOME_UNKNOWN','Patched role could not be verified; inspect before resuming',{changed});
  changed.push(key(record.row));
  try{onProgress({resource:key(record.row),state:'Prepared'});}catch{/* progress is not authority */}
 }
 const final=await snapshot(client,scope,now().toISOString());
 if(final.state!=='Prepared'||final.records.some(({row,actual},i)=>
   !actual||actual.metadata.uid!==initial.records[i].actual.metadata.uid||classify(row,actual)!=='Prepared'))
   throw fail('OUTCOME_UNKNOWN','Final Argo authority verification failed; no automatic retry',{changed});
 const {records,...publicPlan}=final;
 return {...publicPlan,changed:changed.length>0,updated:changed};
}

export function createPsssArgoRbacClient({context,kubectl='kubectl',kubeconfig='',runner=run}={}){
 if(!context||typeof context!=='string'||!/^[A-Za-z0-9_.:@/-]+$/.test(context)||
   !kubectl||typeof kubectl!=='string'||(kubeconfig&&typeof kubeconfig!=='string'))
   throw fail('INVALID_SCOPE','Explicit kubectl context and executable required');
 const base=[...(kubeconfig?['--kubeconfig',kubeconfig]:[]),'--context',context];
 const execute=(args,input)=>runner(kubectl,[...base,...args,'--request-timeout=10s','-o','json'],
   {capture:true,...(input===undefined?{}:{input}),spawn:{maxBuffer:2*1024*1024,timeout:30000}});
 return {
  async readClusterUid(){const v=JSON.parse(execute(['get','namespace','kube-system']));return v?.metadata?.uid;},
  async read(row){const args=['get',row.kind.toLowerCase(),row.name];if(row.namespace)args.push('-n',row.namespace);
   const raw=execute([...args,'--ignore-not-found']);return raw?JSON.parse(raw):null;},
  async patch(row,current,{dryRun=false}={}){
   const operations=psssArgoPatchOperations(row,current);
   const args=['patch',row.kind.toLowerCase(),row.name];if(row.namespace)args.push('-n',row.namespace);
   return JSON.parse(execute([...args,'--type=json',...(dryRun?['--dry-run=server']:[]),'--patch',JSON.stringify(operations),
    '--field-manager=opensphere-setup-psss-argocd-v1']));
  },
  async admit(row,current){return this.patch(row,current,{dryRun:true});},
  async admitCreate(manifest){return JSON.parse(execute(['create','-f','-','--dry-run=server',
    '--field-manager=opensphere-setup-psss-argocd-v1'],JSON.stringify(manifest)));},
  async create(manifest){return JSON.parse(execute(['create','-f','-',
    '--field-manager=opensphere-setup-psss-argocd-v1'],JSON.stringify(manifest)));},
 };
}

export {PROFILE_SHA256};
