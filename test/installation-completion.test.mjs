import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completeInstallationVerification} from '../src/bootstrap.mjs';
const lock=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url))).base;
test('verification completion rebinds an existing source to current applied coordinates without capturing observed source',async()=>{
 const f=fixture();f.record.data['controller-source.json']='retained-source';let reads=0,readyOptions;
 const deployment={metadata:{uid:'current-uid',generation:2}};
 f.runtime.readControllerDeployment=()=>{reads++;return deployment;};
 const original=f.runtime.recordInstallationState;
 f.runtime.recordInstallationState=(...args)=>{if(args[6]==='Ready')readyOptions=args[7];return original(...args);};
 await completeInstallationVerification(lock,{runtime:f.runtime});
 assert.equal(reads,1);assert.equal(readyOptions.controllerDeployment,deployment);assert.equal(readyOptions.controllerSource,undefined);
});
test('missing deployment coordinates prevent source-bearing completion from reporting Ready',async()=>{
 const f=fixture();f.record.data['controller-source.json']='retained-source';
 f.runtime.readControllerDeployment=()=>{throw Error('CoordinatesUnavailable');};
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/CoordinatesUnavailable/);
 assert.deepEqual(f.phases,['Installing','Failed']);
});
function fixture(){
 const state={phase:'Failed',releaseDigest:lock.releaseDigest};
 const record={metadata:{uid:'original',resourceVersion:'1'},data:{'release.json':JSON.stringify(lock),
  'config.json':JSON.stringify({releaseDigest:lock.releaseDigest,storageClass:'standard',consoleUrl:'https://localhost:1114',authEnvironment:'development'}),
  'state.json':JSON.stringify(state)}};
 const phases=[];
 const runtime={readInstallationRecord:()=>structuredClone(record),readReleaseInventory:()=>[{kind:'Deployment'}],
  readBeszelBootstrapHistory:()=>null,
  recordInstallationState:(_lock,_sc,_admin,_url,_env,_tls,phase,options)=>{
   assert.deepEqual(options.recordPrecondition,record.metadata);
   phases.push(phase);record.metadata.resourceVersion=String(+record.metadata.resourceVersion+1);
   record.data['state.json']=JSON.stringify({...state,phase});
   return {state:JSON.parse(record.data['state.json']),config:JSON.parse(record.data['config.json'])};
  },
  verifyInstallation:async supplied=>{assert.equal(supplied.releaseDigest,lock.releaseDigest);assert.equal(phases.at(-1),'Installing');return {releaseDigest:lock.releaseDigest,verifiedAt:'2026-09-12T14:00:00Z'};}};
 return {record,phases,runtime};
}
test('completion uses the installed release and records Ready only after verification',async()=>{
 const f=fixture();await completeInstallationVerification(lock,{runtime:f.runtime});
 assert.deepEqual(f.phases,['Installing','Ready']);
});
test('verification failure stays Failed and never reapplies resources',async()=>{
 const f=fixture();f.runtime.verifyInstallation=async()=>{throw Error('actual image mismatch');};
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/actual image mismatch/);
 assert.deepEqual(f.phases,['Installing','Failed']);
});
test('a different verified release cannot complete the installation',async()=>{
 const f=fixture();f.runtime.verifyInstallation=async()=>({releaseDigest:'different',verifiedAt:'2026-09-12T14:00:00Z'});
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/different release/);
 assert.deepEqual(f.phases,['Installing','Failed']);
});
test('missing inventory, replaced lock and changed endpoint fail before any state write',async()=>{
 for(const mutate of [f=>{f.runtime.readReleaseInventory=()=>null;},f=>{f.record.data['release.json']=JSON.stringify({...lock,releaseDigest:'different'});}]){
  const f=fixture();mutate(f);await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}));assert.deepEqual(f.phases,[]);
 }
 const f=fixture();await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime,consoleUrl:'https://other.example'}));assert.deepEqual(f.phases,[]);
});
test('another installation writer cannot be overwritten after verification',async()=>{
 const f=fixture();f.runtime.verifyInstallation=async()=>{f.record.metadata.uid='replacement';return {releaseDigest:lock.releaseDigest,verifiedAt:'2026-09-12T14:00:00Z'};};
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/ownership changed/);
 assert.deepEqual(f.phases,['Installing']);
});
test('a concurrent same-UID configuration update cannot be adopted and overwritten',async()=>{
 const f=fixture();f.runtime.verifyInstallation=async()=>{
  f.record.metadata.resourceVersion='99';f.record.data['config.json']=JSON.stringify({changedByAnotherWriter:true});
  return {releaseDigest:lock.releaseDigest,verifiedAt:'2026-09-12T14:00:00Z'};
 };
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/changed during verification/);
 assert.deepEqual(f.phases,['Installing']);assert.equal(JSON.parse(f.record.data['config.json']).changedByAnotherWriter,true);
});
// 2026-09-27 localhost case 2c: the installed pre-worker record (18 components) could not be
// completed or even verified; validateLock rejected it as a non-canonical component set.
test('a pre-worker installed record completes, verified as the installed release',async()=>{
 const {calculateReleaseDigest,validateLock}=await import('../src/release.mjs');
 const pre=structuredClone(lock);delete pre.components.r2d2HermesWorker;
 pre.releaseDigest=calculateReleaseDigest(pre.channel,pre.components,pre.trust,pre.releaseBom,pre);
 assert.throws(()=>validateLock(pre),/not canonical/);
 const state={phase:'Installing',releaseDigest:pre.releaseDigest};
 const record={metadata:{uid:'original',resourceVersion:'1'},data:{'release.json':JSON.stringify(pre),
  'config.json':JSON.stringify({releaseDigest:pre.releaseDigest,storageClass:'standard',consoleUrl:'https://localhost:1114',authEnvironment:'development'}),
  'state.json':JSON.stringify(state)}};
 const phases=[],modes=[];
 const runtime={readInstallationRecord:()=>structuredClone(record),readReleaseInventory:()=>[{kind:'Deployment'}],readBeszelBootstrapHistory:()=>null,
  recordInstallationState:(_l,_sc,_a,_u,_e,_t,phase)=>{phases.push(phase);record.metadata.resourceVersion=String(+record.metadata.resourceVersion+1);
   record.data['state.json']=JSON.stringify({...state,phase});return {state:JSON.parse(record.data['state.json']),config:JSON.parse(record.data['config.json'])};},
  verifyInstallation:async(supplied,options)=>{modes.push(options.mode);return {releaseDigest:supplied.releaseDigest,verifiedAt:'2026-09-27T00:00:00Z'};}};
 await completeInstallationVerification(pre,{runtime});
 assert.deepEqual(phases,['Installing','Ready']);assert.deepEqual(modes,['installed']);
});
test('installation verification refuses an unknown mode before reading the cluster',async()=>{
 const {verifyInstallation}=await import('../src/verify.mjs');
 await assert.rejects(verifyInstallation(lock,{mode:'lenient'}),/Unsupported installation verification mode: lenient/);
});

// 2026-09-27 localhost case 2c: after an upgrade claim stopped, completion lost the only binding to
// the pre-claim verification (the bootstrap Job is deleted a day after it finishes).
test('completion binds the bootstrap proof through the pre-claim verification and keeps the transition until Ready',async()=>{
 const transition={runId:'b19681d0-97fe-4221-b15d-7394047b6e3d',mode:'upgrade',previousReleaseDigest:lock.releaseDigest,previousState:'Ready',
  previousVerifiedAt:'2026-09-19T21:23:02.522Z',targetReleaseDigest:'sha256:'+'b'.repeat(64)};
 for(const outcome of ['Ready','Failed']){
  const state={phase:'Installing',releaseDigest:lock.releaseDigest,transition};
  const record={metadata:{uid:'original',resourceVersion:'1'},data:{'release.json':JSON.stringify(lock),
   'config.json':JSON.stringify({releaseDigest:lock.releaseDigest,storageClass:'standard',consoleUrl:'https://localhost:1114',authEnvironment:'development'}),
   'state.json':JSON.stringify(state)}};
  const handle=Object.freeze({scope:'historical-beszel-bootstrap'}),writes=[],seen=[];
  const runtime={readInstallationRecord:()=>structuredClone(record),readReleaseInventory:()=>[{kind:'Deployment'}],
   readBeszelBootstrapHistory:supplied=>{assert.equal(writes.length,0,'read before any write');assert.equal(supplied.releaseDigest,lock.releaseDigest);return handle;},
   recordInstallationState:(_l,_sc,_a,_u,_e,_t,phase,options)=>{writes.push({phase,transition:options.transition?.runId??null});
    record.metadata.resourceVersion=String(+record.metadata.resourceVersion+1);
    const next={phase,releaseDigest:lock.releaseDigest,...(options.transition?{transition:options.transition}:{})};
    record.data['state.json']=JSON.stringify(next);return {state:next,config:JSON.parse(record.data['config.json'])};},
   verifyInstallation:async(supplied,options)=>{seen.push(options.bootstrapHistory);
    if(outcome==='Failed')throw Error('actual image mismatch');return {releaseDigest:supplied.releaseDigest,verifiedAt:'2026-09-27T00:00:00Z'};}};
  const run=completeInstallationVerification(lock,{runtime});
  if(outcome==='Failed')await assert.rejects(run,/actual image mismatch/);else await run;
  assert.equal(seen[0],handle);
  assert.deepEqual(writes,outcome==='Ready'?[{phase:'Installing',transition:transition.runId},{phase:'Ready',transition:null}]
   :[{phase:'Installing',transition:transition.runId},{phase:'Failed',transition:transition.runId}]);
 }
});
test('only an interrupted claim of the same, previously verified release yields the pre-claim state',async()=>{
 const {verifiedStateBeforeClaim}=await import('../src/verify.mjs');
 const transition={previousState:'Ready',previousReleaseDigest:lock.releaseDigest,previousVerifiedAt:'2026-09-19T21:23:02.522Z'};
 assert.deepEqual(verifiedStateBeforeClaim({phase:'Installing',releaseDigest:lock.releaseDigest,transition},lock),
  {phase:'Ready',releaseDigest:lock.releaseDigest,verification:{evidenceConfigMap:'opensphere-installation-evidence',verifiedAt:transition.previousVerifiedAt}});
 for(const state of [
  {phase:'Ready',releaseDigest:lock.releaseDigest,transition},
  {phase:'Preparing',releaseDigest:lock.releaseDigest,transition},
  {phase:'Installing',releaseDigest:'sha256:'+'c'.repeat(64),transition},
  {phase:'Installing',releaseDigest:lock.releaseDigest,transition:{...transition,previousState:'Failed'}},
  {phase:'Installing',releaseDigest:lock.releaseDigest,transition:{...transition,previousReleaseDigest:'sha256:'+'c'.repeat(64)}},
  {phase:'Installing',releaseDigest:lock.releaseDigest,transition:{...transition,previousVerifiedAt:null}},
  {phase:'Failed',releaseDigest:lock.releaseDigest},
 ]) assert.equal(verifiedStateBeforeClaim(state,lock),state);
});

// A later component upgrade may fail before changing any workload, although the baseline already
// includes the 0080 cutover. Its old Ready installation is completed only with source + full ledger
// proof, never by trusting committedAtStart or observing one matching semantic key.
const historicalCutover={globalId:'opensphere-console/20260924/0080',semanticKey:'console.osdst.task_engine_cutover',
 predecessorGlobalId:'',sha256:'8'.repeat(64),sourceRevision:'a'.repeat(40),setDigest:'sha256:'+'b'.repeat(64),setSize:1};
const historicalAfter={...historicalCutover,globalId:'opensphere-console/20260924/0081',semanticKey:'console.fixture.after_cutover',
 predecessorGlobalId:historicalCutover.globalId,sha256:'9'.repeat(64),setSize:2};
const historicalManifest={schemaVersion:1,migrations:[historicalCutover,historicalAfter]};
const migrationRow=e=>[e.globalId,e.semanticKey,e.predecessorGlobalId,e.sha256,e.sourceRevision,e.setDigest,String(e.setSize)];
function historicalFixture(){
 const f=fixture();const transition={runId:'b19681d0-97fe-4221-b15d-7394047b6e3d',mode:'upgrade',previousReleaseDigest:lock.releaseDigest,
  previousState:'Ready',previousVerifiedAt:'2026-10-20T00:00:00Z',targetReleaseDigest:'sha256:'+'e'.repeat(64),
  oneWay:{migrations:[{globalId:historicalCutover.globalId,semanticKey:historicalCutover.semanticKey}],committedAtStart:[historicalCutover.globalId]}};
 f.record.data['state.json']=JSON.stringify({phase:'Installing',releaseDigest:lock.releaseDigest,transition});
 f.rows=historicalManifest.migrations.map(migrationRow);f.sourceReads=[];f.ledgerReads=0;f.verifyCalls=0;
 f.runtime.readMigrationLedger=()=>{f.ledgerReads++;return structuredClone(f.rows);};
 f.runtime.readRollbackMigrationChain=async(supplied,options)=>{assert.equal(supplied,lock);f.sourceReads.push(options);return structuredClone(historicalManifest);};
 f.runtime.readReleaseMigrationManifests=async(supplied,options)=>{assert.equal(supplied,lock);f.sourceReads.push(options);return [structuredClone(historicalManifest)];};
 const write=f.runtime.recordInstallationState;
 f.runtime.recordInstallationState=(...args)=>{const result=write(...args);if(args[7].transition)result.state.transition=args[7].transition;
  f.record.data['state.json']=JSON.stringify(result.state);return result;};
 const verify=f.runtime.verifyInstallation;
 f.runtime.verifyInstallation=async(...args)=>{f.verifyCalls++;return verify(...args);};
 f.transition=transition;f.setTransition=()=>{f.record.data['state.json']=JSON.stringify({phase:'Installing',releaseDigest:lock.releaseDigest,transition});};
 return f;
}
test('historical cutover completion verifies the baseline and every owner source, rechecks all ledger columns and retains CAS',async()=>{
 const f=historicalFixture(),credential=Object.freeze({type:'synthetic-read-handle'});
 await completeInstallationVerification(lock,{sourceArtifactCredential:credential,runtime:f.runtime});
 assert.deepEqual(f.sourceReads,[{sourceArtifactCredential:credential},{sourceArtifactCredential:credential}]);
 assert.equal(f.ledgerReads,4);assert.equal(f.verifyCalls,1);assert.deepEqual(f.phases,['Installing','Ready']);
 assert.equal(JSON.parse(f.record.data['state.json']).transition,undefined);
});
test('historical proof refuses every changed ledger column, lost/ahead rows and malformed answers before writes',async()=>{
 const mutations=[...Array.from({length:7},(_,index)=>f=>{f.rows[0][index]+='changed';}),
  f=>{f.rows.pop();},f=>{f.rows.push(migrationRow({...historicalAfter,globalId:'later'}));},
  f=>{f.rows=[['unreadable']];},f=>{f.runtime.readMigrationLedger=()=>{throw Error('unavailable');};}];
 for(const mutate of mutations){const f=historicalFixture();mutate(f);
  await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/Strict historical baseline proof/);
  assert.deepEqual(f.phases,[]);assert.equal(f.verifyCalls,0);}
});
test('committedAtStart cannot grant completion for new, duplicate, unknown or mismatched cutovers',async()=>{
 for(const mutate of [f=>{f.transition.oneWay.committedAtStart=[];},
  f=>{f.transition.oneWay.committedAtStart.push(historicalCutover.globalId);},
  f=>{f.transition.oneWay.committedAtStart=['unknown'];},
  f=>{f.transition.oneWay.migrations.push({...f.transition.oneWay.migrations[0]});},
  f=>{f.transition.oneWay.migrations[0].globalId='unknown';f.transition.oneWay.committedAtStart=['unknown'];},
  f=>{f.transition.oneWay.migrations[0].semanticKey='unknown';},
  f=>{f.transition.previousReleaseDigest='different';},f=>{f.transition.previousState='Failed';},
  f=>{f.transition.previousVerifiedAt=null;},f=>{f.transition.previousVerifiedAt=1;},f=>{f.transition.mode='one-way-recovery';}]){
  const f=historicalFixture();mutate(f);f.setTransition();
  await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/Strict historical baseline proof/);
  assert.deepEqual(f.phases,[]);assert.equal(f.verifyCalls,0);
 }
});
test('missing or incompatible immutable source proof never completes a historical baseline',async()=>{
 for(const mutate of [f=>{f.runtime.readRollbackMigrationChain=async()=>{throw Error('source unavailable');};},
  f=>{f.runtime.readReleaseMigrationManifests=async()=>[];},
  f=>{f.runtime.readReleaseMigrationManifests=async()=>[{schemaVersion:1,migrations:[historicalAfter]}];},
  f=>{f.runtime.readReleaseMigrationManifests=async()=>[{schemaVersion:1,migrations:[{...historicalCutover,sha256:'different'}]}];},
  f=>{f.runtime.readReleaseMigrationManifests=async()=>[historicalManifest,{schemaVersion:1,migrations:[historicalAfter]}];},
  f=>{f.runtime.readRollbackMigrationChain=async()=>({schemaVersion:1,migrations:[historicalAfter]});}]){
  const f=historicalFixture();mutate(f);
  await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/Strict historical baseline proof/);
  assert.deepEqual(f.phases,[]);assert.equal(f.verifyCalls,0);
 }
});
test('ledger drift during source reads, before verification or before Ready is not accepted',async()=>{
 for(const stage of [2,3,4]){const f=historicalFixture();const read=f.runtime.readMigrationLedger;
  f.runtime.readMigrationLedger=()=>{if(f.ledgerReads+1===stage)f.rows[0][3]='changed';return read();};
  await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/Strict historical baseline proof/);
  assert.deepEqual(f.phases,stage===2?[]:['Installing','Failed']);
  assert.equal(f.verifyCalls,stage===4?1:0);
  if(stage!==2)assert.equal(JSON.parse(f.record.data['state.json']).transition.runId,f.transition.runId);
 }
});
test('concurrent record change while reading historical source proof remains protected by UID/RV CAS',async()=>{
 const f=historicalFixture();f.runtime.readRollbackMigrationChain=async()=>{f.record.metadata.resourceVersion='99';return historicalManifest;};
 await assert.rejects(completeInstallationVerification(lock,{runtime:f.runtime}),/changed during verification completion/);
 assert.deepEqual(f.phases,[]);assert.equal(f.verifyCalls,0);
});
