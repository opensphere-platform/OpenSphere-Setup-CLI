import {createHash} from 'node:crypto';
import {planPsssArgoRbac,applyPsssArgoRbac} from './psss-argocd-rbac-transition.mjs';
import {BOOTSTRAP_RESOURCES} from './psss-argocd-bootstrap-profile.mjs';

const profileSha256='202611c5cfd7e077dbab9f6ffda7b41695c045ccbf688c85e02154e7e685d2bb';
function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
const canonical=value=>JSON.stringify(order(value));
const digest=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const fault=(code,message,evidence)=>Object.assign(Error(message),{code,...(evidence?{evidence}:{})});
const identity=row=>`${row.kind}/${row.metadata.namespace}/${row.metadata.name}`;
function verifyProfile(){
  if(digest(BOOTSTRAP_RESOURCES)!=='sha256:'+profileSha256||BOOTSTRAP_RESOURCES.length!==3||
    canonical(BOOTSTRAP_RESOURCES.map(identity))!==canonical([
      'Role/argocd/opensphere-platform-support-core-plan-reader',
      'RoleBinding/argocd/opensphere-platform-support-core-plan-reader',
      'AppProject/argocd/default']))
    throw fault('UNTRUSTED_PROFILE','Pinned Argo Core bootstrap resources changed');
}
function classify(expected,actual){
  if(actual===null)return 'Missing';
  if(!actual||actual.apiVersion!==expected.apiVersion||actual.kind!==expected.kind||
    actual.metadata?.name!==expected.metadata.name||actual.metadata.namespace!==expected.metadata.namespace||
    !actual.metadata.uid||!actual.metadata.resourceVersion||actual.metadata.deletionTimestamp||
    Object.entries(expected.metadata.labels).some(([key,value])=>actual.metadata.labels?.[key]!==value))return 'Conflict';
  const property=expected.kind==='Role'?'rules':expected.kind==='RoleBinding'?'roleRef':'spec';
  if(canonical(actual[property])!==canonical(expected[property]))return 'Conflict';
  if(expected.kind==='RoleBinding'&&canonical(actual.subjects)!==canonical(expected.subjects))return 'Conflict';
  return 'Prepared';
}
async function snapshot(scope,{client,now}){
  verifyProfile();
  if(!client||typeof client.read!=='function')throw fault('INVALID_CLIENT','Kubernetes read client required');
  const authority=await planPsssArgoRbac(scope,{client,now});
  let records;
  try{records=await Promise.all(BOOTSTRAP_RESOURCES.map(async expected=>({expected,
    actual:await client.read({kind:expected.kind,name:expected.metadata.name,namespace:expected.metadata.namespace})})));}
  catch{throw fault('OBSERVATION_UNAVAILABLE','Argo Core bootstrap observation failed; absence was not inferred');}
  const bootstrap=records.map(({expected,actual})=>({kind:expected.kind,name:expected.metadata.name,
    namespace:expected.metadata.namespace,state:classify(expected,actual),uid:actual?.metadata?.uid||null,
    resourceVersion:actual?.metadata?.resourceVersion||null}));
  const state=authority.state==='Blocked'||bootstrap.some(row=>row.state==='Conflict')?'Blocked':
    authority.state==='Prepared'&&bootstrap.every(row=>row.state==='Prepared')?'Prepared':'NeedsPreparation';
  const planRevision=digest({authority:authority.planRevision,profileSha256,bootstrap});
  return {schema:'opensphere.psss-argocd-preparation/v1',owner:'platform-support',scope:authority.scope,
    observedAt:authority.observedAt,planRevision,profileSha256:'sha256:'+profileSha256,state,
    applicable:state==='NeedsPreparation',resources:[...authority.resources,...bootstrap],authority,records};
}
export async function planPsssArgoPreparation(scope,{client,now=()=>new Date()}={}){
  const {authority,records,...plan}=await snapshot(scope,{client,now});return plan;
}
export async function applyPsssArgoPreparation(scope,{client,planRevision,reviewedAt,now=()=>new Date(),onProgress=()=>{}}={}){
  const age=now().getTime()-Date.parse(reviewedAt);
  if(typeof reviewedAt!=='string'||!Number.isFinite(age)||age< -30000||age>300000)
    throw fault('REVIEW_EXPIRED','A plan observed within five minutes is required');
  if(!client||typeof client.admitCreate!=='function'||typeof client.create!=='function')
    throw fault('INVALID_CLIENT','Kubernetes create and admission client required');
  const initial=await snapshot(scope,{client,now:()=>new Date(reviewedAt)});
  if(initial.planRevision!==planRevision)throw fault('PLAN_CHANGED','Current preparation differs from the reviewed plan');
  if(initial.state==='Blocked')throw fault('PRECONDITION_FAILED','Missing or conflicting Argo preparation; no write performed');
  const pending=initial.records.filter(({expected,actual})=>classify(expected,actual)==='Missing');
  for(const {expected} of pending){
    let admitted;try{admitted=await client.admitCreate(expected);}catch{
      throw fault('ADMISSION_REJECTED','Argo bootstrap server dry-run rejected a fixed resource; no write performed');
    }
    if(classify(expected,{...admitted,metadata:{...admitted?.metadata,uid:admitted?.metadata?.uid||'dry-run',
      resourceVersion:admitted?.metadata?.resourceVersion||'dry-run'}})!=='Prepared')
      throw fault('ADMISSION_REJECTED','Argo bootstrap dry-run differed from the fixed resource; no write performed');
  }
  const changed=[];
  if(initial.authority.state!=='Prepared'){
    const result=await applyPsssArgoRbac(scope,{client,planRevision:initial.authority.planRevision,
      reviewedAt,onProgress,now});changed.push(...result.updated);
  }
  for(const {expected} of pending){
    let current;try{current=await client.read({kind:expected.kind,name:expected.metadata.name,
      namespace:expected.metadata.namespace});}catch{
      throw fault('OUTCOME_UNKNOWN','Bootstrap reinspection failed; no further object created',{changed});
    }
    if(current!==null)throw fault('PLAN_CHANGED','Argo bootstrap changed during review; no further object created',{changed});
    let created;try{created=await client.create(expected);}catch{
      throw fault('OUTCOME_UNKNOWN','Bootstrap creation outcome is unknown; inspect before retrying',{changed});
    }
    if(classify(expected,created)!=='Prepared')
      throw fault('OUTCOME_UNKNOWN','Created bootstrap object could not be verified',{changed});
    changed.push(identity(expected));
    try{onProgress({resource:identity(expected),state:'Prepared'});}catch{/* progress is not authority */}
  }
  const final=await snapshot(scope,{client,now});
  if(final.state!=='Prepared')throw fault('OUTCOME_UNKNOWN','Argo preparation did not verify; inspect before retrying',{changed});
  const {authority,records,...plan}=final;
  return {...plan,changed:changed.length>0,updated:changed};
}

export {BOOTSTRAP_RESOURCES};
