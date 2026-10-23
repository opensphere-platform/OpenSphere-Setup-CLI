// Public synthetic fixtures. Real release verification/comparison/upgrade code,
// mocked OCI metadata and Kubernetes API: no signature or live cluster proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {comparePreparedOwners,requiresOwnerPreservation} from '../src/adoption-owner-preservation.mjs';
import {COMPONENTS,AUXILIARY_ARTIFACTS,RELEASE_API_VERSION,SOURCE,LOCAL_EDGE_TRUST,
  RELEASE_TRUST,calculateReleaseDigest,validateReleaseTransition,verifyReleaseLock} from '../src/release.mjs';
import {upgrade,installationStateDocument} from '../src/bootstrap.mjs';
import {installationRecordDigest} from '../src/forward-repair.mjs';
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
 plan.planDigest=sha(plan);f.prepared={all:[{yaml:JSON.stringify(f.after)},{yaml:JSON.stringify(f.otherAfter)}],foundation:{nativeRuntime:plan,migration:{manifest}}};
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
async function compare(f,recovery=false,proofs){return comparePreparedOwners(f.previous,f.target,f.prepared,{verifiedLocalLocks:proofs??await verified(f),client:f.client,nativeRecovery:recovery});}
async function interrupted(state='already-native'){
 const f=fixture();f.failAt=state;await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/native-runtime-forward-repair-required/);
 f.previous=structuredClone(f.target);f.reviewed.installedReleaseDigest=f.target.releaseDigest;replan(f);f.failAt='';f.events=[];f.calls=[];return f;
}
function mutateState(f,change){const state=JSON.parse(f.record.data['state.json']);change(state);f.record.data['state.json']=JSON.stringify(state);}
function zeroWrites(f){assert.ok(f.events.every(e=>!['namespaces','registry','install-target','prune','inventory'].includes(e)&&!e.startsWith('record:')));assert.ok(f.calls.every(c=>c.args[0]==='get'||c.args.includes('--dry-run=server')));}
test('local native cannot silently skip Owner preservation because it has no signed BOM',()=>{const f=fixture();assert.equal(requiresOwnerPreservation(f.target,f.previous),true);assert.equal(f.target.releaseBom,undefined);});
test('actual local exact-image verification and original proof produce a non-signature checkpoint',async()=>{
 const f=fixture(),result=await compare(f),c=result.nativeCutoverCheckpoint;
 assert.equal(result.status,'preserved');assert.equal(Object.keys(c.proof).length,13);assert.equal(c.targetReleaseDigest,f.target.releaseDigest);assert.equal(c.targetTrustType,'localhost-edge/v1');assert.equal(c.targetBomDigest,undefined);
 assert.equal(c.schema,'opensphere.r2d2-local-edge-cutover-checkpoint/v1');assert.equal(c.recordUid,f.record.metadata.uid);assert.equal(f.inspected.length,46);assert.equal(f.target.releaseBom,undefined);zeroWrites(f);
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
test('native-to-another-native local integrated update is not confused with the approved first transition',async()=>{
 const f=fixture();f.previous=structuredClone(f.target);f.target=lock('f'.repeat(40),'f',false);
 f.record.data['release.json']=JSON.stringify(f.previous);const cfg=JSON.parse(f.record.data['config.json']);cfg.releaseDigest=f.previous.releaseDigest;f.record.data['config.json']=JSON.stringify(cfg);
 f.record.data['state.json']=JSON.stringify({phase:'Ready',releaseDigest:f.previous.releaseDigest});f.workloads=[structuredClone(f.after),structuredClone(f.otherAfter)];
 f.after=structuredClone(f.after);const gateway=f.after.spec.template.spec.containers[0];gateway.image=f.target.components.osaaGateway.image;
 gateway.env.find(e=>e.name==='R2D2_NATIVE_GATEWAY_IMAGE').value=f.target.components.r2d2OpenClawGateway.image;gateway.env.find(e=>e.name==='R2D2_NATIVE_BRIDGE_IMAGE').value=f.target.components.osaaGateway.image;
 f.otherAfter=structuredClone(f.otherAfter);f.otherAfter.spec.template.spec.containers[0].image=f.target.components.console.image;
 f.reviewed.installedReleaseDigest=f.previous.releaseDigest;f.reviewed.policy.image=f.target.components.r2d2OpenClawGateway.image;f.reviewed.policy.bridgeImage=f.target.components.osaaGateway.image;replan(f);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/Only the exact retired engine inventory/);zeroWrites(f);
});
test('raw lock recovery flag cannot suppress proof required by the explicit upgrade recovery option',async()=>{
 const f=await interrupted();for(const value of[f.previous,f.target])value.nativeRecovery=false;
 f.record.data['release.json']=JSON.stringify(f.previous);mutateState(f,s=>delete s.transition.nativeCutoverCheckpoint);
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:installationRecordDigest(f.record)}),/original persisted cutover checkpoint/);zeroWrites(f);
});
