// Public in-memory fixtures exercise the real comparator/validator. They are
// not signatures, an API-server apply, production identities or an image proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {comparePreparedOwners} from '../src/adoption-owner-preservation.mjs';
import {calculateReleaseBomDigest,calculateReleaseDigest,releaseBomPointer,COMPONENTS,AUXILIARY_ARTIFACTS,RELEASE_API_VERSION,RELEASE_TRUST,SOURCE} from '../src/release.mjs';
import {readinessProfile} from '../src/release-readiness-profile.mjs';
import {upgrade,installationStateDocument} from '../src/bootstrap.mjs';
import {installationRecordDigest} from '../src/forward-repair.mjs';
const sha=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
const image=(name,char='a')=>`ghcr.io/opensphere-platform/${name}@sha256:${char.repeat(64)}`;
const source='c'.repeat(40),now=Date.now();
const installationId='11111111-1111-4111-8111-111111111111',clusterUid='22222222-2222-4222-8222-222222222222';
function fixture(){
 const previous={sourceRevision:'b'.repeat(40),releaseDigest:'sha256:'+'b'.repeat(64),components:{
  osaaGateway:{repository:'opensphere-console-osaa-gateway',image:image('opensphere-console-osaa-gateway')},
  r2d2HermesWorker:{repository:'opensphere-console-r2d2-hermes-worker',image:image('opensphere-console-r2d2-hermes-worker')},
  console:{repository:'opensphere-console',image:image('opensphere-console')}}};
 const profile=readinessProfile('native-r2d2-cutover',source),bom={kind:'OpenSphereReleaseBOM',sourceRevision:source,readinessProfile:profile};
 const target={sourceRevision:source,releaseDigest:'sha256:'+'d'.repeat(64),components:{
  osaaGateway:{repository:'opensphere-console-osaa-gateway',image:image('opensphere-console-osaa-gateway','d')},
  r2d2OpenClawGateway:{repository:'opensphere-console-r2d2-openclaw',image:image('opensphere-console-r2d2-openclaw','d')},
  console:{repository:'opensphere-console',image:image('opensphere-console','d')}},releaseBom:{digest:calculateReleaseBomDigest(bom),readinessProfile:profile}};
 const before={apiVersion:'apps/v1',kind:'Deployment',metadata:{namespace:'opensphere-console',name:'opensphere-console-osaa-gateway',uid:'gateway-uid',resourceVersion:'12'},spec:{replicas:2,
  selector:{matchLabels:{app:'c-ai'}},template:{metadata:{labels:{app:'c-ai'}},spec:{serviceAccountName:'opensphere-console-osaa-gateway',
   containers:[{name:'gateway',image:previous.components.osaaGateway.image,env:[{name:'PUBLIC_OTHER',value:'same'},{name:'R2D2_HERMES_SOCK',value:'/run/r2d2/hermes.sock'},{name:'R2D2_HERMES_ENABLED',value:'true'}],volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'r2d2-hermes-ipc',mountPath:'/run/r2d2'}]},
    {name:'hermes-worker',image:previous.components.r2d2HermesWorker.image}],volumes:[{name:'tmp',emptyDir:{}},{name:'worker-tmp',emptyDir:{sizeLimit:'256Mi'}},{name:'r2d2-hermes-ipc',emptyDir:{medium:'Memory',sizeLimit:'1Mi'}}]}}}};
 const after=structuredClone(before),pod=after.spec.template.spec,g=pod.containers[0];pod.containers=[g];g.image=target.components.osaaGateway.image;
 g.env=g.env.filter(e=>!e.name.startsWith('R2D2_HERMES_'));g.env.push({name:'R2D2_BACKEND',value:'openclaw-native'},
  {name:'R2D2_NATIVE_GATEWAY_IMAGE',value:target.components.r2d2OpenClawGateway.image},{name:'R2D2_NATIVE_BRIDGE_IMAGE',value:target.components.osaaGateway.image},
  {name:'POD_IP',valueFrom:{fieldRef:{fieldPath:'status.podIP'}}},
  ...Object.entries({OPENSPHERE_INSTALLATION_ID:'installationId',R2D2_NATIVE_RUNTIME_POLICY:'policy.json'}).map(([name,key])=>({name,valueFrom:{configMapKeyRef:{name:'opensphere-r2d2-runtime-policy',key}}})));
 g.volumeMounts=g.volumeMounts.filter(e=>e.name!=='r2d2-hermes-ipc');pod.volumes=pod.volumes.filter(e=>!['worker-tmp','r2d2-hermes-ipc'].includes(e.name));
 const other={apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'opensphere-console',namespace:'opensphere-console',uid:'web-uid',resourceVersion:'13'},spec:{replicas:2,template:{spec:{containers:[{name:'web',image:previous.components.console.image,env:[],securityContext:{runAsNonRoot:true}}]}}}};
 const otherAfter=structuredClone(other);otherAfter.spec.template.spec.containers[0].image=target.components.console.image;
 const record={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'opensphere-installation-lock',namespace:'opensphere-console',uid:'record-uid',resourceVersion:'10'},data:{'release.json':JSON.stringify(previous),'config.json':JSON.stringify({installationId}),'state.json':JSON.stringify({phase:'Ready',releaseDigest:previous.releaseDigest})}};
 const identity={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'opensphere-installation-identity',namespace:'opensphere-console',uid:'identity-uid',resourceVersion:'9'},immutable:true,data:{installationId,clusterUid}};
 const reviewed={schema:'opensphere.r2d2-runtime-preparation/v1',clusterUid,installationId,installedReleaseDigest:previous.releaseDigest,
  policy:{installationId,image:target.components.r2d2OpenClawGateway.image,bridgeImage:target.components.osaaGateway.image,storage:{sizeGi:8},resources:{cpuLimitMilli:2000},bridgeResources:{cpuLimitMilli:250}},capacity:{maxRuntimes:2,totalStorageGi:16}};
 const f={previous,target,bom,before,after,other,otherAfter,record,identity,reviewed,workloads:[before,other],calls:[]};replan(f);
 f.client=(args,options)=>{
  f.calls.push({args:[...args],capture:options?.capture});
  if(args[0]==='get'){
   if(args[1]==='configmap')return JSON.stringify(args[2]==='opensphere-installation-identity'?f.identity:f.record);
   return JSON.stringify({kind:'List',items:f.workloads});
  }
  assert.deepEqual(args,['apply','--dry-run=server','--validate=true','-f','-','-o','json'],'No operational write is allowed in this fixture');
  const request=JSON.parse(options.input);
  for(const item of request.items){const current=f.workloads.find(w=>w.kind===item.kind&&w.metadata.namespace===item.metadata.namespace&&w.metadata.name===item.metadata.name);item.metadata.uid=current.metadata.uid;item.metadata.resourceVersion=current.metadata.resourceVersion;}
  return JSON.stringify(request);
 };
 return f;
}
function replan(f){
 const plan={schema:f.reviewed.schema,clusterUid,installationId,installedReleaseDigest:f.reviewed.installedReleaseDigest,installedRecordUid:f.record.metadata.uid,installedRecordResourceVersion:f.record.metadata.resourceVersion,
  identityBinding:{uid:f.identity.metadata.uid,resourceVersion:f.identity.metadata.resourceVersion,contentSha256:sha(f.identity)},releaseDigest:f.target.releaseDigest,
  inputSha256:sha(f.reviewed),entries:[{object:{kind:'ConfigMap',metadata:{name:'opensphere-r2d2-runtime-policy'},data:{'preparation.json':JSON.stringify(f.reviewed)}}}]};
 plan.planDigest=sha(plan);f.prepared={all:[{yaml:JSON.stringify(f.after)},{yaml:JSON.stringify(f.otherAfter)}],foundation:{nativeRuntime:plan}};
}
function compare(f,nativeRecovery=false){return comparePreparedOwners(f.previous,f.target,f.prepared,{verifiedBom:{bom:f.bom,digest:f.target.releaseBom.digest},client:f.client,now,nativeRecovery});}
function interrupted(state='already-native'){
 const f=fixture(),first=compare(f),checkpoint=first.nativeCutoverCheckpoint;
 f.originalProof=checkpoint.proof;f.checkpoint=checkpoint;
 f.previous=structuredClone(f.target);f.record.metadata.resourceVersion='20';
 f.record.data['release.json']=JSON.stringify(f.target);
 f.record.data['state.json']=JSON.stringify({phase:'Failed',releaseDigest:f.target.releaseDigest,failureCode:'native-runtime-forward-repair-required',
  transition:{runId:'33333333-3333-4333-8333-333333333333',targetReleaseDigest:f.target.releaseDigest,rollback:'never',nativeCutoverCheckpoint:checkpoint}});
 f.workloads=[structuredClone(state==='already-native'?f.after:f.before),structuredClone(f.otherAfter)];
 f.workloads[0].metadata.resourceVersion='21';f.reviewed.installedReleaseDigest=f.target.releaseDigest;replan(f);f.calls=[];return f;
}
function changeState(f,fn){const s=JSON.parse(f.record.data['state.json']);fn(s);f.record.data['state.json']=JSON.stringify(s);}

test('initial legacy transition preserves its original thirteen-field proof and returns a bound persisted checkpoint',()=>{
 const f=fixture(),result=compare(f),c=result.nativeCutoverCheckpoint;
 assert.equal(result.status,'preserved');assert.equal(Object.keys(c.proof).length,13);
 assert.equal(c.proof.reviewedPolicyDigest,f.prepared.foundation.nativeRuntime.inputSha256);
 assert.equal(c.previousSourceRevision,f.previous.sourceRevision);assert.equal(c.sourceRevision,f.target.sourceRevision);
 assert.equal(c.targetBomDigest,f.target.releaseBom.digest);assert.equal(c.recordUid,f.record.metadata.uid);assert.equal(c.ownerUid,f.before.metadata.uid);
 assert.ok(f.calls.every(c=>c.args[0]==='get'||c.args.includes('--dry-run=server')));
});
for(const state of ['already-native','pending-legacy'])test('same exact failed target recovery accepts only its checkpoint-bound '+state+' shape',()=>{
 const f=interrupted(state),r=compare(f,true);assert.equal(r.status,'preserved');assert.equal(r.nativeRecoveryState,state);
 assert.deepEqual(r.nativeCutoverCheckpoint.proof,f.originalProof);assert.equal(f.workloads[0].spec.replicas,2);
 assert.ok(f.calls.every(c=>c.args[0]==='get'||c.args.includes('--dry-run=server')));
});
for(const[name,mutate]of[
 ['missing original checkpoint',f=>changeState(f,s=>delete s.transition.nativeCutoverCheckpoint)],
 ['untrusted checkpoint argument instead of trusted record',f=>{f.prepared.nativeCutoverCheckpoint=f.checkpoint;changeState(f,s=>delete s.transition.nativeCutoverCheckpoint);}],
 ['changed original source',f=>changeState(f,s=>s.transition.nativeCutoverCheckpoint.previousSourceRevision='f'.repeat(40))],
 ['changed target source',f=>{f.target.sourceRevision='e'.repeat(40);f.bom.sourceRevision=f.target.sourceRevision;f.bom.readinessProfile=readinessProfile('native-r2d2-cutover',f.target.sourceRevision);f.target.releaseBom={digest:calculateReleaseBomDigest(f.bom),readinessProfile:f.bom.readinessProfile};}],
 ['another signed target BOM',f=>{f.bom.publicChange='different';f.target.releaseBom.digest=calculateReleaseBomDigest(f.bom);}],
 ['another target or downgrade',f=>f.target.releaseDigest='sha256:'+'f'.repeat(64)],
 ['replaced installation record UID',f=>f.record.metadata.uid='foreign-record'],
 ['stale record version',f=>f.record.metadata.resourceVersion='10'],
 ['valid but stale preparation RV',f=>{const plan=f.prepared.foundation.nativeRuntime;plan.installedRecordResourceVersion='19';delete plan.planDigest;plan.planDigest=sha(plan);}],
 ['missing preparation RV',f=>{const plan=f.prepared.foundation.nativeRuntime;delete plan.installedRecordResourceVersion;delete plan.planDigest;plan.planDigest=sha(plan);}],
 ['changed immutable identity',f=>f.identity.data.installationId='44444444-4444-4444-8444-444444444444'],
 ['identity resourceVersion changed after planning',f=>f.identity.metadata.resourceVersion='99'],
 ['identity no longer immutable',f=>f.identity.immutable=false],
 ['changed capacity',f=>{f.reviewed.capacity.maxRuntimes=10;replan(f);}],
 ['changed native image',f=>f.target.components.r2d2OpenClawGateway.image=image('opensphere-console-r2d2-openclaw','e')],
 ['replaced C_AI UID',f=>f.workloads[0].metadata.uid='foreign-gateway'],
 ['privileged C_AI drift',f=>f.workloads[0].spec.template.spec.containers[0].securityContext={privileged:true}],
 ['other Owner privileged drift',f=>f.workloads[1].spec.template.spec.containers[0].securityContext={privileged:true}],
 ['other Owner replica reduction',f=>f.workloads[1].spec.replicas=3],
 ['mixed legacy/native shape',f=>f.workloads[0].spec.template.spec.containers.push({name:'hermes-worker',image:f.originalProof.previousWorkerImage})],
 ['Ready state disguised as recovery',f=>changeState(f,s=>s.phase='Ready')],
 ['rollback permission changed',f=>changeState(f,s=>s.transition.rollback='available')],
 ['unrecognized signed profile',f=>{f.target.releaseBom.readinessProfile={...f.target.releaseBom.readinessProfile,name:'native-recovery-bypass'};f.bom.readinessProfile=f.target.releaseBom.readinessProfile;f.target.releaseBom.digest=calculateReleaseBomDigest(f.bom);}],
])test('native recovery refuses '+name+' without operational writes',()=>{
 const f=interrupted();mutate(f);assert.throws(()=>compare(f,true));assert.ok(f.calls.every(c=>c.args[0]==='get'||c.args.includes('--dry-run=server')));
});
test('partial old shape with additional root authority is not the original transition',()=>{
 const f=interrupted('pending-legacy');f.workloads[0].spec.template.spec.serviceAccountName='admin';assert.throws(()=>compare(f,true));
});
test('same native profile cannot be silently reused by an ordinary upgrade',()=>{const f=interrupted();assert.throws(()=>compare(f,false));});
test('a record change during observation invalidates the exact recovery comparison',()=>{
 const f=interrupted(),client=f.client;let reads=0;f.client=(args,options)=>{if(args[0]==='get'&&args[2]==='opensphere-installation-lock'&&++reads===2)f.record.metadata.resourceVersion='21';return client(args,options);};
 assert.throws(()=>compare(f,true),/changed during render comparison/);
});

function upgradeFixture(){
 const f=fixture(),migration={globalId:'opensphere-console/20261022/0148',semanticKey:'console.r2d2.native_request_journal',predecessorGlobalId:'',
  sha256:'a'.repeat(64),sourceRevision:source,setDigest:'sha256:'+'e'.repeat(64),setSize:1};
 const manifest={schemaVersion:1,migrations:[migration]};
 const migrationArtifact={path:'migrations/manifest.json',sha256:'sha256:'+'e'.repeat(64),setDigest:migration.setDigest,latestGlobalId:migration.globalId,migrationCount:1};
 function lock(rev,char,legacy){
  const components=Object.fromEntries(Object.entries(COMPONENTS).map(([name,repository])=>[name,{repository,image:image(repository,char),sourceRevision:rev}]));
  if(legacy){delete components.r2d2OpenClawGateway;components.r2d2HermesWorker={repository:'opensphere-console-r2d2-hermes-worker',image:image('opensphere-console-r2d2-hermes-worker',char),sourceRevision:rev};}
  const auxiliaryArtifacts=Object.fromEntries(Object.entries(AUXILIARY_ARTIFACTS).map(([name,repository])=>[name,{repository,image:image(repository,char),sourceRevision:rev}]));
  // Version-shaped strings are synthetic fixture metadata, never BUILD issuance.
  if(!legacy)for(const artifact of Object.values({...components,...auxiliaryArtifacts}))artifact.artifactVersion='26.1023.2100.1';
  const bom={apiVersion:RELEASE_API_VERSION,kind:'OpenSphereReleaseBOM',channel:'edge',status:'Active',source:SOURCE,sourceRevision:rev,
   releaseTag:legacy?'202609020101':'26.1023.2100.1',supportedPlatforms:['linux/amd64','linux/arm64'],artifacts:{supabaseMigrationManifest:migrationArtifact},components,
   ...(!legacy?{auxiliaryArtifacts,readinessProfile:readinessProfile('native-r2d2-cutover',rev)}:{})};
  const pointer=releaseBomPointer(bom,undefined,{allowLegacyComponentSet:legacy}),release={apiVersion:RELEASE_API_VERSION,kind:'OpenSphereReleaseLock',channel:'edge',source:SOURCE,sourceRevision:rev,
   trust:RELEASE_TRUST,releaseBom:pointer,auxiliaryArtifacts,components};
  release.releaseDigest=calculateReleaseDigest('edge',components,RELEASE_TRUST,pointer,{auxiliaryArtifacts});return{release,bom};
 }
 f.previous=lock('b'.repeat(40),'a',true).release;const target=lock(source,'d',false);f.target=target.release;f.bom=target.bom;
 f.record.data['release.json']=JSON.stringify(f.previous);
 f.record.data['config.json']=JSON.stringify({architecture:'supabase-data-identity+gitea-change-authority',installationId,releaseDigest:f.previous.releaseDigest,
  storageClass:'hostpath',consoleUrl:'https://localhost:8090',authEnvironment:'development',initialAdmin:{username:'synthetic-admin'}});
 f.record.data['state.json']=JSON.stringify({phase:'Ready',releaseDigest:f.previous.releaseDigest,verification:{verifiedAt:new Date(now).toISOString()}});
 f.reviewed.installedReleaseDigest=f.previous.releaseDigest;replan(f);f.prepared.foundation.migration={manifest};
 f.ledger=[];f.events=[];f.failAt='';
 const inventory=[{apiVersion:'apps/v1',kind:'Deployment',namespace:'opensphere-console',name:'opensphere-console-osaa-gateway'},
  {apiVersion:'apps/v1',kind:'Deployment',namespace:'opensphere-console',name:'opensphere-console'}];
 f.runtime={
  verifyReleaseLock:async(release,options)=>{f.events.push('supply');if(release.releaseDigest===f.target.releaseDigest)options.onVerifiedBom({bom:f.bom,digest:f.target.releaseBom.digest});},
  readInstallationRecord:()=>structuredClone(f.record),readInstallationLock:()=>JSON.parse(f.record.data['release.json']),
  readInstallationConfig:()=>JSON.parse(f.record.data['config.json']),currentKubeContext:()=> 'synthetic-local-only',
  ownerPreservationClient:(args,options)=>f.client(args,options),preflight:()=>f.events.push('preflight'),
  ensureManagedNamespaces:()=>f.events.push('namespaces'),ensureRegistryPullSecrets:()=>f.events.push('registry'),
  prepareRelease:async()=>{f.events.push('prepare');return f.prepared;},
  readReleaseInventory:()=>inventory,releaseResourceInventory:()=>inventory,recordReleaseInventory:()=>f.events.push('inventory'),
  readBeszelBootstrapHistory:()=>null,readMigrationLedger:()=>f.ledger,
  readReleaseMigrationManifests:async()=>[manifest],
  recordInstallationState:(release,_sc,_admin,_url,_auth,_tls,phase,options={})=>{
   assert.deepEqual(options.recordPrecondition,{uid:f.record.metadata.uid,resourceVersion:f.record.metadata.resourceVersion},'The real transaction must keep its current record lease');
   f.record.data['release.json']=JSON.stringify(release);
   const cfg=JSON.parse(f.record.data['config.json']);cfg.releaseDigest=release.releaseDigest;f.record.data['config.json']=JSON.stringify(cfg);
   f.record.data['state.json']=JSON.stringify(installationStateDocument(phase,release,options));
   f.record.metadata.resourceVersion=String(BigInt(f.record.metadata.resourceVersion)+1n);f.events.push('record:'+phase);
   return{record:{uid:f.record.metadata.uid,resourceVersion:f.record.metadata.resourceVersion}};
  },
  installPreparedRelease:()=>{
   const checkpoint=JSON.parse(f.record.data['state.json']).transition?.nativeCutoverCheckpoint;
   assert.ok(checkpoint,'Original proof must be persisted in the first Installing record before apply can fail');
   f.events.push('install-target');
   if(f.failAt==='pending-legacy')throw Error('synthetic failure before target owner changed');
   f.workloads=[structuredClone(f.after),structuredClone(f.otherAfter)];f.workloads[0].metadata.resourceVersion='22';
   f.ledger=[[migration.globalId,migration.semanticKey,migration.predecessorGlobalId,migration.sha256,migration.sourceRevision,migration.setDigest,String(migration.setSize)]];
  },
  waitForCoreRollouts:()=>f.events.push('rollouts'),
  verifyInstallation:async release=>{if(f.failAt==='already-native')throw Error('synthetic final verification failure');return{releaseDigest:release.releaseDigest,verifiedAt:new Date(now).toISOString()};},
  pruneReleaseResources:()=>{f.events.push('prune');return[];},
 };
 return f;
}
for(const state of ['pending-legacy','already-native'])test('real upgrade transaction persists checkpoint before '+state+' failure and explicitly recovers the same target',async()=>{
 const f=upgradeFixture();f.failAt=state;
 await assert.rejects(upgrade(f.previous,f.target,{runtime:f.runtime}),/native-runtime-forward-repair-required/);
 const failed=JSON.parse(f.record.data['state.json']);assert.equal(failed.phase,'Failed');assert.equal(failed.transition.rollback,'never');
 assert.equal(failed.transition.outcome.rollbackAvailable,false);assert.ok(failed.transition.nativeCutoverCheckpoint);
 assert.ok(f.events.indexOf('record:Installing')<f.events.indexOf('install-target'));assert.equal(f.events.includes('prune'),false);
 f.previous=structuredClone(f.target);f.reviewed.installedReleaseDigest=f.target.releaseDigest;replan(f);
 f.prepared.foundation.migration={manifest:{schemaVersion:1,migrations:[{globalId:'opensphere-console/20261022/0148',semanticKey:'console.r2d2.native_request_journal',predecessorGlobalId:'',sha256:'a'.repeat(64),sourceRevision:source,setDigest:'sha256:'+'e'.repeat(64),setSize:1}]}};
 f.failAt='';const reviewedRecord=installationRecordDigest(f.record);
 const result=await upgrade(f.previous,f.target,{runtime:f.runtime,oneWayRecoveryRecordDigest:reviewedRecord});
 assert.equal(result.changed,true);assert.equal(JSON.parse(f.record.data['state.json']).phase,'Ready');
 assert.deepEqual(f.workloads[0].spec.template.spec.containers.map(c=>c.name),['gateway']);
 assert.equal(f.events.filter(e=>e==='install-target').length,2);assert.ok(f.events.every(e=>!e.includes('rollback')));
});
