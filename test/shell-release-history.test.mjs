// Historical metadata/source conformance only. These tests explicitly replace
// network inspection and do not claim OCI or operating acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseAllDocuments} from 'yaml';
import {capturedShellReleaseChain,verifyCapturedShellHistory,verifiedShellHistory,historicalLockBody} from '../src/shell-release-history.mjs';
import {fetchLocalNativeOwnerReferenceSources,bindLocalNativeOwnerReferenceViews} from '../src/owner-release-references.mjs';
import {assertOwnerReferenceRecoveryBinding} from '../src/owner-reference-checkpoint.mjs';
const sha=raw=>'sha256:'+createHash('sha256').update(raw.replace(/\r\n/g,'\n')).digest('hex');
const raw=(revision,path)=>process.env.OPENSPHERE_CONSOLE_SOURCE?execFileSync('git',['-C',process.env.OPENSPHERE_CONSOLE_SOURCE,'show',revision+':'+path],{encoding:'utf8'}):readFileSync(new URL('./fixtures/native-owner-preview-C3/'+path,import.meta.url),'utf8');
const inspected=async(lock)=>({...structuredClone(lock),localVerifiedAt:new Date().toISOString()});
test('three exact captured public originals form the unchanged Shell chain ending at7930',()=>{
 const chain=capturedShellReleaseChain();assert.equal(chain.length,3);assert.match(chain[0].releaseDigest,/^sha256:fa92/);assert.match(chain.at(-1).releaseDigest,/^sha256:7930/);
 assert.equal(chain[1].baseReleaseDigest,chain[0].releaseDigest);assert.equal(chain[2].baseReleaseDigest,chain[1].releaseDigest);
 assert.equal(chain[0].auxiliaryArtifacts.osShellControl.sourceRevision,'4b370b841c8843147ae14cfcb88eae504e267b1a');
 const changed=capturedShellReleaseChain();changed[0].components.console.sourceRevision='f'.repeat(40);assert.notDeepEqual(changed,capturedShellReleaseChain());
});
test('historical verification invokes normal verifier for each exact full lock, without trusting persisted flags',async()=>{
 const chain=capturedShellReleaseChain(),calls=[];
 const baseline={...chain.at(-1),localVerifiedAt:'2000-01-01T00:00:00.000Z'};
 const handle=await verifyCapturedShellHistory(baseline,{verify:async(lock,options)=>{calls.push({lock,options});return inspected(lock);}});
 assert.deepEqual(calls.map(call=>call.lock),chain);assert.ok(calls.every(call=>call.options.allowLegacyComponentSet&&call.options.allowInstalledAgentIdentityCutover));
 const proof=verifiedShellHistory(handle,baseline);assert.equal(proof.originalReleaseDigest,chain[0].releaseDigest);assert.equal(proof.rawLockHashes.length,3);
 assert.throws(()=>verifiedShellHistory({...handle},baseline),/missing or untrusted/);
 const changed=structuredClone(baseline);changed.components.console.sourceRevision='f'.repeat(40);assert.throws(()=>verifiedShellHistory(handle,changed),/baseline changed/);
});
test('wrong history tip body and incomplete or mutated verification are rejected',async()=>{
 const baseline=capturedShellReleaseChain().at(-1),changed=structuredClone(baseline);changed.sourceRevision='f'.repeat(40);let calls=0;
 await assert.rejects(verifyCapturedShellHistory(changed,{verify:async()=>{calls++;}}),/tip differs/);assert.equal(calls,0);
 await assert.rejects(verifyCapturedShellHistory(baseline,{verify:async lock=>({...lock})}),/did not complete/);
 await assert.rejects(verifyCapturedShellHistory(baseline,{verify:async lock=>({...await inspected(lock),sourceRevision:'f'.repeat(40)})}),/metadata/);
 const other={...baseline,releaseDigest:'sha256:'+'f'.repeat(64)};assert.equal(await verifyCapturedShellHistory(other,{verify:async()=>{calls++;}}),undefined);assert.equal(calls,0);
});
async function fixture(){
 const chain=capturedShellReleaseChain(),previous=chain.at(-1),target=structuredClone(previous);
 target.releaseDigest='sha256:'+'d'.repeat(64);target.sourceRevision='320e5031ad4ab1353daed82337a891dab5125fc4';target.releaseScope='integrated';
 target.components.r2d2OpenClawGateway={...target.components.osaaGateway,repository:'opensphere-console-r2d2-openclaw',image:'ghcr.io/opensphere-platform/opensphere-console-r2d2-openclaw@sha256:'+'d'.repeat(64)};delete target.components.r2d2HermesWorker;
 for(const name of ['osShellControl','osShellRuntime','cliArtifacts']){target.auxiliaryArtifacts[name].sourceRevision=target.sourceRevision;target.auxiliaryArtifacts[name].image=target.auxiliaryArtifacts[name].image.split('@')[0]+'@sha256:'+'d'.repeat(64);}
 const historicalShell=await verifyCapturedShellHistory(previous,{verify:inspected});
 const sources=await fetchLocalNativeOwnerReferenceSources(previous,target,async(lock,path,{sourceRevision})=>raw(sourceRevision,path),{historicalShell});
 const render=release=>{
  const revision=release.auxiliaryArtifacts.osShellControl.sourceRevision,source=raw(revision,'apps/os-shell-control/deploy.yaml');
  const replaces={__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__:release.auxiliaryArtifacts.osShellControl.image,__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__:release.auxiliaryArtifacts.osShellRuntime.image,
   __OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__:release.auxiliaryArtifacts.cliArtifacts.image.split('@')[1],__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__:sha(source),
   __OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__:sha(raw(revision,'apps/os-shell-control/runtime-template.js')),
   __OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__:`release://edge/${(release===previous?chain[0]:target).releaseDigest.slice(7)}/native-console-runtime`};
  let result=source;for(const [from,to]of Object.entries(replaces))result=result.replaceAll(from,to);
  return parseAllDocuments(result).map(doc=>doc.toJS()).filter(owner=>owner?.kind==='Deployment'&&owner.metadata.name.startsWith('opensphere-shell-'));
 };
 return {previous,target,sources,before:render(previous),after:render(target)};
}
test('only genuine historical fa92 traces bind to the exact new verified Shell tuple',async()=>{
 const f=await fixture();assert.equal(f.before.length,3);
 for(let i=0;i<3;i++){
  const before=structuredClone(f.before[i]),after=structuredClone(f.after[i]);
  const view=bindLocalNativeOwnerReferenceViews(before,after,{previousLock:f.previous,targetLock:f.target,sources:f.sources});
  assert.equal(view.evidence.length,6);assert.ok(view.evidence.some(entry=>entry.field.endsWith('OS_SHELL_RELEASE_EVIDENCE_REF')));
  for(const name of ['OS_SHELL_MANIFEST_SHA256','OS_SHELL_RUNTIME_TEMPLATE_REVISION']){
   const original=before.spec.template.spec.containers[0].env.find(entry=>entry.name===name);
   assert.deepEqual(view.before.spec.template.spec.containers[0].env.find(entry=>entry.name===name),original,'Source hash literals must not be normalized');
  }
 }
});
test('forged trace, wrong control image, source hash or template cannot use genuine history',async()=>{
 const f=await fixture();
 for(const change of [
  owner=>{owner.spec.template.spec.containers[0].env.find(entry=>entry.name==='OS_SHELL_RELEASE_EVIDENCE_REF').value='release://edge/'+'e'.repeat(64)+'/native-console-runtime';},
  owner=>{owner.spec.template.spec.containers[0].image=owner.spec.template.spec.containers[0].image.replace(/@sha256:.*/, '@sha256:'+'e'.repeat(64));},
  owner=>{owner.spec.template.spec.containers[0].env.find(entry=>entry.name==='OS_SHELL_MANIFEST_SHA256').value='sha256:'+'e'.repeat(64);},
 ]){const owner=structuredClone(f.before[0]);change(owner);assert.throws(()=>bindLocalNativeOwnerReferenceViews(owner,f.after[0],{previousLock:f.previous,targetLock:f.target,sources:f.sources}),/differs/);}
 const historicalShell=await verifyCapturedShellHistory(f.previous,{verify:inspected});
 await assert.rejects(fetchLocalNativeOwnerReferenceSources(f.previous,f.target,async(lock,path,{sourceRevision})=>raw(sourceRevision,path)+(path.endsWith('runtime-template.js')?'\n//changed':''),{historicalShell}),/source bytes differ/);
 assert.deepEqual(historicalLockBody(f.previous),historicalLockBody(capturedShellReleaseChain().at(-1)));
});
test('Shell recovery permits complete original or target states and refuses hybrid references',async()=>{
 const f=await fixture(),before=f.before[0],after=f.after[0];before.metadata.uid=after.metadata.uid='synthetic-shell-uid';
 const configuration=owner=>{const spec=structuredClone(owner.spec);delete spec.replicas;for(const c of spec.template.spec.containers)delete c.image;
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,stable(v[key])])):v;
  return 'sha256:'+createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex');};
 const plan={installationId:'synthetic-installation',clusterUid:'synthetic-cluster'},checkpoint={...plan,sourceEvidenceDigest:f.sources.sourceEvidenceDigest,historyEvidenceDigest:f.sources.historyEvidenceDigest,
  owners:[{identity:'Deployment/opensphere-console/'+before.metadata.name,uid:before.metadata.uid,beforeConfigurationDigest:configuration(before),afterConfigurationDigest:configuration(after)}]};
 const binding=(owner)=>assertOwnerReferenceRecoveryBinding(checkpoint,{sources:f.sources,plan,before:owner,after});
 assert.equal(binding(before),false);assert.equal(binding(after),true);
 const hybrid=structuredClone(after);hybrid.spec.template.spec.containers[0].env.find(entry=>entry.name==='OS_SHELL_RELEASE_EVIDENCE_REF').value=before.spec.template.spec.containers[0].env.find(entry=>entry.name==='OS_SHELL_RELEASE_EVIDENCE_REF').value;
 assert.throws(()=>binding(hybrid),/neither its original nor target/);
 const replacement=structuredClone(before);replacement.metadata.uid='different';assert.throws(()=>binding(replacement),/was replaced/);
 const changed=structuredClone(after);changed.spec.template.metadata.annotations={unreviewed:'changed'};assert.throws(()=>binding(changed),/neither its original nor target/);
});
