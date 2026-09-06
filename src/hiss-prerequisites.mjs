import { createHash } from 'node:crypto';
import { run } from './process.mjs';

// Local candidate implementation. Not imported by bootstrap/cli yet: applying
// this privileged profile still needs the separately requested authorization.
// No caller-supplied URL, chart, source path or arbitrary manifest is accepted.
export const HISS_EXECUTION_PROFILE = Object.freeze({
  id: 'hiss-chart-execution-v1',
  sourceRepository: 'opensphere-platform/OpenSphere-shell-clusterManager',
  sourceRevision: '43489ecf269d1630a1c912e68fd8da9f9fbff1b2',
  sourcePath: 'deploy/hiss-execution-profile.proposed.json',
  // Console delivery must use the release's Console revision, never the owner
  // revision above. This path is metadata only; no artifact is fetched here.
  consoleArtifactPath: 'packages/contracts/fixtures/hiss-execution/hiss-execution-profile.v1.proposed.json',
  sha256: '2695b1a044d62c91946a74f05dc105190afb00cece0e4750cbeb8baec5be1f6b',
});
const groups = {Namespace:['v1','namespaces'],ServiceAccount:['v1','serviceaccounts'],
  Role:['rbac.authorization.k8s.io/v1','roles'],RoleBinding:['rbac.authorization.k8s.io/v1','rolebindings'],
  ClusterRole:['rbac.authorization.k8s.io/v1','clusterroles'],ClusterRoleBinding:['rbac.authorization.k8s.io/v1','clusterrolebindings']};
const digest = value => createHash('sha256').update(value).digest('hex');
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v==='object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])) : v;
const canonical = v=>JSON.stringify(sorted(v));
const identity = r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
const projection = r=>({apiVersion:r.apiVersion,kind:r.kind,name:r.metadata?.name,namespace:r.metadata?.namespace,
  rules:r.rules,roleRef:r.roleRef,subjects:r.subjects,aggregationRule:r.aggregationRule,
  automountServiceAccountToken:r.kind==='ServiceAccount'?r.automountServiceAccountToken!==false:undefined,
  imagePullSecrets:r.imagePullSecrets||[],aggregateLabels:Object.fromEntries(Object.entries(r.metadata?.labels||{}).filter(([k])=>k.startsWith('rbac.authorization.k8s.io/aggregate-to-')))});
const fail = (code,message,evidence)=>Object.assign(new Error(message),{code,...(evidence?{evidence}:{})});
const reference = (kind,name,namespace)=>({apiVersion:groups[kind][0],kind,metadata:{name,...(namespace?{namespace}:{})}});

function observationIndex(returned, requested) {
  const allowed = new Set(requested.map(identity));
  if (!Array.isArray(returned)) throw fail('OBSERVATION_UNAVAILABLE', 'Invalid prerequisite observation');
  const byId = new Map();
  for (const resource of returned) {
    if (!resource || !groups[resource.kind] || resource.apiVersion !== groups[resource.kind][0]
      || typeof resource.metadata?.name !== 'string' || !resource.metadata.name
      || typeof resource.metadata.uid !== 'string' || !resource.metadata.uid) {
      throw fail('OBSERVATION_UNAVAILABLE', 'Incomplete prerequisite observation');
    }
    const id = identity(resource);
    if (!allowed.has(id) || byId.has(id)) throw fail('OBSERVATION_UNAVAILABLE', 'Unexpected or duplicate prerequisite observation');
    byId.set(id, resource);
  }
  return byId;
}

function loadProfile(raw,scope) {
  let url;try{url=new URL(scope.consoleUrl);}catch{throw fail('INVALID_SCOPE','Invalid Console URL');}
  if(scope.context!=='docker-desktop'||scope.channel!=='edge'||url.protocol!=='https:'||url.hostname!=='localhost'
    ||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw fail('INVALID_SCOPE','HISS candidate preparation is restricted to HTTPS localhost, edge and docker-desktop');
  if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024||digest(raw)!==HISS_EXECUTION_PROFILE.sha256)throw fail('UNTRUSTED_PROFILE','HISS prerequisite bytes differ from the captured contract');
  const profile=JSON.parse(raw);
  if(profile.schemaVersion!==1||profile.status!=='proposed-not-applied'||profile.resources.length!==54)throw fail('UNTRUSTED_PROFILE','HISS prerequisite envelope differs');
  return profile;
}
function references(resources) {
  const all=new Map(resources.map(r=>[identity(r),r]));
  const dependencies=new Map();
  const add=r=>{if(!all.has(identity(r)))dependencies.set(identity(r),r);};
  for(const r of resources){
    if(r.metadata.namespace)add(reference('Namespace',r.metadata.namespace));
    if(r.roleRef){
      add(reference(r.roleRef.kind,r.roleRef.name,r.roleRef.kind==='Role'?r.metadata.namespace:undefined));
      for(const s of r.subjects||[])if(s.kind==='ServiceAccount'){
        add(reference('ServiceAccount',s.name,s.namespace));add(reference('Namespace',s.namespace));
      }
    }
  }
  return [...dependencies.values()];
}
function matches(expected,actual) {
  if(typeof actual?.metadata?.uid!=='string'||!actual.metadata.uid||actual.metadata.deletionTimestamp||identity(expected)!==identity(actual))return false;
  return expected.kind==='Namespace'||!Object.keys(actual.metadata.annotations||{}).some(k=>k.startsWith('helm.sh/hook'))
    &&canonical(projection(actual))===canonical(projection(expected));
}
async function observe(profile,dependencies,client) {
  let returned;try{returned=await client.read([...profile.resources,...dependencies]);}catch{throw fail('OBSERVATION_UNAVAILABLE','Cannot verify HISS prerequisites; no absence was inferred');}
  const byId=observationIndex(returned,[...profile.resources,...dependencies]);
  const resources=profile.resources.map(expected=>{
    const actual=byId.get(identity(expected));
    return {identity:identity(expected),expected,actual,status:!actual?'Missing':matches(expected,actual)
      ?expected.kind==='Namespace'?'PreserveNamespace':'Matching':'Conflict'};
  });
  const dependencyFailures=dependencies.filter(r=>!byId.get(identity(r))?.metadata?.uid||byId.get(identity(r))?.metadata?.deletionTimestamp).map(identity);
  return {resources,byId,dependencyFailures};
}
function publicPlan(observation,scope) {
  return {profile:HISS_EXECUTION_PROFILE.id,profileSha256:HISS_EXECUTION_PROFILE.sha256,context:scope.context,
    status:observation.dependencyFailures.length||observation.resources.some(r=>r.status==='Conflict')?'Blocked'
      :observation.resources.some(r=>r.status==='Missing')?'NeedsPreparation':'Prepared',
    resources:observation.resources.map(r=>({identity:r.identity,status:r.status})),dependencyFailures:observation.dependencyFailures,
    installationComplete:false};
}

export async function prepareHissPrerequisites(raw,scope,{client,apply=false,onProgress=()=>{}}) {
  scope={...scope};
  const profile=loadProfile(raw,scope),dependencies=references(profile.resources);
  const initial=await observe(profile,dependencies,client),plan=publicPlan(initial,scope);
  if(!apply)return {...plan,applied:false,created:[],preserved:[]};
  if(plan.status==='Blocked')throw fail('PRECONDITION_FAILED','HISS prerequisite conflicts or missing dependencies must be resolved before preparation',plan);
  const created=[],preserved=[],observedAfterCreate=[];
  const observedUids=new Map(initial.resources.filter(r=>r.actual).map(r=>[r.identity,r.actual.metadata.uid]));
  // Definitions precede bindings. No new binding is created against an absent
  // or changed role, namespace or ServiceAccount.
  const rank={Namespace:0,ServiceAccount:1,Role:2,ClusterRole:2,RoleBinding:3,ClusterRoleBinding:3};
  const ordered=[...profile.resources].sort((a,b)=>rank[a.kind]-rank[b.kind]||identity(a).localeCompare(identity(b)));
  const expectedById=new Map(profile.resources.map(r=>[identity(r),r]));
  const dependencyOriginal=new Map(dependencies.map(r=>[identity(r),initial.byId.get(identity(r))]));
  const evidence=()=>({profile:HISS_EXECUTION_PROFILE.id,profileSha256:HISS_EXECUTION_PROFILE.sha256,context:scope.context,
    created:[...created],preserved:[...preserved],observedAfterCreate:[...observedAfterCreate],installationComplete:false});
  const report=event=>{try{onProgress(event);}catch{/* Logging cannot change authority or turn a confirmed write into an unknown outcome. */}};
  for(const resource of ordered){
    const id=identity(resource),needs=references([resource]);
    // Include internally prepared dependencies, which references([resource])
    // correctly treats as external to this single resource.
    let live;
    try{live=observationIndex(await client.read([resource,...needs]),[resource,...needs]);}
    catch{throw fail('PREPARATION_INCOMPLETE','Prerequisite recheck failed; existing resources were not rolled back',evidence());}
    for(const dependency of needs){
      const dependencyId=identity(dependency),actual=live.get(dependencyId),expected=expectedById.get(dependencyId);
      const before=dependencyOriginal.get(dependencyId);
      if(!actual?.metadata?.uid||actual.metadata.deletionTimestamp||expected&&!matches(expected,actual)
        ||observedUids.has(dependencyId)&&actual.metadata.uid!==observedUids.get(dependencyId)
        ||before&&(actual.metadata.uid!==before.metadata.uid||canonical(projection(actual))!==canonical(projection(before)))){
        throw fail('PREPARATION_INCOMPLETE','Referenced prerequisite changed; no further writes were made',evidence());
      }
    }
    const actual=live.get(id);
    if(actual){
      if(!matches(resource,actual)||observedUids.has(id)&&observedUids.get(id)!==actual.metadata.uid)throw fail('PREPARATION_INCOMPLETE','Prerequisite changed after review; no overwrite was attempted',evidence());
      observedUids.set(id,actual.metadata.uid);
      preserved.push(id);report({identity:id,state:'Preserved'});continue;
    }
    if(observedUids.has(id))throw fail('PREPARATION_INCOMPLETE','An existing prerequisite disappeared; no automatic replacement was attempted',evidence());
    let result;
    try{result=await client.create(structuredClone(resource));}catch{
      // Timeout/409 is ambiguous. Observe the exact identity once; never issue
      // a blind second create or delete resources as an automatic rollback.
      let after;try{after=observationIndex(await client.read([resource]),[resource]);}catch{throw fail('PREPARATION_INCOMPLETE','Create outcome is unknown; re-inspection is required',evidence());}
      const found=after.get(id);
      if(!matches(resource,found))throw fail('PREPARATION_INCOMPLETE','Create was not confirmed; re-inspection is required',evidence());
      observedUids.set(id,found.metadata.uid);observedAfterCreate.push(id);report({identity:id,state:'ObservedAfterUncertainCreate'});continue;
    }
    if(!matches(resource,result))throw fail('PREPARATION_INCOMPLETE','Created prerequisite does not match the captured contract',evidence());
    observedUids.set(id,result.metadata.uid);created.push(id);report({identity:id,state:'Created'});
  }
  let final;try{final=await observe(profile,dependencies,client);}catch{throw fail('PREPARATION_INCOMPLETE','Final prerequisite observation is unavailable; resources were preserved',evidence());}
  for(const [id,before]of dependencyOriginal){
    const actual=final.byId.get(id);
    if(!actual||actual.metadata.uid!==before.metadata.uid||canonical(projection(actual))!==canonical(projection(before)))throw fail('PREPARATION_INCOMPLETE','An external prerequisite changed; re-inspection is required',evidence());
  }
  for(const [id,uid]of observedUids)if(final.byId.get(id)?.metadata.uid!==uid)throw fail('PREPARATION_INCOMPLETE','A prerequisite was replaced during preparation; resources were preserved',evidence());
  const finalPlan=publicPlan(final,scope);
  if(finalPlan.status!=='Prepared')throw fail('PREPARATION_INCOMPLETE','Final prerequisite verification failed; resources were preserved',evidence());
  return {...finalPlan,applied:true,...evidence()};
}

// Explicit context is immutable for this adapter. It never follows a later
// kubectl current-context or OPENSPHERE_KUBE_CONTEXT environment change.
export function createHissPrerequisiteClient(scope,runner=run) {
  if(scope.context!=='docker-desktop')throw fail('INVALID_SCOPE','Unexpected Kubernetes context');
  const execute=(args,input)=>JSON.parse(runner('kubectl',['--context','docker-desktop',...args,'--request-timeout=10s','-o','json'],
    {capture:true,input:JSON.stringify(input),spawn:{maxBuffer:8*1024*1024,timeout:60000}})||'null');
  return {
    read:async resources=>{
      const result=execute(['get','--ignore-not-found','-f','-'],{apiVersion:'v1',kind:'List',items:resources});
      return result?result.kind==='List'?result.items:[result]:[];
    },
    create:async resource=>execute(['create','-f','-'],resource),
  };
}
