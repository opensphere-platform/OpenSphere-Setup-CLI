// Exact public lock metadata for the existing pre-native Shell installation.
// This is a read-only historical chain, never an installer/approval exception.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import capture from './captured-shell-release-history.cjs';
import {calculateReleaseDigest,isLocalEdgeLock,validateLock,verifyReleaseLock} from './release.mjs';
const stored=new WeakMap();
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const sha=value=>'sha256:'+createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
export function historicalLockBody(lock){const value=structuredClone(lock);for(const name of ['resolvedAt','localVerifiedAt','provenanceVerifiedAt','sbomVerifiedAt'])delete value[name];return stable(value);}
const shellNames=['cliArtifacts','osShellControl','osShellRuntime'];
const tip='sha256:7930a7d8d62d788208194a3a0ae6c12d6b68146c8a8cd4090b50f0615b569fae';
export function capturedShellReleaseChain(){
 assert.equal(capture.schema,'opensphere.captured-shell-release-history/v1');
 assert.equal(capture.locks.length,3);
 const chain=capture.locks.map(({raw,sha256})=>{
  assert.equal(sha(raw),sha256,'Captured historical Shell lock bytes changed');
  const lock=JSON.parse(raw);validateLock(lock,{allowLegacyComponentSet:true,allowInstalledAgentIdentityCutover:true});
  assert.ok(isLocalEdgeLock(lock)&&!lock.releaseBom,'Captured Shell history must retain its original local trust');
  assert.equal(calculateReleaseDigest(lock.channel,lock.components,lock.trust,lock.releaseBom,lock),lock.releaseDigest,'Captured historical Shell digest differs');
  return lock;
 });
 assert.equal(chain[2].releaseDigest,tip);
 assert.deepEqual(chain[0].changedComponents,[]);assert.deepEqual([...chain[0].changedAuxiliaryArtifacts].sort(),shellNames);
 for(let index=1;index<chain.length;index++){
  const before=chain[index-1],after=chain[index];
  assert.equal(after.baseReleaseDigest,before.releaseDigest,'Historical Shell chain is disconnected');
  assert.equal(after.releaseScope,'component');assert.deepEqual(after.changedComponents,['extensionController']);assert.deepEqual(after.changedAuxiliaryArtifacts,[]);
  // The two later records changed only C_EXT; all other governed payloads,
  // Knowledge and Shell authority must be inherited exactly.
  assert.equal(after.channel,before.channel);assert.deepEqual(after.trust,before.trust);
  assert.deepEqual(after.knowledge,before.knowledge);assert.deepEqual(after.auxiliaryArtifacts,before.auxiliaryArtifacts);
  const a=structuredClone(before.components),b=structuredClone(after.components);delete a.extensionController;delete b.extensionController;
  assert.deepEqual(a,b,'Historical update changed an unlisted component');
 }
 return chain;
}
// verify defaults to the same normal OCI verifier as the upgrade. An opaque
// handle is produced only after every captured image has been rechecked.
export async function verifyCapturedShellHistory(baseline,{verify=verifyReleaseLock,verificationOptions={}}={}){
 if(baseline.releaseDigest!==tip)return undefined;
 const chain=capturedShellReleaseChain();assert.deepEqual(historicalLockBody(baseline),historicalLockBody(chain.at(-1)),'Installed Shell history tip differs from the captured original');
 const verified=await Promise.all(chain.map(lock=>verify(lock,{...verificationOptions,allowLegacyComponentSet:true,allowInstalledAgentIdentityCutover:true})));
 for(let i=0;i<chain.length;i++){
  assert.deepEqual(historicalLockBody(verified[i]),historicalLockBody(chain[i]),'Normal verification changed historical Shell metadata');
  assert.ok(Number.isFinite(Date.parse(verified[i].localVerifiedAt??'')),'Historical Shell image verification did not complete');
 }
 const content={schema:capture.schema,rawLockHashes:capture.locks.map(lock=>lock.sha256),releaseDigests:chain.map(lock=>lock.releaseDigest),tipReleaseDigest:tip,
  originalReleaseDigest:chain[0].releaseDigest,shellArtifacts:Object.fromEntries(shellNames.map(name=>[name,chain[0].auxiliaryArtifacts[name]])),sources:capture.sources};
 const handle=Object.freeze({type:'opensphere.verified-shell-release-history/v1',historyEvidenceDigest:sha(content)});
 stored.set(handle,{...content,baselineBody:historicalLockBody(baseline)});return handle;
}
export function verifiedShellHistory(handle,baseline){
 const data=stored.get(handle);assert.ok(data,'Historical Shell verification handle is missing or untrusted');
 assert.deepEqual(data.baselineBody,historicalLockBody(baseline),'Historical Shell baseline changed');return structuredClone(data);
}
