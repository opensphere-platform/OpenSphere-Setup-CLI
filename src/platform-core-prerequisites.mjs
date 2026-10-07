import {createHash} from 'node:crypto';
import {installTarget,profileChannel} from './install-target.mjs';
import {createHissPrerequisiteClient} from './hiss-prerequisites.mjs';
import {run} from './process.mjs';
import {PROFILE as PSSS_ARGO_AUTHORITY} from './psss-argocd-rbac-profile.mjs';
// Explicitly approved 2026-09-07. Setup prepares fixed authority only;
// actual Core workload installation remains 22 -> OS Shell -> existing owner.
// The bytes stay pinned; since 2026-09-23 the target cluster is not (install-target.mjs).
// 2026-09-29: the reviewed Console profile adds PSSS read-only observation of the Crossplane writer fence
// (Codex 0368b2c); its exact bytes ship with this Setup build. The target stays chosen at run time.
export const PLATFORM_CORE_ARTIFACT='deploy/installation-profiles/platform-core.json';
export const PLATFORM_CORE_SHA256='10cb06f04f64c5cf3a5294650f79ff5214b8fa7ee4f2265514373666cc92caf3';
// An upgrade also prepares the previous release for rollback, and that release carries its own reviewed
// profile. Every reviewed profile is named here; any other bytes are refused.
export const PLATFORM_CORE_APPROVED_SHA256=Object.freeze({
 '10cb06f04f64c5cf3a5294650f79ff5214b8fa7ee4f2265514373666cc92caf3':'2026-09-29 PSSS Crossplane writer fence reads (Console 7aa06cba)',
 '91f1797854df91116ea8f9f77f8c406d741291f1472ea8e8a0d65087554ce099':'2026-09-07 approved original (Console d13a6885 and earlier)',
});
const canonical=v=>JSON.stringify(order(v));
function order(v){return Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;}
const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const id=r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
const fail=(code,message,evidence)=>Object.assign(Error(message),{code,...(evidence?{evidence}:{})});
export function verifyPlatformCoreProfile(raw,scope){
 installTarget(scope);
 if(typeof raw!=='string'||Buffer.byteLength(raw)>4*1024*1024||!Object.hasOwn(PLATFORM_CORE_APPROVED_SHA256,createHash('sha256').update(raw).digest('hex')))throw fail('UNTRUSTED_PROFILE','Core preparation bytes differ from the explicitly approved artifact');
 const p=JSON.parse(raw);if(p.schema!=='opensphere.platform-core-preparation/v1'||profileChannel(p.scope)!=='edge'||p.resources.length!==53)throw fail('UNTRUSTED_PROFILE','Unexpected Core envelope');return p;
}
// Core preparation is create-only: an existing object must equal the profile. Two reviewed steps legitimately
// move a Core identity past the profile an installation was first prepared with (localhost upgrade 2026-09-29):
//  - `prepare-psss-argocd` narrows the six Argo roles to PSSS policy v2 (the pinned transition's `next` rules).
//    Core preparation accepts exactly those rules and never widens them back.
//  - Console 7aa06cba adds one read of the fixed Crossplane writer fence to the PSSS Core reader. A reader
//    prepared earlier lacks that rule; Core preparation replaces exactly that previous rule set under a
//    uid/resourceVersion/rules test. An older profile (rollback) accepts the newer superset unchanged.
//  - `transfer-psss-crossplane-writer` moves the executor and recorder bindings from CM to PSSS: same roleRef,
//    the single subject becomes the PSSS runtime account. Core preparation keeps them and never moves them back
//    (localhost 2026-09-29: the first Console upgrade after the transfer stopped here).
// Anything else stays a conflict.
const PSSS_ARGO_AUTHORITY_SHA256='b2ae3e74b70bd617f08cab5ef2a7e555bc0d586d0e9feefa4520e922488fa012';
const READER_ID='rbac.authorization.k8s.io/v1/ClusterRole//opensphere-platform-support-core-reader';
const FENCE_READ={apiGroups:['admissionregistration.k8s.io'],resources:['validatingadmissionpolicies','validatingadmissionpolicybindings'],
 verbs:['get'],resourceNames:['opensphere-psss-crossplane-writer-fence']};
const TRANSFERRED_BINDINGS=['rbac.authorization.k8s.io/v1/RoleBinding/crossplane-system/opensphere-platform-support-crossplane-executor',
 'rbac.authorization.k8s.io/v1/RoleBinding/opensphere-console/opensphere-platform-support-core-recorder'];
const CM_SUBJECT={kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',namespace:'opensphere-console'};
const PSSS_SUBJECT={kind:'ServiceAccount',name:'opensphere-platform-support-runtime',namespace:'opensphere-console'};
const READER_RULES_SHA256={withoutFence:'ca4cb150bac3556674ac438b19bcd4aead8253f8f901a2b6aa4018bfc95a03e3',
 withFence:'3a2d5fe91b31812aeea50fa1994bfb968d163fec5a813b9bc18b5b128cb8817c'};
function reviewedStates(resources){
 if(sha(PSSS_ARGO_AUTHORITY)!==PSSS_ARGO_AUTHORITY_SHA256)throw fail('UNTRUSTED_PROFILE','Pinned PSSS Argo authority transition differs from the reviewed source');
 const states=new Map(),byId=new Map(resources.map(r=>[id(r),r]));
 for(const row of PSSS_ARGO_AUTHORITY.resources){
  const key=`rbac.authorization.k8s.io/v1/${row.kind}/${row.namespace||''}/${row.name}`;
  if(canonical(byId.get(key)?.rules)===canonical(row.previous))states.set(key,{successor:{rules:row.next}});
 }
 for(const key of TRANSFERRED_BINDINGS)
  if(canonical(byId.get(key)?.subjects)===canonical([CM_SUBJECT]))states.set(key,{successor:{subjects:[PSSS_SUBJECT]}});
 const reader=byId.get(READER_ID);
 if(reader){
  const withoutFence=reader.rules.filter(rule=>canonical(rule)!==canonical(FENCE_READ));
  const withFence=[...withoutFence.slice(0,3),FENCE_READ,...withoutFence.slice(3)];
  if(sha(withoutFence)!==READER_RULES_SHA256.withoutFence||sha(withFence)!==READER_RULES_SHA256.withFence)
   throw fail('UNTRUSTED_PROFILE','Unexpected PSSS Core reader definition');
  states.set(READER_ID,withoutFence.length===reader.rules.length?{successor:{rules:withFence}}:{update:withoutFence});
 }
 return states;
}
const ref=(kind,name,namespace)=>({apiVersion:['Namespace','ServiceAccount'].includes(kind)?'v1':'rbac.authorization.k8s.io/v1',kind,metadata:{name,...(namespace?{namespace}:{})}});
function references(items){const all=new Set(items.map(id)),refs=new Map();const add=r=>{if(!all.has(id(r)))refs.set(id(r),r);};for(const r of items){
 if(r.metadata.namespace)add(ref('Namespace',r.metadata.namespace));
 if(r.roleRef){add(ref(r.roleRef.kind,r.roleRef.name,r.roleRef.kind==='Role'?r.metadata.namespace:undefined));for(const s of r.subjects||[])if(s.kind==='ServiceAccount'){add(ref('ServiceAccount',s.name,s.namespace));add(ref('Namespace',s.namespace));}}
 }return [...refs.values()];}
function fingerprint(r){return canonical({rules:r.aggregationRule?undefined:r.rules,aggregationRule:r.aggregationRule,roleRef:r.roleRef,subjects:r.subjects,
 spec:r.kind==='CustomResourceDefinition'?{conversion:{strategy:'None'},...r.spec}:undefined,
 automount:r.kind==='ServiceAccount'?r.automountServiceAccountToken!==false:undefined,imagePullSecrets:r.imagePullSecrets||[],
 aggregateLabels:Object.fromEntries(Object.entries(r.metadata.labels||{}).filter(([k])=>k.startsWith('rbac.authorization.k8s.io/aggregate-to-')))});}
function matches(e,a){return !!a?.metadata?.uid&&!a.metadata.deletionTimestamp&&id(e)===id(a)&&!Object.keys(a.metadata.annotations||{}).some(k=>k.startsWith('helm.sh/hook'))&&fingerprint(e)===fingerprint(a);}
// Exact, ReviewedSuccessor (kept as is) or ReviewedUpdate (replaced with the profile rules); null is a conflict.
function assess(e,a,states){
 if(matches(e,a))return 'Exact';
 const s=states.get(id(e));
 if(s?.successor&&matches({...e,...s.successor},a))return 'ReviewedSuccessor';
 if(s?.update&&matches({...e,rules:s.update},a))return 'ReviewedUpdate';
 return null;
}
function index(rows,requested){const allowed=new Set(requested.map(id)),map=new Map();if(!Array.isArray(rows))throw Error('Invalid observation');for(const r of rows){
 if(!r?.metadata?.uid||!allowed.has(id(r))||map.has(id(r)))throw Error('Incomplete or unexpected observation');map.set(id(r),r);
 }return map;}
export function coreRulesPatch(current,previous,next){return [
 {op:'test',path:'/metadata/uid',value:current.metadata.uid},
 {op:'test',path:'/metadata/resourceVersion',value:current.metadata.resourceVersion},
 {op:'test',path:'/rules',value:previous},
 {op:'replace',path:'/rules',value:next},
];}
// The HISS adapter stays get/create only. Core preparation adds one guarded rules replacement for the
// reviewed reader update above; the server rejects it unless uid, resourceVersion and rules still match.
export function createPlatformCoreClient(scope,runner=run){
 const {context}=installTarget(scope),base=createHissPrerequisiteClient(scope,runner);
 const execute=args=>JSON.parse(runner('kubectl',['--context',context,...args,'--request-timeout=10s','-o','json'],
  {capture:true,spawn:{maxBuffer:8*1024*1024,timeout:60000}})||'null');
 const clusterIdentity=()=>execute(['get','namespace','kube-system'])?.metadata?.uid;
 const clusterUid=clusterIdentity();
 if(!clusterUid)throw fail('OBSERVATION_UNAVAILABLE','Cluster UID could not be verified');
 return {read:base.read,create:base.create,
  patchRules:async(resource,operations)=>{
   // Codex review 2026-09-29: the adapter itself admits only the two reviewed rule sets, in that direction,
   // bound to the object's own uid and resourceVersion; it does not rely on the caller having checked them.
   if(id(resource)!==READER_ID||!Array.isArray(operations)||operations.length!==4||
     canonical(operations.map(op=>[op.op,op.path]))!==canonical([['test','/metadata/uid'],['test','/metadata/resourceVersion'],['test','/rules'],['replace','/rules']])||
     typeof resource.metadata.uid!=='string'||!resource.metadata.uid||typeof resource.metadata.resourceVersion!=='string'||!resource.metadata.resourceVersion||
     operations[0].value!==resource.metadata.uid||operations[1].value!==resource.metadata.resourceVersion||
     sha(operations[2].value)!==READER_RULES_SHA256.withoutFence||sha(operations[3].value)!==READER_RULES_SHA256.withFence)
    throw fail('PRECONDITION_FAILED','Only the reviewed Core reader rules replacement is allowed');
   if(clusterIdentity()!==clusterUid)throw fail('PRECONDITION_FAILED','Kubernetes context now points at a different cluster');
   return execute(['patch','clusterrole.rbac.authorization.k8s.io',resource.metadata.name,'--type=json',
    '--patch',JSON.stringify(operations),'--field-manager=opensphere-setup-platform-core-v1']);
  }};
}
export async function preparePlatformCorePrerequisites(raw,scope,{client,apply=false,onProgress=()=>{}}){
 const profile=verifyPlatformCoreProfile(raw,scope),resources=profile.resources,deps=references(resources),all=[...resources,...deps];
 const states=reviewedStates(resources),expected=new Map(resources.map(r=>[id(r),r]));
 async function observe(items){try{return index(await client.read(items),items);}catch{throw fail('OBSERVATION_UNAVAILABLE','Core observation failed; absence was not inferred');}}
 const initial=await observe(all),initialState=new Map(resources.filter(r=>initial.has(id(r))).map(r=>[id(r),assess(r,initial.get(id(r)),states)]));
 const conflicts=[...initialState].filter(([,s])=>!s).map(([k])=>k),missingDependencies=deps.filter(r=>!initial.get(id(r))?.metadata?.uid||initial.get(id(r)).metadata.deletionTimestamp).map(id);
 const reviewedSuccessors=[...initialState].filter(([,s])=>s==='ReviewedSuccessor').map(([k])=>k),reviewedUpdates=[...initialState].filter(([,s])=>s==='ReviewedUpdate').map(([k])=>k);
 const created=[],preserved=[],updated=[],uids=new Map([...initial].map(([k,r])=>[k,r.metadata.uid]));
 const evidence=()=>({profileSha256:createHash('sha256').update(raw).digest('hex'),created:[...created],preserved:[...preserved],updated:[...updated],
  reviewedSuccessors:[...reviewedSuccessors],installationComplete:false});
 const blocked=conflicts.length||missingDependencies.length;
 if(!apply)return {...evidence(),status:blocked?'Blocked':resources.every(r=>initial.has(id(r)))&&!reviewedUpdates.length?'Prepared':'NeedsPreparation',
  conflicts,missingDependencies,reviewedUpdates,applied:false};
 if(blocked)throw fail('PRECONDITION_FAILED','Core authority conflict or missing dependency; no write performed',{conflicts,missingDependencies});
 if(reviewedUpdates.length&&typeof client.patchRules!=='function')throw fail('PRECONDITION_FAILED','Reviewed Core update requires a guarded patch client; no write performed',{reviewedUpdates});
 const accepted=(e,a)=>['Exact','ReviewedSuccessor'].includes(assess(e,a,states));
 const rank={CustomResourceDefinition:0,ServiceAccount:1,Role:2,ClusterRole:2,RoleBinding:3,ClusterRoleBinding:3};
 for(const r of [...resources].sort((a,b)=>rank[a.kind]-rank[b.kind]||id(a).localeCompare(id(b)))){
  const needed=references([r]),live=await observe([r,...needed]);
  for(const dep of needed){const key=id(dep),a=live.get(key),e=expected.get(key)||initial.get(key);
   if(!a?.metadata?.uid||a.metadata.deletionTimestamp||(e&&!accepted(e,a))||(uids.has(key)&&uids.get(key)!==a.metadata.uid))throw fail('PREPARATION_INCOMPLETE','Core dependency changed; no further write performed',evidence());}
  const a=live.get(id(r));let state='Created';
  if(a){const found=assess(r,a,states);
   if(!found||(uids.has(id(r))&&uids.get(id(r))!==a.metadata.uid))throw fail('PREPARATION_INCOMPLETE','Existing Core definition changed; no overwrite attempted',evidence());
   if(found==='ReviewedUpdate'){
    let made;try{made=await client.patchRules(a,coreRulesPatch(a,states.get(id(r)).update,r.rules));}catch{throw fail('PREPARATION_INCOMPLETE','Core update outcome requires reinspection; no retry or rollback performed',evidence());}
    if(!matches(r,made)||made.metadata.uid!==a.metadata.uid)throw fail('PREPARATION_INCOMPLETE','Updated Core object differs from approved definition',evidence());
    updated.push(id(r));state='Updated';
   }else{preserved.push(id(r));state='Preserved';}
   uids.set(id(r),a.metadata.uid);}
  else{
   if(uids.has(id(r)))throw fail('PREPARATION_INCOMPLETE','Existing Core resource disappeared; no automatic replacement',evidence());
   let made;try{made=await client.create(structuredClone(r));}catch{throw fail('PREPARATION_INCOMPLETE','Core create outcome requires reinspection; no retry or rollback performed',evidence());}
   if(!matches(r,made))throw fail('PREPARATION_INCOMPLETE','Created Core object differs from approved definition',evidence());created.push(id(r));uids.set(id(r),made.metadata.uid);
  }
  try{onProgress({identity:id(r),state});}catch{/* progress must not alter the write result */}
 }
 const final=await observe(all);
 for(const r of resources)if(!accepted(r,final.get(id(r)))||final.get(id(r)).metadata.uid!==uids.get(id(r)))throw fail('PREPARATION_INCOMPLETE','Final Core verification failed',evidence());
 for(const r of deps){const key=id(r);if(!matches(initial.get(key),final.get(key))||final.get(key).metadata.uid!==uids.get(key))throw fail('PREPARATION_INCOMPLETE','External Core dependency changed',evidence());}
 return {...evidence(),status:'Prepared',applied:true};
}
