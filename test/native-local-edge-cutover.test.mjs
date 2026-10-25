// Public synthetic fixtures. Real release verification/comparison/upgrade code,
// mocked OCI metadata and Kubernetes API: no signature or live cluster proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {comparePreparedOwners,requiresOwnerPreservation,projectOwnerObservation} from '../src/adoption-owner-preservation.mjs';
import {COMPONENTS,AUXILIARY_ARTIFACTS,RELEASE_API_VERSION,SOURCE,LOCAL_EDGE_TRUST,
  RELEASE_TRUST,calculateReleaseDigest,validateReleaseTransition,verifyReleaseLock} from '../src/release.mjs';
import {upgrade,installationStateDocument,releaseResourceInventory,pruneReleaseResources} from '../src/bootstrap.mjs';
import {installationRecordDigest} from '../src/forward-repair.mjs';
import {readinessProfile,verifyOwnerPreservation,verifyLocalNativeOwnerPreservation} from '../src/release-readiness-profile.mjs';
import {fetchLocalNativeOwnerReferenceSources} from '../src/owner-release-references.mjs';
import {buildNativeCutoverProof} from '../src/native-r2d2-owner-cutover.mjs';
const sha=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
const image=(name,c='a')=>`ghcr.io/opensphere-platform/${name}@sha256:${c.repeat(64)}`;
const installationId='11111111-1111-4111-8111-111111111111',clusterUid='22222222-2222-4222-8222-222222222222';
const source='c'.repeat(40);
const localLabels={'io.opensphere.channel':'edge','opensphere.io/build-authority':'localhost','opensphere.io/release-class':'pre-ga','opensphere.io/ga-eligible':'false'};
const migration={globalId:'opensphere-console/20261022/0148',semanticKey:'console.r2d2.native_request_journal',predecessorGlobalId:'',
  sha256:'a'.repeat(64),sourceRevision:source,setDigest:'sha256:'+'e'.repeat(64),setSize:1};
const manifest={schemaVersion:1,migrations:[migration]};
function lock(rev,char,legacy){
 const components=Object.fromEntries(Object.entries(COMPONENTS).map(([name,repository])=>[name,{repository,image:image(repository,char),sourceRevision:rev}]));
 if(legacy){delete components.r2d2OpenClawGateway;components.r2d2HermesWorker={repository:'opensphere-console-r2d2-hermes-worker',image:image('opensphere-console-r2d2-hermes-worker',char),sourceRevision:rev};}
 const auxiliaryArtifacts=Object.fromEntries(Object.entries(AUXILIARY_ARTIFACTS).map(([name,repository])=>[name,{repository,image:image(repository,char),sourceRevision:rev}]));
 for(const artifact of Object.values({...components,...auxiliaryArtifacts}))artifact.artifactVersion='202609020101';
 const value={apiVersion:RELEASE_API_VERSION,kind:'OpenSphereReleaseLock',channel:'edge',source:SOURCE,sourceRevision:rev,trust:LOCAL_EDGE_TRUST,components,auxiliaryArtifacts};
 value.releaseDigest=calculateReleaseDigest('edge',components,LOCAL_EDGE_TRUST,undefined,{auxiliaryArtifacts});return value;
}
function replan(f){
 const plan={schema:f.reviewed.schema,clusterUid,installationId,installedReleaseDigest:f.reviewed.installedReleaseDigest,
  installedRecordUid:f.record.metadata.uid,installedRecordResourceVersion:f.record.metadata.resourceVersion,
  identityBinding:{uid:f.identity.metadata.uid,resourceVersion:f.identity.metadata.resourceVersion,contentSha256:sha(f.identity)},
  releaseDigest:f.target.releaseDigest,inputSha256:sha(f.reviewed),entries:[{object:{kind:'ConfigMap',metadata:{name:'opensphere-r2d2-runtime-policy'},data:{'preparation.json':JSON.stringify(f.reviewed)}}}]};
 const all=[{path:'synthetic-gateway.json',yaml:JSON.stringify(f.after)},{path:'synthetic-core.json',yaml:JSON.stringify(f.otherAfter)}];
 plan.planDigest=sha(plan);f.prepared={all,inventoryArtifacts:all,foundation:{nativeRuntime:plan,migration:{manifest}}};
}
function fixture(){
 const previous=lock('b'.repeat(40),'a',true),target=lock(source,'d',false);
 const before={apiVersion:'apps/v1',kind:'Deployment',metadata:{namespace:'opensphere-console',name:'opensphere-console-osaa-gateway',uid:'gateway-uid',resourceVersion:'12'},spec:{replicas:2,
  selector:{matchLabels:{app:'c-ai'}},template:{metadata:{labels:{app:'c-ai'}},spec:{serviceAccountName:'opensphere-console-osaa-gateway',containers:[
   {name:'gateway',image:previous.components.osaaGateway.image,env:[{name:'UNCHANGED',value:'same'},{name:'R2D2_HERMES_SOCK',value:'/run/r2d2/hermes.sock'},{name:'R2D2_HERMES_ENABLED',value:'true'}],volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'r2d2-hermes-ipc',mountPath:'/run/r2d2'}]},
   {name:'hermes-worker',image:previous.components.r2d2HermesWorker.image}],volumes:[{name:'tmp',emptyDir:{}},{name:'worker-tmp',emptyDir:{sizeLimit:'256Mi'}},{name:'r2d2-hermes-ipc',emptyDir:{medium:'Memory',sizeLimit:'1Mi'}}]}}}};
 const after=structuredClone(before),p=after.spec.template.spec,g=p.containers[0];p.containers=[g];g.image=target.components.osaaGateway.image;
 g.env=g.env.filter(e=>!e.name.startsWith('R2D2_HERMES_'));g.env.push({name:'R2D2_BACKEND',value:'openclaw-native'},
  {name:'R2D2_NATIVE_GATEWAY_IMAGE',value:target.components.r2d2OpenClawGateway.image},{name:'R2D2_NATIVE_BRIDGE_IMAGE',value:target.components.osaaGateway.image},
  {name:'POD_IP',valueFrom:{fieldRef:{fieldPath:'status.podIP'}}},
  ...Object.entries({OPENSPHERE_INSTALLATION_ID:'installationId',R2D2_NATIVE_RUNTIME_POLICY:'policy.json'}).map(([name,key])=>({name,valueFrom:{configMapKeyRef:{name:'opensphere-r2d2-runtime-policy',key}}})));
 g.volumeMounts=g.volumeMounts.filter(e=>e.name!=='r2d2-hermes-ipc');p.volumes=p.volumes.filter(e=>!['worker-tmp','r2d2-hermes-ipc'].includes(e.name));
 const other={apiVersion:'apps/v1',kind:'Deployment',metadata:{namespace:'opensphere-console',name:'opensphere-console',uid:'web-uid',resourceVersion:'13'},spec:{replicas:2,template:{spec:{containers:[{name:'web',image:previous.components.console.image,env:[],securityContext:{runAsNonRoot:true}}]}}}};
 const otherAfter=structuredClone(other);otherAfter.spec.template.spec.containers[0].image=target.components.console.image;
 const identity={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'opensphere-installation-identity',namespace:'opensphere-console',uid:'identity-uid',resourceVersion:'9'},immutable:true,data:{installationId,clusterUid}};
 const config={architecture:'supabase-data-identity+gitea-change-authority',installationId,channel:'edge',authEnvironment:'production',storageClass:'synthetic-storage',consoleUrl:'https://console.example.test',initialAdmin:{username:'synthetic-admin'},releaseDigest:previous.releaseDigest};
 const record={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'opensphere-installation-lock',namespace:'opensphere-console',uid:'record-uid',resourceVersion:'10'},data:{'release.json':JSON.stringify(previous),'config.json':JSON.stringify(config),'state.json':JSON.stringify({phase:'Ready',releaseDigest:previous.releaseDigest,verification:{verifiedAt:new Date().toISOString()}})}};
 const reviewed={schema:'opensphere.r2d2-runtime-preparation/v1',clusterUid,installationId,installedReleaseDigest:previous.releaseDigest,
  policy:{installationId,image:target.components.r2d2OpenClawGateway.image,bridgeImage:target.components.osaaGateway.image,imagePullSecretName:'opensphere-ghcr-pull',storage:{sizeGi:8},resources:{cpuLimitMilli:2000},bridgeResources:{cpuLimitMilli:250}},capacity:{maxRuntimes:2,totalStorageGi:16}};
 const f={previous,target,before,after,other,otherAfter,identity,record,reviewed,cluster:clusterUid,workloads:[before,other],calls:[],events:[],ledger:[],inspected:[],failAt:''};replan(f);
 f.client=(args,options)=>{
  f.calls.push({args:[...args]});
  if(args[0]==='get'){
   if(args[1]==='namespace')return JSON.stringify({metadata:{uid:f.cluster}});
   if(args[1]==='configmap')return JSON.stringify(args[2]==='opensphere-installation-identity'?f.identity:f.record);
   return JSON.stringify({kind:'List',items:f.workloads});
  }
  assert.deepEqual(args,['apply','--dry-run=server','--validate=true','-f','-','-o','json'],'Fixture permits no operational API write');
  const request=JSON.parse(options.input);for(const item of request.items){const live=f.workloads.find(w=>w.kind===item.kind&&w.metadata.namespace===item.metadata.namespace&&w.metadata.name===item.metadata.name);item.metadata.uid=live.metadata.uid;item.metadata.resourceVersion=live.metadata.resourceVersion;}
  return JSON.stringify(request);
 };
 f.verify=async(release,options={})=>{
  f.events.push('supply');return verifyReleaseLock(release,{...options,requiredPlatforms:['linux/amd64'],inspectImageFn:async(repository,reference,inspectOptions)=>{
   assert.deepEqual(inspectOptions.requiredPlatforms,['linux/amd64']);f.inspected.push(reference);
   const member=Object.values({...release.components,...release.auxiliaryArtifacts}).find(a=>a.repository===repository);
   const metadata={image:reference,sourceRevision:member.sourceRevision,labels:{...localLabels,...(repository==='opensphere-console'?{'io.opensphere.console-index-content':'console-index-renderer/v1'}:{}),'io.opensphere.release-scope':Object.values(release.components).includes(member)?'canonical':'auxiliary',
    'io.opensphere.source-revision':member.sourceRevision,'org.opencontainers.image.revision':member.sourceRevision,'io.opensphere.release-tag':'202609020101','org.opencontainers.image.version':'202609020101'}};
   f.metadataMutation?.(metadata,repository);return metadata;
  }});
 };
 const inventory=[{apiVersion:'apps/v1',kind:'Deployment',namespace:'opensphere-console',name:'opensphere-console-osaa-gateway'},{apiVersion:'apps/v1',kind:'Deployment',namespace:'opensphere-console',name:'opensphere-console'}];
 f.runtime={verifyReleaseLock:(release,options)=>f.verify(release,options),readInstallationRecord:()=>structuredClone(f.record),readInstallationLock:()=>JSON.parse(f.record.data['release.json']),
  readInstallationConfig:()=>JSON.parse(f.record.data['config.json']),currentKubeContext:()=> 'synthetic-rke2',ownerPreservationClient:(args,options)=>f.client(args,options),
  preflight:()=>f.events.push('preflight'),ensureManagedNamespaces:()=>f.events.push('namespaces'),ensureRegistryPullSecrets:()=>f.events.push('registry'),
  prepareRelease:async()=>{f.events.push('prepare');return f.prepared;},readReleaseInventory:()=>inventory,releaseResourceInventory:()=>inventory,recordReleaseInventory:()=>f.events.push('inventory'),
  readBeszelBootstrapHistory:()=>null,readMigrationLedger:()=>f.ledger,readReleaseMigrationManifests:async()=>[manifest],
  recordInstallationState:(release,_storage,_admin,_url,_auth,_tls,phase,options={})=>{
   assert.deepEqual(options.recordPrecondition,{uid:f.record.metadata.uid,resourceVersion:f.record.metadata.resourceVersion});
   f.record.data['release.json']=JSON.stringify(release);const cfg=JSON.parse(f.record.data['config.json']);cfg.releaseDigest=release.releaseDigest;f.record.data['config.json']=JSON.stringify(cfg);
   f.record.data['state.json']=JSON.stringify(installationStateDocument(phase,release,options));f.record.metadata.resourceVersion=String(BigInt(f.record.metadata.resourceVersion)+1n);f.events.push('record:'+phase);
   return {record:{uid:f.record.metadata.uid,resourceVersion:f.record.metadata.resourceVersion}};
  },installPreparedRelease:()=>{
   const checkpoint=JSON.parse(f.record.data['state.json']).transition?.nativeCutoverCheckpoint;assert.ok(checkpoint,'Checkpoint must precede first target apply');
   assert.equal(checkpoint.schema,'opensphere.r2d2-local-edge-cutover-checkpoint/v1');assert.equal(checkpoint.targetTrustType,'localhost-edge/v1');assert.equal(checkpoint.targetBomDigest,undefined);
   f.checkpoint=checkpoint;f.events.push('install-target');if(f.failAt==='pending-legacy')throw Error('synthetic partial failure');
   f.workloads=[structuredClone(f.after),structuredClone(f.otherAfter)];f.workloads[0].metadata.resourceVersion='22';
   f.ledger=[[migration.globalId,migration.semanticKey,migration.predecessorGlobalId,migration.sha256,migration.sourceRevision,migration.setDigest,String(migration.setSize)]];
  },waitForCoreRollouts:()=>f.events.push('rollouts'),verifyInstallation:async release=>{if(f.failAt==='already-native')throw Error('synthetic verification failure');return {releaseDigest:release.releaseDigest,verifiedAt:new Date().toISOString()};},
  pruneReleaseResources:()=>{f.events.push('prune');return[];}};
 return f;
}
async function verified(f){return {previous:await f.verify(f.previous,{allowLegacyComponentSet:true}),target:await f.verify(f.target)};}
test('full upgrade inventories late declarations and normal prune removes only a genuinely retired resource',async()=>{
 const f=fixture(),native={apiVersion:'v1',kind:'Service',metadata:{namespace:'opensphere-console',name:'synthetic-native-service'}},retired={apiVersion:'v1',kind:'ConfigMap',namespace:'opensphere-console',name:'synthetic-retired'};
 const identity=o=>({apiVersion:o.apiVersion,kind:o.kind,namespace:o.metadata.namespace,name:o.metadata.name});
 const late={path:'synthetic-late-native.json',yaml:JSON.stringify(native)},early=structuredClone(f.prepared.all),decoded=[],removed=[];
 f.prepared.inventoryArtifacts=[...f.prepared.all,late];
 f.runtime.readReleaseInventory=()=>[identity(f.before),identity(f.other),identity(native),retired];
 f.runtime.releaseResourceInventory=artifacts=>{
  decoded.push(artifacts);
  return releaseResourceInventory(artifacts,(_args,{input})=>{const object=JSON.parse(input);return [object.apiVersion,object.kind,object.metadata.namespace,object.metadata.name].join('\t');});
 };
 f.runtime.pruneReleaseResources=(before,after)=>pruneReleaseResources(before,after,args=>{removed.push(args);return '';});
 let recorded;f.runtime.recordReleaseInventory=(_lock,inventory)=>{recorded=inventory;};
 await upgrade(f.previous,f.target,{runtime:f.runtime});
 assert.equal(decoded.length,1);assert.equal(decoded[0],f.prepared.inventoryArtifacts);
 assert.ok(recorded.some(item=>item.name===native.metadata.name));
 assert.deepEqual(removed,[['-n','opensphere-console','delete','ConfigMap/synthetic-retired','--ignore-not-found','--wait=true']]);
 assert.deepEqual(f.prepared.all,early);assert.equal(f.events.filter(value=>value==='install-target').length,1);
});
test('native upgrade cannot fall back to the early apply set when complete inventory is absent',async()=>{
 const f=fixture();delete f.prepared.inventoryArtifacts;
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/Native preparation is missing its complete resource inventory/);zeroWrites(f);
});
async function compare(f,recovery=false,proofs){return comparePreparedOwners(f.previous,f.target,f.prepared,{verifiedLocalLocks:proofs??await verified(f),client:f.client,nativeRecovery:recovery});}
async function interrupted(state='already-native'){
 const f=fixture();f.failAt=state;await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/native-runtime-forward-repair-required/);
 f.previous=structuredClone(f.target);f.reviewed.installedReleaseDigest=f.target.releaseDigest;replan(f);f.failAt='';f.events=[];f.calls=[];return f;
}
function mutateState(f,change){const state=JSON.parse(f.record.data['state.json']);change(state);f.record.data['state.json']=JSON.stringify(state);}
function editReferenceCheckpoint(f,change){mutateState(f,state=>{
 const checkpoint=state.transition.ownerReferenceCheckpoint;change(checkpoint);delete checkpoint.checkpointDigest;
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,stable(v[key])])):v;
 checkpoint.checkpointDigest=sha(stable(checkpoint));
});}
function zeroWrites(f){assert.ok(f.events.every(e=>!['namespaces','registry','install-target','prune','inventory'].includes(e)&&!e.startsWith('record:')));assert.ok(f.calls.every(c=>c.args[0]==='get'||c.args.includes('--dry-run=server')));}
async function withReferenceOwner(f,{gitea=false,baseline=f.previous}={}){
 if(gitea){
  for(const [owner,release]of [[f.other,baseline],[f.otherAfter,f.target]]){
   owner.metadata.name='opensphere-gitea';owner.metadata.namespace='opensphere-console-change';owner.spec.replicas=1;
   owner.spec.template.spec.containers=[{name:'gitea',image:release.components.gitea.image,env:[]}];
   owner.spec.template.spec.initContainers=['materialize-config','materialize-signing-key'].map(name=>({name,image:release.components.gitea.image,command:['same-reviewed-command']}));
  }
 }else for(const [owner,release]of [[f.other,baseline],[f.otherAfter,f.target]])owner.spec.template.spec.initContainers=[{name:'console-index-content',image:release.auxiliaryArtifacts.consoleIndexContent.image,command:['same-reviewed-command']}];
 replan(f);
 f.prepared.ownerReferenceSources=await fetchLocalNativeOwnerReferenceSources(baseline,f.target,async(_lock,path)=>readFileSync(new URL('./fixtures/native-owner-preview-C3/'+path,import.meta.url),'utf8'));
 return f;
}
test('verified init references preserve raw Owner proofs and capture their original lock before any apply',async()=>{
 const f=await withReferenceOwner(fixture()),raw=structuredClone(f.other),result=await compare(f);
 assert.equal(result.status,'preserved');assert.equal(result.ownerReferenceCheckpoint.schema,'opensphere.local-native-owner-reference-checkpoint/v1');
 assert.deepEqual(result.ownerReferenceCheckpoint.previousLock,f.previous);assert.equal(result.ownerReferenceCheckpoint.recordUid,f.record.metadata.uid);
 assert.equal(result.ownerReferenceCheckpoint.owners.length,1);assert.equal(result.ownerReferenceCheckpoint.owners[0].beforeConfigurationDigest,projectOwnerObservation(raw,{}).configurationDigest);
 assert.equal(result.nativeCutoverCheckpoint.proof.beforeConfigurationDigest,projectOwnerObservation(f.before,{}).configurationDigest);assert.equal(Object.keys(result.nativeCutoverCheckpoint.proof).length,13);
 assert.deepEqual(f.other,raw);zeroWrites(f);
});
async function interruptedReferences(gitea=false){
 const f=await withReferenceOwner(fixture(),{gitea}),baseline=structuredClone(f.previous);f.failAt='already-native';
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/native-runtime-forward-repair-required/);
 const persisted=JSON.parse(f.record.data['state.json']).transition.ownerReferenceCheckpoint;assert.ok(persisted);
 f.previous=structuredClone(f.target);f.reviewed.installedReleaseDigest=f.target.releaseDigest;await withReferenceOwner(f,{gitea,baseline});f.failAt='';f.events=[];f.calls=[];
 if(gitea)f.workloads[1].spec.replicas=0;
 else f.workloads[1].spec.template.spec.initContainers[0].image=baseline.auxiliaryArtifacts.consoleIndexContent.image;
 return {f,baseline,persisted};
}
test('same-target recovery normally reverifies the original lock and retains exact old init references',async()=>{
 const {f,baseline,persisted}=await interruptedReferences();
 const prepare=f.runtime.prepareRelease;f.runtime.prepareRelease=async(...args)=>{assert.deepEqual(args[5].ownerReferenceBaseline,baseline);return prepare(...args);};
 const apply=f.runtime.installPreparedRelease;f.runtime.installPreparedRelease=(...args)=>{assert.deepEqual(JSON.parse(f.record.data['state.json']).transition.ownerReferenceCheckpoint,persisted);return apply(...args);};
 await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)});
 assert.ok(f.inspected.some(image=>image===baseline.auxiliaryArtifacts.consoleIndexContent.image));
 assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');
});
test('source-verified target-staged Gitea at actual replicas0 is observed and restored to the actual final1',async()=>{
 const {f,persisted}=await interruptedReferences(true);
 const apply=f.runtime.installPreparedRelease;f.runtime.installPreparedRelease=(...args)=>{assert.deepEqual(JSON.parse(f.record.data['state.json']).transition.ownerReferenceCheckpoint,persisted);return apply(...args);};
 await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)});
 assert.equal(f.workloads[1].spec.replicas,1);assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');
});
for(const [name,change]of [
 ['unknown init artifact',f=>{f.workloads[1].spec.template.spec.initContainers[0].image=image('opensphere-console-index-content','e');}],
 ['changed command',f=>{f.workloads[1].spec.template.spec.initContainers[0].command=['unapproved'];}],
 ['replaced UID',f=>{f.workloads[1].metadata.uid='replacement';}],
 ['source evidence with recomputed checksum',f=>editReferenceCheckpoint(f,checkpoint=>{checkpoint.sourceEvidenceDigest='sha256:'+'e'.repeat(64);})],
 ['another original lock with recomputed checksum',f=>editReferenceCheckpoint(f,checkpoint=>{checkpoint.previousLock=f.target;})],
 ['rebound UID with recomputed checksum',f=>editReferenceCheckpoint(f,checkpoint=>{checkpoint.owners[0].uid='replacement';})],
 ['new checkpoint field with recomputed checksum',f=>editReferenceCheckpoint(f,checkpoint=>{checkpoint.unreviewed=true;})],
])test('reference recovery refuses '+name+' before any write',async()=>{
 const {f}=await interruptedReferences();change(f);await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}));zeroWrites(f);
});
for(const [name,change]of [
 ['replaced UID',f=>{f.workloads[1].metadata.uid='replacement';}],
 ['changed target spec',f=>{f.workloads[1].spec.template.spec.containers[0].env.push({name:'DRIFT',value:'unexpected'});}],
 ['old primary image',f=>{f.workloads[1].spec.template.spec.containers[0].image=image('opensphere-console-gitea','a');}],
])test('staged Gitea recovery refuses '+name+' without fabricating an active Owner',async()=>{
 const {f}=await interruptedReferences(true);change(f);await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}));zeroWrites(f);
});
test('local native cannot silently skip Owner preservation because it has no signed BOM',()=>{const f=fixture();assert.equal(requiresOwnerPreservation(f.target,f.previous),true);assert.equal(f.target.releaseBom,undefined);});
test('actual local exact-image verification and original proof produce a non-signature checkpoint',async()=>{
 const f=fixture(),result=await compare(f),c=result.nativeCutoverCheckpoint;
 assert.equal(result.status,'preserved');assert.equal(Object.keys(c.proof).length,13);assert.equal(c.targetReleaseDigest,f.target.releaseDigest);assert.equal(c.targetTrustType,'localhost-edge/v1');assert.equal(c.targetBomDigest,undefined);
 assert.equal(c.schema,'opensphere.r2d2-local-edge-cutover-checkpoint/v1');assert.equal(c.recordUid,f.record.metadata.uid);assert.equal(f.inspected.length,46);assert.equal(f.target.releaseBom,undefined);zeroWrites(f);
});
test('full native Owner preview is checked without adding native workloads to the early apply set',async()=>{
 const f=fixture();f.prepared.ownerPreview=f.prepared.all;f.prepared.all=[f.prepared.all[1]];
 const before=structuredClone(f.prepared.all),result=await compare(f);
 assert.equal(result.status,'preserved');assert.deepEqual(f.prepared.all,before);zeroWrites(f);
});
test('an explicit missing or invalid Owner preview cannot fall back to an otherwise complete apply set',async()=>{
 for(const preview of [[],null]){
  const f=fixture();f.prepared.ownerPreview=preview;
  await assert.rejects(compare(f),preview===null?/artifact set is missing/:/Active Owner omitted/);zeroWrites(f);
 }
});
test('extra Owner drift inside a full preview still fails the unchanged native preservation contract',async()=>{
 const f=fixture();const changed=structuredClone(f.otherAfter);changed.spec.template.spec.serviceAccountName='unapproved-owner';
 f.prepared.ownerPreview=[f.prepared.all[0],{yaml:JSON.stringify(changed)}];
 await assert.rejects(compare(f));zeroWrites(f);
});
test('only equal unexpanded C_AI environment entries may change order outside the thirteen engine changes',async()=>{
 const f=fixture();f.after.spec.template.spec.containers[0].env.unshift({name:'ORDER_ONLY',value:'same'});
 f.before.spec.template.spec.containers[0].env.push({name:'ORDER_ONLY',value:'same'});replan(f);
 const before=structuredClone(f.before),after=structuredClone(f.after),result=await compare(f);
 assert.equal(result.status,'preserved');assert.equal(Object.keys(result.nativeCutoverCheckpoint.proof).length,13);
 assert.equal(result.nativeCutoverCheckpoint.proof.beforeConfigurationDigest,projectOwnerObservation(before,{}).configurationDigest);
 assert.equal(result.nativeCutoverCheckpoint.proof.afterConfigurationDigest,projectOwnerObservation(after,{}).configurationDigest);
 assert.deepEqual(f.before,before);assert.deepEqual(f.after,after);zeroWrites(f);
});
test('formal native equality keeps its original environment order requirement',()=>{
 const f=fixture();f.previous.trust=f.target.trust=RELEASE_TRUST;
 f.before.spec.template.spec.containers[0].env.push({name:'ORDER_ONLY',value:'same'});
 f.after.spec.template.spec.containers[0].env.unshift({name:'ORDER_ONLY',value:'same'});replan(f);
 assert.throws(()=>buildNativeCutoverProof({previousLock:f.previous,targetLock:f.target,plan:f.prepared.foundation.nativeRuntime,before:f.before,after:f.after}),/more than the reviewed engine boundary/);
});
for(const [label,change]of[
 ['changed value',f=>{f.after.spec.template.spec.containers[0].env[0].value='changed';}],
 ['new environment name',f=>{f.after.spec.template.spec.containers[0].env.push({name:'UNREVIEWED',value:'added'});}],
 ['duplicate environment name',f=>{f.after.spec.template.spec.containers[0].env.push({name:'UNCHANGED',value:'same'});}],
 ['valueFrom instead of literal',f=>{f.after.spec.template.spec.containers[0].env[0]={name:'UNCHANGED',valueFrom:{secretKeyRef:{name:'unapproved',key:'secret'}}};}],
 ['ordered expansion on both sides',f=>{for(const owner of[f.before,f.after])owner.spec.template.spec.containers[0].env.push({name:'ORDERED',value:'$(UNCHANGED)'});}],
])test('C_AI order correction rejects '+label+' without writes',async()=>{
 const f=fixture();change(f);replan(f);await assert.rejects(compare(f));zeroWrites(f);
});
for(const state of ['pending-legacy','already-native'])test('real local upgrade records proof before '+state+' failure and explicitly recovers exactly its target',async()=>{
 const f=await interrupted(state),checkpoint=structuredClone(f.checkpoint),record=installationRecordDigest(f.record);
 const result=await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:record});
 assert.equal(result.changed,true);assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');assert.deepEqual(f.checkpoint,checkpoint);
 assert.equal(f.events.filter(e=>e==='install-target').length,1);assert.deepEqual(f.workloads[0].spec.template.spec.containers.map(c=>c.name),['gateway']);
});
for(const[name,change]of[
 ['missing actual verification result',f=>{f.runtime.verifyReleaseLock=async()=>undefined;}],
 ['self-claimed verified timestamp on input',f=>{f.previous.localVerifiedAt=f.target.localVerifiedAt=new Date().toISOString();f.record.data['release.json']=JSON.stringify(f.previous);f.runtime.verifyReleaseLock=async()=>undefined;}],
 ['OCI source label differs',f=>{f.metadataMutation=m=>m.labels['io.opensphere.source-revision']='f'.repeat(40);} ],
 ['OCI artifact identity differs',f=>{f.metadataMutation=m=>m.labels['org.opencontainers.image.version']='202609020102';}],
 ['OCI digest differs',f=>{f.metadataMutation=m=>m.image=image('opensphere-console','f');}],
 ['development authentication',f=>{const c=JSON.parse(f.record.data['config.json']);c.authEnvironment='development';f.record.data['config.json']=JSON.stringify(c);} ],
 ['cluster changed',f=>{f.cluster='44444444-4444-4444-8444-444444444444';}],
 ['immutable identity changed',f=>{f.identity.data.installationId='44444444-4444-4444-8444-444444444444';}],
 ['identity RV changed',f=>{f.identity.metadata.resourceVersion='99';}],
 ['stale preparation RV',f=>{const p=f.prepared.foundation.nativeRuntime;p.installedRecordResourceVersion='9';delete p.planDigest;p.planDigest=sha(p);} ],
 ['other Owner root drift',f=>{f.workloads[1].spec.template.spec.containers[0].securityContext={privileged:true};}],
 ['other Owner replicas would shrink',f=>{f.workloads[1].spec.replicas=3;}],
 ['reviewed policy altered after preparation',f=>{f.prepared.foundation.nativeRuntime.entries[0].object.data['preparation.json']='{}';}],
])test('local initial upgrade refuses '+name+' before resource/record writes',async()=>{const f=fixture();change(f);await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}));zeroWrites(f);});
for(const[name,change]of[
 ['missing checkpoint',f=>mutateState(f,s=>delete s.transition.nativeCutoverCheckpoint)],
 ['changed checkpoint',f=>mutateState(f,s=>s.transition.nativeCutoverCheckpoint.previousSourceRevision='e'.repeat(40))],
 ['signed checkpoint substitution',f=>mutateState(f,s=>{const c=s.transition.nativeCutoverCheckpoint;c.schema='opensphere.r2d2-cutover-checkpoint/v1';delete c.targetTrustType;c.targetBomDigest='sha256:'+'f'.repeat(64);const{checkpointDigest,...rest}=c;c.checkpointDigest=sha(rest);})],
 ['old record binding',f=>{f.record.metadata.resourceVersion='10';}],
 ['new record UID',f=>{f.record.metadata.uid='other';replan(f);}],
 ['C_AI UID changed',f=>{f.workloads[0].metadata.uid='other';}],
 ['capacity changes',f=>{f.reviewed.capacity.maxRuntimes=20;replan(f);}],
 ['other Owner changed',f=>{f.workloads[1].spec.template.spec.containers[0].securityContext={privileged:true};}],
 ['mixed old/new C_AI containers',f=>{f.workloads[0].spec.template.spec.containers.push({name:'hermes-worker',image:f.checkpoint.proof.previousWorkerImage});}],
 ['rollback allowed',f=>mutateState(f,s=>s.transition.rollback='available')],
 ['another target',f=>{f.target=lock(source,'f',false);f.reviewed.policy.image=f.target.components.r2d2OpenClawGateway.image;f.reviewed.policy.bridgeImage=f.target.components.osaaGateway.image;replan(f);}],
 ['downgrade target',f=>{f.target=lock('b'.repeat(40),'a',true);}],
])test('local exact-target recovery refuses '+name+' with zero further writes',async()=>{
 const f=await interrupted();change(f);await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}));zeroWrites(f);
});
test('ordinary same-target observation cannot clear a failed local native installation',async()=>{const f=await interrupted();const result=await upgrade(f.previous,f.target,{runtime:f.runtime});assert.equal(result.changed,false);assert.equal(JSON.parse(f.record.data['state.json']).phase,'Failed');zeroWrites(f);});
test('local-native comparator rejects mixed trust and component-only targets before observation',()=>{
 for(const name of ['target','previous']){const f=fixture();f[name].trust=RELEASE_TRUST;assert.throws(()=>requiresOwnerPreservation(f.target,f.previous),/trust class/);}
 const f=fixture();f.target.releaseScope='component';assert.throws(()=>requiresOwnerPreservation(f.target,f.previous),/integrated/);
});
test('unsigned formal native target cannot use local verification results instead of the signed adapter',async()=>{const f=fixture();const local=await verified(f);f.previous.trust=f.target.trust=RELEASE_TRUST;await assert.rejects(compare(f,false,local),/Signed readiness predicate/);});
test('local-native identity/record drift during server dry-run invalidates comparison',async()=>{
 for(const identityDrift of [false,true]){const f=fixture(),client=f.client;f.client=(args,options)=>{const result=client(args,options);if(args[0]==='apply'){if(identityDrift)f.identity.metadata.resourceVersion='99';else f.record.metadata.resourceVersion='99';}return result;};await assert.rejects(compare(f));zeroWrites(f);}
});
test('native local auxiliary-only transition retains its existing path without permitting engine replacement',()=>{
 const f=fixture(),base=structuredClone(f.target),target=structuredClone(base);target.releaseScope='component';target.baseReleaseDigest=base.releaseDigest;
 target.sourceRevision='f'.repeat(40);target.changedComponents=[];target.changedAuxiliaryArtifacts=['consoleIndexContent'];
 target.auxiliaryArtifacts.consoleIndexContent.sourceRevision=target.sourceRevision;target.auxiliaryArtifacts.consoleIndexContent.image=image(target.auxiliaryArtifacts.consoleIndexContent.repository,'f');
 target.releaseDigest=calculateReleaseDigest('edge',target.components,target.trust,undefined,target);
 validateReleaseTransition(base,target);assert.equal(requiresOwnerPreservation(target,base),false);
 assert.throws(()=>validateReleaseTransition(f.previous,target),/engine replacement requires an integrated/);
});
test('record lease drift after complete comparison blocks the first namespace and registry write',async()=>{
 const f=fixture(),client=f.client;let recordReads=0;
 f.client=(args,options)=>{const result=client(args,options);if(args[0]==='get'&&args[2]==='opensphere-installation-lock'&&++recordReads===2)f.record.metadata.resourceVersion='99';return result;};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/record changed before prerequisite writes/);zeroWrites(f);
});
test('record lease change during namespace checks blocks the next registry and all record/installer writes',async()=>{
 const f=fixture();f.runtime.ensureManagedNamespaces=()=>{f.events.push('namespaces');f.record.metadata.resourceVersion='99';};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/record changed before prerequisite writes/);
 assert.deepEqual(f.events.filter(e=>['namespaces','registry','install-target'].includes(e)),['namespaces']);assert.ok(!f.events.some(e=>e.startsWith('record:')));
});
test('existing Knowledge-only transition preserves its image-unchanged path',()=>{
 const {base,target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
 assert.equal(target.changedKnowledge,true);assert.deepEqual(target.changedComponents,[]);
 validateReleaseTransition(base,target);assert.equal(requiresOwnerPreservation(target,base),false);
});
test('changedComponents=[] cannot disguise an unlisted canonical image change as auxiliary-only',async()=>{
 const f=fixture();f.previous=structuredClone(f.target);f.record.data['release.json']=JSON.stringify(f.previous);
 const target=structuredClone(f.previous);target.releaseScope='component';target.baseReleaseDigest=f.previous.releaseDigest;
 target.sourceRevision='f'.repeat(40);target.changedComponents=[];target.changedAuxiliaryArtifacts=['consoleIndexContent'];
 for(const artifact of[target.components.consoleApi,target.auxiliaryArtifacts.consoleIndexContent]){artifact.image=image(artifact.repository,'f');artifact.sourceRevision=target.sourceRevision;}
 target.releaseDigest=calculateReleaseDigest('edge',target.components,target.trust,undefined,target);f.target=target;
 assert.throws(()=>requiresOwnerPreservation(target,f.previous));await assert.rejects(upgrade(f.previous,target,{runtime:f.runtime}));zeroWrites(f);
});
test('a valid canonical C_API component target on local native remains unsupported before any write',async()=>{
 const f=fixture();f.previous=structuredClone(f.target);f.record.data['release.json']=JSON.stringify(f.previous);
 const target=structuredClone(f.previous);target.releaseScope='component';target.baseReleaseDigest=f.previous.releaseDigest;
 target.sourceRevision='f'.repeat(40);target.changedComponents=['consoleApi'];
 target.components.consoleApi.image=image(target.components.consoleApi.repository,'f');target.components.consoleApi.sourceRevision=target.sourceRevision;
 target.releaseDigest=calculateReleaseDigest('edge',target.components,target.trust,undefined,target);f.target=target;
 validateReleaseTransition(f.previous,target);await assert.rejects(upgrade(f.previous,target,{runtime:f.runtime}),/integrated target/);zeroWrites(f);
});
test('native-to-another-native local integrated update cannot reuse a first-cutover preparation without its current policy',async()=>{
 const f=fixture();f.previous=structuredClone(f.target);f.target=lock('f'.repeat(40),'f',false);
 f.record.data['release.json']=JSON.stringify(f.previous);const cfg=JSON.parse(f.record.data['config.json']);cfg.releaseDigest=f.previous.releaseDigest;f.record.data['config.json']=JSON.stringify(cfg);
 f.record.data['state.json']=JSON.stringify({phase:'Ready',releaseDigest:f.previous.releaseDigest});f.workloads=[structuredClone(f.after),structuredClone(f.otherAfter)];
 f.after=structuredClone(f.after);const gateway=f.after.spec.template.spec.containers[0];gateway.image=f.target.components.osaaGateway.image;
 gateway.env.find(e=>e.name==='R2D2_NATIVE_GATEWAY_IMAGE').value=f.target.components.r2d2OpenClawGateway.image;gateway.env.find(e=>e.name==='R2D2_NATIVE_BRIDGE_IMAGE').value=f.target.components.osaaGateway.image;
 f.otherAfter=structuredClone(f.otherAfter);f.otherAfter.spec.template.spec.containers[0].image=f.target.components.console.image;
 f.reviewed.installedReleaseDigest=f.previous.releaseDigest;f.reviewed.policy.image=f.target.components.r2d2OpenClawGateway.image;f.reviewed.policy.bridgeImage=f.target.components.osaaGateway.image;replan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/existing public runtime policy/);zeroWrites(f);
});
test('raw lock recovery flag cannot suppress proof required by the explicit upgrade recovery option',async()=>{
 const f=await interrupted();for(const value of[f.previous,f.target])value.nativeRecovery=false;
 f.record.data['release.json']=JSON.stringify(f.previous);mutateState(f,s=>delete s.transition.nativeCutoverCheckpoint);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}),/original persisted cutover checkpoint/);zeroWrites(f);
});

// Native maintenance reuses the API simulator above, not its Hermes exception.
// It exercises real verification/comparison/upgrade against synthetic public data.
function maintenanceReplan(f){
 replan(f);const plan=f.prepared.foundation.nativeRuntime,entry=plan.entries[0];
 entry.object={apiVersion:'v1',kind:'ConfigMap',metadata:{namespace:'opensphere-console',name:'opensphere-r2d2-runtime-policy',labels:{'app.kubernetes.io/managed-by':'opensphere-setup'}},
  data:{installationId,'policy.json':JSON.stringify(f.reviewed.policy),'preparation.json':JSON.stringify(f.reviewed)}};
 entry.before={uid:f.runtimePolicy.metadata.uid,resourceVersion:f.runtimePolicy.metadata.resourceVersion,contentSha256:sha(f.runtimePolicy)};
 if(f.accessObjects)plan.entries=[...f.desiredAccess.map((object,i)=>({object:structuredClone(object),before:{uid:f.accessObjects[i].metadata.uid,resourceVersion:f.accessObjects[i].metadata.resourceVersion,contentSha256:sha(f.accessObjects[i])}})),entry];
 if(f.renderedAccess)f.prepared.all.push({path:'synthetic-runtime-access.json',yaml:JSON.stringify(f.renderedAccess)});
 delete plan.planDigest;plan.planDigest=sha(plan);
}
function maintenanceFixture(){
 const f=fixture();f.previous=structuredClone(f.target);f.before=structuredClone(f.after);f.other=structuredClone(f.otherAfter);
 f.ledger=[[migration.globalId,migration.semanticKey,migration.predecessorGlobalId,migration.sha256,migration.sourceRevision,migration.setDigest,String(migration.setSize)]];
 f.workloads=[f.before,f.other];f.target=lock('f'.repeat(40),'f',false);
 const current=structuredClone(f.reviewed);
 f.runtimePolicy={apiVersion:'v1',kind:'ConfigMap',metadata:{namespace:'opensphere-console',name:'opensphere-r2d2-runtime-policy',uid:'policy-uid',resourceVersion:'15',labels:{'app.kubernetes.io/managed-by':'opensphere-setup'}},
  data:{installationId,'policy.json':JSON.stringify(current.policy),'preparation.json':JSON.stringify(current)}};
 f.after=structuredClone(f.before);const g=f.after.spec.template.spec.containers[0];g.image=f.target.components.osaaGateway.image;
 g.env.find(e=>e.name==='R2D2_NATIVE_GATEWAY_IMAGE').value=f.target.components.r2d2OpenClawGateway.image;g.env.find(e=>e.name==='R2D2_NATIVE_BRIDGE_IMAGE').value=f.target.components.osaaGateway.image;
 f.otherAfter=structuredClone(f.other);f.otherAfter.spec.template.spec.containers[0].image=f.target.components.console.image;
 f.record.data['release.json']=JSON.stringify(f.previous);const cfg=JSON.parse(f.record.data['config.json']);cfg.releaseDigest=f.previous.releaseDigest;f.record.data['config.json']=JSON.stringify(cfg);
 f.record.data['state.json']=JSON.stringify({phase:'Ready',releaseDigest:f.previous.releaseDigest});
 f.reviewed.installedReleaseDigest=f.previous.releaseDigest;f.reviewed.policy.image=f.target.components.r2d2OpenClawGateway.image;f.reviewed.policy.bridgeImage=f.target.components.osaaGateway.image;
 f.accessObjects=['Namespace/opensphere-r2d2','ServiceAccount/r2d2-personal-runtime','Role/r2d2-personal-runtime-provisioner','RoleBinding/r2d2-personal-runtime-provisioner','NetworkPolicy/r2d2-default-deny','NetworkPolicy/r2d2-personal-runtime','NetworkPolicy/r2d2-personal-runtime-to-gateway','ResourceQuota/r2d2-personal-runtime-capacity'].map((value,i)=>{
  const[kind,name]=value.split('/');return {apiVersion:kind==='Role'?'rbac.authorization.k8s.io/v1':'v1',kind,metadata:{name,...(i===0?{}:{namespace:i===6?'opensphere-console':'opensphere-r2d2'}),uid:'access-'+i,resourceVersion:'8',labels:{'app.kubernetes.io/managed-by':'opensphere-setup'}},
   ...(kind==='Role'?{rules:[{apiGroups:[''],resources:['secrets'],verbs:['get']}]}:kind==='ResourceQuota'?{spec:{hard:{pods:'4'}}}:{spec:{reviewed:true}})};
 });f.desiredAccess=structuredClone(f.accessObjects);
 f.controlAccess={apiVersion:'rbac.authorization.k8s.io/v1',kind:'Role',metadata:{name:'opensphere-console-osaa-gateway',namespace:'opensphere-console',uid:'control-role-uid',resourceVersion:'17'},rules:[{apiGroups:[''],resources:['configmaps'],verbs:['get']}]};
 f.renderedAccess=structuredClone(f.controlAccess);
 maintenanceReplan(f);const originalClient=f.client;
 f.client=(args,options)=>{
  if(args[0]==='get'&&args[1]==='configmap'&&args[2]==='opensphere-r2d2-runtime-policy'){f.calls.push({args:[...args]});const result=JSON.stringify(f.runtimePolicy);f.policyReads=(f.policyReads??0)+1;f.policyReadHook?.(f.policyReads);return result;}
  if(args[0]==='get'&&[...f.accessObjects,f.controlAccess].some(o=>o.kind===args[1]&&o.metadata.name===args[2])){f.calls.push({args:[...args]});const object=[...f.accessObjects,f.controlAccess].find(o=>o.kind===args[1]&&o.metadata.name===args[2]);return JSON.stringify(object);}
  if(args.includes('--dry-run=server')&&JSON.parse(options.input).kind!=='List'){
   f.calls.push({args:[...args]});const object=JSON.parse(options.input),live=[...f.accessObjects,f.controlAccess].find(o=>o.kind===object.kind&&o.metadata.name===object.metadata.name);
   if(live)object.metadata={...object.metadata,uid:live.metadata.uid,resourceVersion:live.metadata.resourceVersion};
   return JSON.stringify(f.admitAccess?f.admitAccess(object):object);
  }
  const result=originalClient(args,options);if(args.includes('--dry-run=server'))f.dryRunHook?.();return result;
 };
 f.runtime.installPreparedRelease=()=>{
  const transition=JSON.parse(f.record.data['state.json']).transition;
  assert.equal(transition.nativeCutoverCheckpoint,undefined,'Maintenance cannot use the Hermes removal proof');
  const checkpoint=transition.nativeMaintenanceCheckpoint;assert.equal(checkpoint?.schema,'opensphere.r2d2-local-edge-maintenance-checkpoint/v1','Maintenance checkpoint must precede first target apply');
  assert.equal(checkpoint.proof.owner,'osaaGateway');f.checkpoint=structuredClone(checkpoint);f.events.push('install-target');
  if(f.failAt==='previous-native')throw Error('synthetic pre-apply maintenance failure');
  const body=structuredClone(f.prepared.foundation.nativeRuntime.entries.find(e=>e.object.data?.['preparation.json']).object);body.metadata={...body.metadata,uid:f.runtimePolicy.metadata.uid,resourceVersion:String(BigInt(f.runtimePolicy.metadata.resourceVersion)+1n)};f.runtimePolicy=body;
  f.workloads=[structuredClone(f.after),structuredClone(f.otherAfter)];f.workloads[0].metadata.resourceVersion='22';
  f.ledger=[[migration.globalId,migration.semanticKey,migration.predecessorGlobalId,migration.sha256,migration.sourceRevision,migration.setDigest,String(migration.setSize)]];
 };
 f.runtime.verifyInstallation=async release=>{if(f.failAt==='target-native')throw Error('synthetic post-apply maintenance failure');return {releaseDigest:release.releaseDigest,verifiedAt:new Date().toISOString()};};
 const write=f.runtime.recordInstallationState;f.runtime.recordInstallationState=(...args)=>{const result=write(...args);if(args[6]==='Installing'&&f.loseInitialResponse){f.loseInitialResponse=false;throw Error('synthetic lost first CAS response');}return result;};
 return f;
}
async function interruptedMaintenance(state){
 const f=maintenanceFixture();f.failAt=state;await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/native-runtime-forward-repair-required/);
 f.previous=structuredClone(f.target);f.reviewed.installedReleaseDigest=f.previous.releaseDigest;maintenanceReplan(f);f.failAt='';f.events=[];f.calls=[];return f;
}

test('native maintenance preserves the same Owner and records a separate checkpoint before target apply',async()=>{
 const f=maintenanceFixture(),result=await upgrade(f.previous,f.target,{runtime:f.runtime});assert.equal(result.changed,true);
 assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');assert.equal(f.checkpoint.proof.installedReleaseDigest,f.previous.releaseDigest);
 assert.equal(f.checkpoint.proof.previousWorkerImage,undefined);assert.equal(f.checkpoint.proof.removedContainer,undefined);
 assert.equal(f.events.filter(e=>e==='prepare').length,1,'Forward-only maintenance must not prepare old policy for rollback');
});
for(const state of ['previous-native','target-native'])test('native maintenance explicitly recovers the exact target from '+state,async()=>{
 const f=await interruptedMaintenance(state),checkpoint=structuredClone(f.checkpoint);
 const result=await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)});
 assert.equal(result.changed,true);assert.deepEqual(f.checkpoint,checkpoint);assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');assert.equal(f.events.filter(e=>e==='install-target').length,1);
});
test('native maintenance resumes its first Installing old-lock checkpoint after an unknown CAS response',async()=>{
 const f=maintenanceFixture();f.loseInitialResponse=true;
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),error=>error.code==='RecordOwnershipUnknown');
 const state=JSON.parse(f.record.data['state.json']);assert.equal(state.phase,'Installing');assert.equal(state.releaseDigest,f.previous.releaseDigest);assert.ok(state.transition.nativeMaintenanceCheckpoint);
 assert.ok(!f.events.includes('install-target'));maintenanceReplan(f);f.events=[];f.calls=[];f.inspected=[];
 const result=await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)});
 assert.equal(result.changed,true);assert.equal(f.inspected.length,46,'Old-lock recovery must actually verify both locked image sets');assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');
});
for(const [label,change]of[
 ['runtime capacity',f=>{f.reviewed.capacity.maxRuntimes++;maintenanceReplan(f);}],
 ['personal resources',f=>{f.reviewed.policy.resources.cpuLimitMilli++;maintenanceReplan(f);}],
 ['storage',f=>{f.reviewed.policy.storage.sizeGi++;maintenanceReplan(f);}],
 ['credential reference',f=>{f.reviewed.policy.imagePullSecretName='another-pull-secret';maintenanceReplan(f);}],
 ['C_AI ServiceAccount',f=>{f.after.spec.template.spec.serviceAccountName='different';maintenanceReplan(f);}],
 ['C_AI replicas',f=>{f.after.spec.replicas++;maintenanceReplan(f);}],
 ['C_AI feature',f=>{f.after.spec.template.spec.containers[0].env.find(e=>e.name==='R2D2_BACKEND').value='disabled';maintenanceReplan(f);}],
 ['C_AI configuration',f=>{f.after.spec.template.spec.containers[0].env.push({name:'NEW_AUTHORITY',value:'true'});maintenanceReplan(f);}],
 ['another Owner replicas',f=>{f.otherAfter.spec.replicas++;maintenanceReplan(f);}],
 ['another Owner security',f=>{f.otherAfter.spec.template.spec.containers[0].securityContext.runAsNonRoot=false;maintenanceReplan(f);}],
 ['policy replacement',f=>{f.runtimePolicy.metadata.uid='replaced';}],
 ['foreign policy',f=>{f.runtimePolicy.metadata.labels['app.kubernetes.io/managed-by']='another-owner';}],
 ['stale policy RV',f=>{f.runtimePolicy.metadata.resourceVersion='99';}],
 ['unverified lock metadata',f=>{f.runtime.verifyReleaseLock=async release=>release;}],
 ['additional native Role grant',f=>{f.desiredAccess[2].rules[0].verbs.push('update');maintenanceReplan(f);}],
 ['personal NetworkPolicy',f=>{f.desiredAccess[4].spec.allowAll=true;maintenanceReplan(f);}],
 ['namespace PSA policy',f=>{f.desiredAccess[0].metadata.labels['pod-security.kubernetes.io/enforce']='privileged';maintenanceReplan(f);}],
 ['quota hidden by the renderer',f=>{f.desiredAccess[7].spec.hard.pods='40';maintenanceReplan(f);}],
 ['rendered C_AI Role grant',f=>{f.renderedAccess.rules[0].verbs.push('update');maintenanceReplan(f);}],
 ['new rendered ClusterRole',f=>{f.renderedAccess={apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRole',metadata:{name:'unreviewed-new-role'},rules:[{apiGroups:['*'],resources:['*'],verbs:['*']}]};maintenanceReplan(f);}],
])test('native maintenance refuses '+label+' before any write',async()=>{
 const f=maintenanceFixture();change(f);await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}));zeroWrites(f);
});
test('native maintenance detects policy TOCTOU after dry-run before any prerequisite write',async()=>{
 const f=maintenanceFixture();f.dryRunHook=()=>{f.runtimePolicy.metadata.resourceVersion='99';};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/policy changed during comparison/);zeroWrites(f);
});
test('native maintenance detects policy drift between comparison and first resource write',async()=>{
 const f=maintenanceFixture();f.policyReadHook=n=>{if(n===2)f.runtimePolicy.metadata.resourceVersion='99';};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/policy changed before a write/);zeroWrites(f);
});
for(const [label,change]of[
 ['immutable identity',f=>{f.identity.metadata.resourceVersion='99';}],
 ['cluster',f=>{f.cluster='another-cluster';}],
])test('native maintenance rechecks '+label+' before the first resource write',async()=>{
 const f=maintenanceFixture();f.policyReadHook=n=>{if(n===2)change(f);};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}));zeroWrites(f);
});
test('native maintenance rechecks policy before registry custody after namespace checks',async()=>{
 const f=maintenanceFixture();f.runtime.ensureManagedNamespaces=()=>{f.events.push('namespaces');f.runtimePolicy.metadata.resourceVersion='99';};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/policy changed before a write/);
 assert.deepEqual(f.events.filter(e=>['namespaces','registry','install-target'].includes(e)),['namespaces']);assert.ok(!f.events.some(e=>e.startsWith('record:')));
});
test('native maintenance cannot downgrade the native inventory to the retired engine',async()=>{
 const f=maintenanceFixture();f.target=lock('e'.repeat(40),'e',true);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}));zeroWrites(f);
});
test('native maintenance cannot cross into formal trust using the local proof',async()=>{
 const f=maintenanceFixture();f.target.trust=RELEASE_TRUST;
 f.target.releaseDigest=calculateReleaseDigest('edge',f.target.components,f.target.trust,undefined,{auxiliaryArtifacts:f.target.auxiliaryArtifacts});
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/trust class/);zeroWrites(f);
});
test('native maintenance proof cannot substitute a signed profile or a Hermes cutover proof',async()=>{
 const f=maintenanceFixture(),comparison=await compare(f),proof=comparison.nativeMaintenanceCheckpoint.proof;
 assert.throws(()=>verifyOwnerPreservation({profile:readinessProfile('full',f.target.sourceRevision),sourceRevision:f.target.sourceRevision,nativeMaintenance:proof}),/cannot substitute a formal/);
 assert.throws(()=>verifyLocalNativeOwnerPreservation({sourceRevision:f.target.sourceRevision,nativeCutover:{},nativeMaintenance:proof}),/mutually exclusive/);zeroWrites(f);
});
test('native maintenance permission binding drift is rejected before first resource write',async()=>{
 const f=maintenanceFixture();f.policyReadHook=n=>{if(n===3)f.controlAccess.metadata.resourceVersion='99';};
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/permission object changed before a write/);zeroWrites(f);
});
function actualPrerequisiteFixture(){
 const f=maintenanceFixture(),contract=JSON.parse(readFileSync(new URL('./fixtures/native-maintenance-prerequisites-v1.json',import.meta.url)));
 assert.equal(contract.synthetic,true);const input=contract.input,source=process.env.OPENSPHERE_CONSOLE_SOURCE;
 // Explicit producer/consumer conformance input only. Production Setup uses
 // its verified artifact; no runtime code imports a sibling source checkout.
 const objects=source?JSON.parse(execFileSync(process.execPath,['-e',
  'process.stdout.write(JSON.stringify(require(process.argv[1]).renderPersonalRuntimePrerequisites(JSON.parse(require("node:fs").readFileSync(0,"utf8")))))',
  join(source,contract.producerPath)],{input:JSON.stringify(input),encoding:'utf8',timeout:15000})):contract.objects;
 assert.deepEqual(objects,contract.objects,'Current producer prerequisite output changed from the reviewed fixture');
 f.reviewed.policy=structuredClone(input.policy);f.reviewed.capacity=structuredClone(input.capacity);
 const current=JSON.parse(f.runtimePolicy.data['preparation.json']);current.policy={...structuredClone(input.policy),image:f.previous.components.r2d2OpenClawGateway.image,bridgeImage:f.previous.components.osaaGateway.image};current.capacity=structuredClone(input.capacity);
 f.runtimePolicy.data['preparation.json']=JSON.stringify(current);f.runtimePolicy.data['policy.json']=JSON.stringify(current.policy);
 f.desiredAccess=objects.map(o=>({...structuredClone(o),metadata:{...o.metadata,labels:{...o.metadata.labels,'app.kubernetes.io/managed-by':'opensphere-setup','opensphere.io/r2d2-prerequisite':'true'}}}));
 f.accessObjects=f.desiredAccess.map((o,i)=>({...structuredClone(o),metadata:{...structuredClone(o.metadata),uid:'actual-access-'+i,resourceVersion:'25',creationTimestamp:'2026-10-24T00:00:00Z',managedFields:[{manager:'synthetic-apiserver'}],labels:{...o.metadata.labels,'app.kubernetes.io/version':'existing-unmanaged-label'}}}));
 Object.assign(f.accessObjects[0],{spec:{finalizers:['kubernetes']},status:{phase:'Active'}});f.accessObjects[0].metadata.labels['kubernetes.io/metadata.name']='opensphere-r2d2';
 // These are simulated API defaults, not a claim that RKE2 admitted them.
 f.admitAccess=o=>o.kind==='Namespace'?{...o,spec:{finalizers:['kubernetes']},status:{phase:'Active'},metadata:{...o.metadata,labels:{...o.metadata.labels,'kubernetes.io/metadata.name':o.metadata.name}}}:o;
 maintenanceReplan(f);return f;
}
test('actual renderer prerequisites preserve API defaults and existing version labels during maintenance',async()=>{
 const f=actualPrerequisiteFixture(),result=await upgrade(f.previous,f.target,{runtime:f.runtime});assert.equal(result.changed,true);assert.equal(f.accessObjects.length,8);
 assert.ok(f.calls.some(c=>c.args[0]==='replace'&&c.args.includes('--dry-run=server')));assert.ok(f.calls.some(c=>c.args[0]==='apply'&&c.args.includes('--dry-run=server')));
});
test('actual renderer Role grant change is rejected despite unchanged reviewed policy JSON',async()=>{
 const f=actualPrerequisiteFixture();f.desiredAccess.find(o=>o.kind==='Role').rules[0].verbs.push('delete');maintenanceReplan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/changes permissions/);zeroWrites(f);
});
test('rendered apply cannot delete an existing declared namespace PSA label hidden by prerequisite replacement',async()=>{
 const f=actualPrerequisiteFixture();f.renderedAccess=structuredClone(f.desiredAccess[0]);
 f.renderedAccess.metadata.labels={...f.accessObjects[0].metadata.labels};delete f.renderedAccess.metadata.labels['pod-security.kubernetes.io/enforce'];maintenanceReplan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/changes permissions/);zeroWrites(f);
});
for(const kind of['List','RoleList','Unstructured'])test('native maintenance refuses '+kind+' permission wrappers before any write',async()=>{
 const f=actualPrerequisiteFixture();f.renderedAccess={apiVersion:'v1',kind,items:[{...structuredClone(f.controlAccess),rules:[{apiGroups:['*'],resources:['*'],verbs:['*']}]}]};maintenanceReplan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/flat reviewed declarations/);zeroWrites(f);
});
test('native maintenance refuses top-level items hidden on a prerequisite Role before any write',async()=>{
 const f=actualPrerequisiteFixture();f.desiredAccess.find(o=>o.kind==='Role').items=[{kind:'ClusterRole',metadata:{name:'hidden-role'},rules:[{apiGroups:['*'],resources:['*'],verbs:['*']}]}];maintenanceReplan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/flat reviewed declarations/);zeroWrites(f);
});
for(const [label,change]of[
 ['missing checkpoint',f=>mutateState(f,s=>delete s.transition.nativeMaintenanceCheckpoint)],
 ['checkpoint data tampering',f=>mutateState(f,s=>s.transition.nativeMaintenanceCheckpoint.proof.owner='another-owner')],
 ['another target',f=>{f.target=lock('e'.repeat(40),'e',false);f.reviewed.policy.image=f.target.components.r2d2OpenClawGateway.image;f.reviewed.policy.bridgeImage=f.target.components.osaaGateway.image;maintenanceReplan(f);}],
 ['record replacement',f=>{f.record.metadata.uid='other-record';maintenanceReplan(f);}],
 ['stale preparation',f=>{f.record.metadata.resourceVersion='99';}],
 ['policy capacity drift',f=>{f.reviewed.capacity.totalStorageGi++;maintenanceReplan(f);}],
 ['current Owner drift',f=>{f.workloads[0].spec.template.spec.serviceAccountName='another';}],
])test('native maintenance recovery refuses '+label+' without new writes',async()=>{
 const f=await interruptedMaintenance('target-native');change(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}));zeroWrites(f);
});
