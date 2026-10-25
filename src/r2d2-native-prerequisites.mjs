// CON-FR-018/019: Setup prepares the explicitly reviewed personal-runtime
// boundary. It never chooses storage, quotas, credentials or a replacement agent.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {kubectl as defaultKubectl,run} from './process.mjs';
import {readClusterUid,INSTALLATION_IDENTITY_CONFIGMAP} from './installation-identity.mjs';
import {REGISTRY_PULL_SECRET,secretHasGhcrCredential} from './registry-pull-secret.mjs';

export const NATIVE_RUNTIME_RENDERER='apps/osaa-gateway/openclaw-runtime-resources.cjs';
// Fixed transitive source closure of the release-selected renderer. Both files
// are downloaded from the same immutable C_AI Console revision; never resolved
// from a sibling checkout or an installer host's ambient module search path.
export const NATIVE_RUNTIME_SOURCE_PATHS=Object.freeze([
 NATIVE_RUNTIME_RENDERER,
 'apps/osaa-gateway/openclaw-native-config.cjs',
]);
export const NATIVE_RUNTIME_POLICY='opensphere-r2d2-runtime-policy';
export const NATIVE_JOURNAL='console.r2d2.native_request_journal';
export const NATIVE_ACTION_INTENT='console.r2d2.native_action_intent';
export const NATIVE_SESSION_FENCE='console.r2d2.native_session_dispatch_fence';
const SCHEMA='opensphere.r2d2-runtime-preparation/v1';
const OWNER='opensphere-setup';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const exact=(x,keys,label)=>{if(!plain(x)||Object.keys(x).sort().join(',')!==[...keys].sort().join(','))fail('NativeRuntimePolicyInvalid',label+' has unexpected or missing fields');};
export function needsNativeRuntimePreparation(lock,changed){return !!lock.components?.r2d2OpenClawGateway&&(!changed||changed.some(x=>['osaaGateway','r2d2OpenClawGateway'].includes(x)));}
export function isLegacyNativeCutover(previous,target){return !previous.components?.r2d2OpenClawGateway&&!!target.components?.r2d2OpenClawGateway;}

export function validateNativeRuntimeInput(input,lock,{clusterUid,identity,installedReleaseDigest=null}={}){
 exact(input,['schema','clusterUid','installationId','installedReleaseDigest','policy','capacity'],'Runtime preparation');
 if(input.schema!==SCHEMA||!UUID.test(input.installationId)||!UUID.test(input.clusterUid))fail('NativeRuntimePolicyInvalid','Runtime preparation identity is invalid');
 if(input.clusterUid!==clusterUid)fail('NativeRuntimeClusterMismatch','Reviewed runtime preparation belongs to another cluster');
 if(input.installedReleaseDigest!==installedReleaseDigest||(input.installedReleaseDigest!==null&&!/^sha256:[a-f0-9]{64}$/.test(input.installedReleaseDigest)))fail('NativeRuntimeInstalledReleaseMismatch','Reviewed runtime preparation must bind the exact installed release digest (null for fresh installation)');
 if(identity&&(identity.immutable!==true||identity.data?.clusterUid!==clusterUid||identity.data?.installationId!==input.installationId))fail('NativeRuntimeIdentityMismatch','Runtime preparation differs from the persistent installation identity');
 const policy=input.policy;
 if(!plain(policy)||policy.installationId!==input.installationId)fail('NativeRuntimeIdentityMismatch','Policy installation identity differs');
 const required=['installationId','image','bridgeImage','storage','resources','bridgeResources'];
 const allowed=[...required,'namespace','imagePullSecretName'];
 if(required.some(k=>!Object.hasOwn(policy,k))||Object.keys(policy).some(k=>!allowed.includes(k)))fail('NativeRuntimePolicyInvalid','Runtime policy has unexpected or missing fields');
 if(policy.imagePullSecretName!==REGISTRY_PULL_SECRET)fail('NativeRuntimePolicyInvalid','Explicit opensphere-ghcr-pull reference is required for the managed native registry lifecycle; it is not defaulted');
 exact(policy.storage,['className','accessMode','sizeGi'],'Runtime storage');
 exact(policy.resources,['cpuRequestMilli','cpuLimitMilli','memoryRequestMi','memoryLimitMi','temporaryMi'],'Runtime resources');
 exact(policy.bridgeResources,['cpuRequestMilli','cpuLimitMilli','memoryRequestMi','memoryLimitMi'],'Bridge resources');
 exact(input.capacity,['maxRuntimes','totalStorageGi','cpuLimitMilli','memoryLimitMi'],'Runtime capacity');
 if(policy.image!==lock.components.r2d2OpenClawGateway.image||policy.bridgeImage!==lock.components.osaaGateway.image)fail('NativeRuntimeImageMismatch','Reviewed runtime policy must name the exact native and C_AI release images');
 // The versioned renderer supplies the remaining resource/value validation.
 return structuredClone(input);
}

function readObject(kubectl,object){const text=kubectl(['-n',object.metadata.namespace??'default','get',object.kind,object.metadata.name,'--ignore-not-found','-o','json'],{capture:true});return text?JSON.parse(text):null;}
function binding(object){return object?{uid:object.metadata?.uid,resourceVersion:object.metadata?.resourceVersion,contentSha256:hash(object)}:null;}
function sameBinding(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function assertOwned(object){if(object&&object.metadata?.labels?.['app.kubernetes.io/managed-by']!==OWNER)fail('NativeRuntimeForeignObject','An existing runtime prerequisite is not owned by Setup: '+object.kind+'/'+object.metadata?.name);}

export function prepareNativeRuntimePrerequisites(lock,{inputPath,input,rendererPath,manifest,kubectl=defaultKubectl,render}={}){
 if(!needsNativeRuntimePreparation(lock))return null;
 if(!input&&!inputPath)fail('NativeRuntimePolicyRequired','Native runtime preparation requires --r2d2-runtime-policy with explicitly reviewed storage, resources and capacity; no defaults are created');
 if(inputPath){const bytes=readFileSync(inputPath);if(bytes.length>32768)fail('NativeRuntimePolicyInvalid','Runtime policy input is too large');input=JSON.parse(bytes.toString('utf8'));}
 if(manifest?.migrations?.filter(x=>x.semanticKey===NATIVE_JOURNAL).length!==1)fail('NativeRuntimeMigrationRequired','Native request journal must be registered exactly once in the verified release migration manifest');
 if(manifest?.migrations?.filter(x=>x.semanticKey===NATIVE_ACTION_INTENT).length!==1)fail('NativeRuntimeMigrationRequired','Native action intent must be registered exactly once in the verified release migration manifest');
 if(manifest?.migrations?.filter(x=>x.semanticKey===NATIVE_SESSION_FENCE).length!==1)fail('NativeRuntimeMigrationRequired','Native session dispatch fence must be registered exactly once in the verified release migration manifest');
 const clusterUid=readClusterUid({kubectl});
 const identityText=kubectl(['-n','opensphere-console','get','configmap',INSTALLATION_IDENTITY_CONFIGMAP,'--ignore-not-found','-o','json'],{capture:true});
 const recordText=kubectl(['-n','opensphere-console','get','configmap','opensphere-installation-lock','--ignore-not-found','-o','json'],{capture:true});
 const installedRecord=recordText?JSON.parse(recordText):null;
 const installedReleaseDigest=installedRecord?JSON.parse(installedRecord.data?.['release.json']??'null')?.releaseDigest:null;
 const reviewed=validateNativeRuntimeInput(input,lock,{clusterUid,identity:identityText?JSON.parse(identityText):null,installedReleaseDigest});
 const request={policy:reviewed.policy,capacity:reviewed.capacity};
 const objects=render?render(request):JSON.parse(run('node',['-e',"const fs=require('node:fs');let t='';process.stdin.on('data',b=>t+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(require(process.argv[1]).renderPersonalRuntimePrerequisites(JSON.parse(t)))));",rendererPath],{capture:true,input:JSON.stringify(request)}));
 if(!Array.isArray(objects)||objects.length!==8)fail('NativeRuntimeRendererInvalid','Pinned runtime renderer returned an unexpected prerequisite inventory');
 const expected=['Namespace/opensphere-r2d2','ServiceAccount/r2d2-personal-runtime','Role/r2d2-personal-runtime-provisioner','RoleBinding/r2d2-personal-runtime-provisioner','NetworkPolicy/r2d2-default-deny','NetworkPolicy/r2d2-personal-runtime','NetworkPolicy/r2d2-personal-runtime-to-gateway','ResourceQuota/r2d2-personal-runtime-capacity'];
 for(const [i,object]of objects.entries()){
  if(object.kind+'/'+object.metadata?.name!==expected[i]||(object.kind!=='Namespace'&&object.metadata.namespace!==(i===6?'opensphere-console':'opensphere-r2d2')))fail('NativeRuntimeRendererInvalid','Pinned runtime prerequisite scope differs');
  object.metadata.labels={...object.metadata.labels,'app.kubernetes.io/managed-by':OWNER,'opensphere.io/r2d2-prerequisite':'true'};
 }
 objects.push({apiVersion:'v1',kind:'ConfigMap',metadata:{name:NATIVE_RUNTIME_POLICY,namespace:'opensphere-console',labels:{'app.kubernetes.io/managed-by':OWNER,'opensphere.io/r2d2-prerequisite':'true'}},data:{installationId:reviewed.installationId,'policy.json':JSON.stringify(reviewed.policy),'preparation.json':JSON.stringify(reviewed)}});
 const entries=objects.map(object=>{const live=readObject(kubectl,object);assertOwned(live);return {object,before:binding(live)};});
 const plan={schema:SCHEMA,clusterUid,installationId:reviewed.installationId,installedReleaseDigest,installedRecordUid:installedRecord?.metadata?.uid??null,installedRecordResourceVersion:installedRecord?.metadata?.resourceVersion??null,identityBinding:identityText?binding(JSON.parse(identityText)):null,releaseDigest:lock.releaseDigest,requiresRegistryCredential:[lock.components.osaaGateway,lock.components.r2d2OpenClawGateway].some(c=>c.registryCredentialsRequired===true),inputSha256:hash(reviewed),entries};
 return {...plan,planDigest:hash(plan)};
}

export function applyNativeRuntimePrerequisites(plan,{kubectl=defaultKubectl}={}){
 if(!plan||plan.schema!==SCHEMA)fail('NativeRuntimePlanInvalid','Reviewed runtime prerequisite plan is required');
 const {planDigest,...content}=plan;if(planDigest!==hash(content))fail('NativeRuntimePlanInvalid','Runtime prerequisite plan digest differs');
 const assertCluster=()=>{
  if(readClusterUid({kubectl})!==plan.clusterUid)fail('NativeRuntimeClusterMismatch','Cluster identity changed after runtime preparation');
  const text=kubectl(['-n','opensphere-console','get','configmap',INSTALLATION_IDENTITY_CONFIGMAP,'--ignore-not-found','-o','json'],{capture:true});
  const identity=text?JSON.parse(text):null;
  if(!identity||identity.immutable!==true||identity.data?.clusterUid!==plan.clusterUid||identity.data?.installationId!==plan.installationId
    ||(plan.identityBinding&&!sameBinding(binding(identity),plan.identityBinding)))fail('NativeRuntimeIdentityMismatch','Persistent installation identity changed after runtime preparation');
  const recordText=kubectl(['-n','opensphere-console','get','configmap','opensphere-installation-lock','--ignore-not-found','-o','json'],{capture:true});
  const record=recordText?JSON.parse(recordText):null,current=record?JSON.parse(record.data?.['release.json']??'null')?.releaseDigest:null;
  if(plan.installedReleaseDigest!==null&&(current!==plan.installedReleaseDigest||record?.metadata?.uid!==plan.installedRecordUid)
    ||plan.installedReleaseDigest===null&&current!==null&&current!==plan.releaseDigest)fail('NativeRuntimeInstalledReleaseMismatch','Installation release changed after runtime preparation');
 };
 // Validate every initial binding before the first write. Namespace creation
 // then permits each subsequent server dry-run; this is not an atomic apply.
 assertCluster();for(const entry of plan.entries){const live=readObject(kubectl,entry.object);assertOwned(live);if(!sameBinding(binding(live),entry.before))fail('NativeRuntimePlanDrift','Runtime prerequisite changed after preparation');}
 for(const entry of plan.entries){
  assertCluster();const live=readObject(kubectl,entry.object);assertOwned(live);if(!sameBinding(binding(live),entry.before))fail('NativeRuntimePlanDrift','Runtime prerequisite changed before its write');
  const object=structuredClone(entry.object);
  if(live){object.metadata={...live.metadata,...object.metadata,resourceVersion:live.metadata.resourceVersion,uid:live.metadata.uid,labels:{...live.metadata.labels,...object.metadata.labels}};delete object.metadata.managedFields;if(object.metadata.annotations){delete object.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];}}
  const verb=live?'replace':'create',input=JSON.stringify(object)+'\n';
  kubectl([verb,'--dry-run=server','-f','-'],{capture:true,input});
  assertCluster();if(!sameBinding(binding(readObject(kubectl,entry.object)),entry.before))fail('NativeRuntimePlanDrift','Runtime prerequisite changed during server validation');
  kubectl([verb,'-f','-'],{capture:true,input});
 }
 return {state:'Prepared',planDigest,objectCount:plan.entries.length,installationId:plan.installationId};
}

// One-time namespace bootstrap only. The existing C_API broker subsequently
// owns generation/CAS rotation across the fixed eight namespace inventory.
// No host token is accepted, no account is created and no data enters a plan.
export function bootstrapNativeRegistryCredential(plan,{kubectl=defaultKubectl}={}){
 const {planDigest,...content}=plan??{};if(!plan||planDigest!==hash(content))fail('NativeRuntimePlanInvalid','Verified native prerequisite plan is required');
 const assertContext=()=>{
  if(readClusterUid({kubectl})!==plan.clusterUid)fail('NativeRuntimeClusterMismatch','Cluster identity changed before registry bootstrap');
  const raw=kubectl(['-n','opensphere-console','get','configmap',INSTALLATION_IDENTITY_CONFIGMAP,'--ignore-not-found','-o','json'],{capture:true});
  const identity=raw?JSON.parse(raw):null;
  if(identity?.immutable!==true||identity.data?.clusterUid!==plan.clusterUid||identity.data?.installationId!==plan.installationId
    ||plan.identityBinding&&!sameBinding(binding(identity),plan.identityBinding))fail('NativeRuntimeIdentityMismatch','Installation identity changed before registry bootstrap');
 };
 const read=namespace=>{const raw=kubectl(['-n',namespace,'get','secret',REGISTRY_PULL_SECRET,'--ignore-not-found','-o','json'],{capture:true});return raw?JSON.parse(raw):null;};
 assertContext();
 let source,target;try{source=read('opensphere-console');target=read('opensphere-r2d2');}catch{fail('NativeRuntimeRegistryBootstrapFailed','Registry bootstrap source or destination could not be read');}
 assertOwned(source);assertOwned(target);
 if(source?.type!=='kubernetes.io/dockerconfigjson'||!source.data||Object.keys(source.data).join(',')!=='.dockerconfigjson'
   ||(plan.requiresRegistryCredential&&!secretHasGhcrCredential(source)))fail('NativeRuntimeRegistryCredentialUnavailable','The existing managed Console pull credential is not ready');
 const generation=source.metadata?.annotations?.['opensphere.io/credential-generation'];
 if(typeof generation!=='string'||!UUID.test(generation))fail('NativeRuntimeRegistryCredentialUnavailable','The existing Console pull credential has no verified generation');
 try{
  const decoded=JSON.parse(Buffer.from(source.data['.dockerconfigjson'],'base64').toString('utf8'));
  if(!plain(decoded)||!plain(decoded.auths)||Object.keys(decoded).some(k=>!['auths','x-opensphere-credential-generation'].includes(k))
    ||Object.hasOwn(decoded,'x-opensphere-credential-generation')&&decoded['x-opensphere-credential-generation']!==generation)throw Error();
  const hosts=Object.keys(decoded.auths);if(hosts.length>1||hosts.length===1&&hosts[0]!=='ghcr.io')throw Error();
  if(hosts.length){const entry=decoded.auths['ghcr.io'];if(!plain(entry)||Object.keys(entry).sort().join(',')!=='auth,password,username'
    ||['username','password','auth'].some(k=>typeof entry[k]!=='string'||!entry[k])
    ||entry.auth!==Buffer.from(entry.username+':'+entry.password).toString('base64'))throw Error();}
 }catch{fail('NativeRuntimeRegistryCredentialUnavailable','The existing managed Console pull credential is invalid or exceeds the GHCR-only boundary');}
 if(target){
  if(target.type!==source.type||JSON.stringify(target.data)!==JSON.stringify(source.data)||target.metadata?.annotations?.['opensphere.io/credential-generation']!==generation)fail('NativeRuntimeRegistryGenerationChanged','Existing native pull credential differs; use the registry owner recovery, never overwrite it with Setup');
  return {state:'ExistingManagedCredential',namespace:'opensphere-r2d2',name:REGISTRY_PULL_SECRET,generation};
 }
 const sourceBefore=binding(source),object={apiVersion:'v1',kind:'Secret',metadata:{name:REGISTRY_PULL_SECRET,namespace:'opensphere-r2d2',labels:{'app.kubernetes.io/managed-by':OWNER,'opensphere.io/credential-purpose':'registry-pull'},annotations:{'opensphere.io/credential-generation':generation}},type:source.type,data:source.data};
 const input=JSON.stringify(object)+'\n';
 try{
  kubectl(['create','--dry-run=server','-f','-'],{capture:true,input});
  assertContext();if(!sameBinding(binding(read('opensphere-console')),sourceBefore)||read('opensphere-r2d2'))fail('NativeRuntimeRegistryGenerationChanged','Registry generation or target changed during bootstrap');
  kubectl(['create','-f','-'],{capture:true,input});
 }catch(error){if(error?.code?.startsWith('NativeRuntime'))throw error;fail('NativeRuntimeRegistryBootstrapFailed','Managed native pull credential creation did not confirm; no credential payload is logged or retried');}
 return {state:'CreatedManagedCredential',namespace:'opensphere-r2d2',name:REGISTRY_PULL_SECRET,generation};
}
