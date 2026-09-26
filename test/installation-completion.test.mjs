import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {completeInstallationVerification} from '../src/bootstrap.mjs';
const lock=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url))).base;
function fixture(){
 const state={phase:'Failed',releaseDigest:lock.releaseDigest};
 const record={metadata:{uid:'original',resourceVersion:'1'},data:{'release.json':JSON.stringify(lock),
  'config.json':JSON.stringify({releaseDigest:lock.releaseDigest,storageClass:'standard',consoleUrl:'https://localhost:1114',authEnvironment:'development'}),
  'state.json':JSON.stringify(state)}};
 const phases=[];
 const runtime={readInstallationRecord:()=>structuredClone(record),readReleaseInventory:()=>[{kind:'Deployment'}],
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
 const runtime={readInstallationRecord:()=>structuredClone(record),readReleaseInventory:()=>[{kind:'Deployment'}],
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
