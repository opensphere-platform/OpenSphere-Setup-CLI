import {createHash} from 'node:crypto';
// Explicitly approved 2026-09-07. Setup prepares fixed authority only;
// actual Core workload installation remains 22 -> OS Shell -> existing owner.
export const PLATFORM_CORE_ARTIFACT='deploy/installation-profiles/platform-core.json';
export const PLATFORM_CORE_SHA256='91f1797854df91116ea8f9f77f8c406d741291f1472ea8e8a0d65087554ce099';
const scopeContract={context:'docker-desktop',channel:'edge',consoleUrl:'https://localhost:1114'};
const canonical=v=>JSON.stringify(order(v));
function order(v){return Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;}
const id=r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
const fail=(code,message,evidence)=>Object.assign(Error(message),{code,...(evidence?{evidence}:{})});
export function verifyPlatformCoreProfile(raw,scope){
 if(canonical(scope)!==canonical(scopeContract))throw fail('INVALID_SCOPE','Core preparation requires exactly docker-desktop / HTTPS localhost:1114 / edge');
 if(typeof raw!=='string'||Buffer.byteLength(raw)>4*1024*1024||createHash('sha256').update(raw).digest('hex')!==PLATFORM_CORE_SHA256)throw fail('UNTRUSTED_PROFILE','Core preparation bytes differ from the explicitly approved artifact');
 const p=JSON.parse(raw);if(p.schema!=='opensphere.platform-core-preparation/v1'||canonical(p.scope)!==canonical(scopeContract)||p.resources.length!==53)throw fail('UNTRUSTED_PROFILE','Unexpected Core envelope');return p;
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
function index(rows,requested){const allowed=new Set(requested.map(id)),map=new Map();if(!Array.isArray(rows))throw Error('Invalid observation');for(const r of rows){
 if(!r?.metadata?.uid||!allowed.has(id(r))||map.has(id(r)))throw Error('Incomplete or unexpected observation');map.set(id(r),r);
 }return map;}
export async function preparePlatformCorePrerequisites(raw,scope,{client,apply=false,onProgress=()=>{}}){
 const profile=verifyPlatformCoreProfile(raw,scope),resources=profile.resources,deps=references(resources),all=[...resources,...deps];
 const expected=new Map(resources.map(r=>[id(r),r]));
 async function observe(items){try{return index(await client.read(items),items);}catch{throw fail('OBSERVATION_UNAVAILABLE','Core observation failed; absence was not inferred');}}
 const initial=await observe(all),conflicts=resources.filter(r=>initial.has(id(r))&&!matches(r,initial.get(id(r)))).map(id),missingDependencies=deps.filter(r=>!initial.get(id(r))?.metadata?.uid||initial.get(id(r)).metadata.deletionTimestamp).map(id);
 const created=[],preserved=[],uids=new Map([...initial].map(([k,r])=>[k,r.metadata.uid]));
 const evidence=()=>({profileSha256:PLATFORM_CORE_SHA256,created:[...created],preserved:[...preserved],installationComplete:false});
 const blocked=conflicts.length||missingDependencies.length;
 if(!apply)return {...evidence(),status:blocked?'Blocked':resources.every(r=>initial.has(id(r)))?'Prepared':'NeedsPreparation',conflicts,missingDependencies,applied:false};
 if(blocked)throw fail('PRECONDITION_FAILED','Core authority conflict or missing dependency; no write performed',{conflicts,missingDependencies});
 const rank={CustomResourceDefinition:0,ServiceAccount:1,Role:2,ClusterRole:2,RoleBinding:3,ClusterRoleBinding:3};
 for(const r of [...resources].sort((a,b)=>rank[a.kind]-rank[b.kind]||id(a).localeCompare(id(b)))){
  const needed=references([r]),live=await observe([r,...needed]);
  for(const dep of needed){const key=id(dep),a=live.get(key),e=expected.get(key)||initial.get(key);
   if(!a?.metadata?.uid||a.metadata.deletionTimestamp||(e&&!matches(e,a))||(uids.has(key)&&uids.get(key)!==a.metadata.uid))throw fail('PREPARATION_INCOMPLETE','Core dependency changed; no further write performed',evidence());}
  const a=live.get(id(r));if(a){if(!matches(r,a)||(uids.has(id(r))&&uids.get(id(r))!==a.metadata.uid))throw fail('PREPARATION_INCOMPLETE','Existing Core definition changed; no overwrite attempted',evidence());preserved.push(id(r));uids.set(id(r),a.metadata.uid);}
  else{
   if(uids.has(id(r)))throw fail('PREPARATION_INCOMPLETE','Existing Core resource disappeared; no automatic replacement',evidence());
   let made;try{made=await client.create(structuredClone(r));}catch{throw fail('PREPARATION_INCOMPLETE','Core create outcome requires reinspection; no retry or rollback performed',evidence());}
   if(!matches(r,made))throw fail('PREPARATION_INCOMPLETE','Created Core object differs from approved definition',evidence());created.push(id(r));uids.set(id(r),made.metadata.uid);
  }
  try{onProgress({identity:id(r),state:a?'Preserved':'Created'});}catch{/* progress must not alter the write result */}
 }
 const final=await observe(all);
 for(const r of resources)if(!matches(r,final.get(id(r)))||final.get(id(r)).metadata.uid!==uids.get(id(r)))throw fail('PREPARATION_INCOMPLETE','Final Core verification failed',evidence());
 for(const r of deps){const key=id(r);if(!matches(initial.get(key),final.get(key))||final.get(key).metadata.uid!==uids.get(key))throw fail('PREPARATION_INCOMPLETE','External Core dependency changed',evidence());}
 return {...evidence(),status:'Prepared',applied:true};
}
