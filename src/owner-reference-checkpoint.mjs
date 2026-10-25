// Public release/reference evidence in Setup's existing CAS-owned transition.
// A hash checkpoint is not a signature or independent administrator approval.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isLocalEdgeLock,validateLock} from './release.mjs';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const sha=value=>'sha256:'+createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const schema='opensphere.local-native-owner-reference-checkpoint/v1';
const gitea='Deployment/opensphere-console-change/opensphere-gitea';
const shell=id=>/^Deployment\/opensphere-console\/opensphere-shell-(api|gateway|reconciler)$/.test(id);
const identity=owner=>`${owner.kind}/${owner.metadata?.namespace}/${owner.metadata?.name}`;
const configuration=owner=>{const spec=structuredClone(owner.spec);delete spec.replicas;for(const container of spec.template.spec.containers)delete container.image;return sha(spec);};
function keys(value,expected){assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Owner reference checkpoint is missing');assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),'Owner reference checkpoint shape differs');}
export function captureOwnerReferenceCheckpoint({previousLock,targetLock,record,plan,evidence}){
 assert.ok(isLocalEdgeLock(previousLock)&&isLocalEdgeLock(targetLock)&&!previousLock.releaseBom&&!targetLock.releaseBom,'Owner reference checkpoint preserves local trust');
 assert.equal(JSON.parse(record.data['release.json']).releaseDigest,previousLock.releaseDigest);
 assert.equal(plan.installedRecordUid,record.metadata.uid);assert.equal(plan.installedRecordResourceVersion,record.metadata.resourceVersion);
 assert.equal(plan.installationId,JSON.parse(record.data['config.json']).installationId);
 assert.ok(evidence.owners.length>0,'Owner reference checkpoint cannot capture an empty binding');
 const content={schema,previousLock:structuredClone(previousLock),targetReleaseDigest:targetLock.releaseDigest,targetSourceRevision:targetLock.sourceRevision,
  recordUid:record.metadata.uid,initialRecordResourceVersion:record.metadata.resourceVersion,installationId:plan.installationId,clusterUid:plan.clusterUid,
  sourceEvidenceDigest:evidence.sourceEvidenceDigest,historyEvidenceDigest:evidence.historyEvidenceDigest??null,owners:structuredClone(evidence.owners)};
 return {...content,checkpointDigest:sha(content)};
}
export function readOwnerReferenceRecovery(record,targetLock){
 const state=JSON.parse(record.data?.['state.json']??'null'),checkpoint=state?.transition?.ownerReferenceCheckpoint;
 if(!checkpoint)return undefined;
 keys(checkpoint,['schema','previousLock','targetReleaseDigest','targetSourceRevision','recordUid','initialRecordResourceVersion','installationId','clusterUid','sourceEvidenceDigest','historyEvidenceDigest','owners','checkpointDigest']);
 const {checkpointDigest,...content}=checkpoint;assert.equal(checkpointDigest,sha(content),'Owner reference recovery checkpoint changed');assert.equal(checkpoint.schema,schema);
 assert.ok(['Failed','Installing'].includes(state.phase),'Owner reference recovery requires an incomplete transition');
 assert.equal(state.transition.rollback,'never');assert.equal(state.transition.targetReleaseDigest,targetLock.releaseDigest);
 assert.equal(checkpoint.targetReleaseDigest,targetLock.releaseDigest);assert.equal(checkpoint.targetSourceRevision,targetLock.sourceRevision);
 assert.equal(checkpoint.recordUid,record.metadata.uid,'Owner reference installation record was replaced');
 assert.match(record.metadata.resourceVersion??'',/^[0-9]+$/);assert.match(checkpoint.initialRecordResourceVersion??'',/^[0-9]+$/);
 assert.ok(BigInt(record.metadata.resourceVersion)>BigInt(checkpoint.initialRecordResourceVersion),'Owner reference recovery record is stale');
 assert.equal(checkpoint.installationId,JSON.parse(record.data['config.json']).installationId);
 assert.match(checkpoint.clusterUid??'',/^[a-f0-9-]{36}$/);
 const previous=validateLock(checkpoint.previousLock,{allowLegacyComponentSet:true,allowInstalledAgentIdentityCutover:true});
 assert.ok(isLocalEdgeLock(previous)&&isLocalEdgeLock(targetLock)&&!previous.releaseBom&&!targetLock.releaseBom,'Owner reference recovery cannot change trust');
 assert.ok([previous.releaseDigest,targetLock.releaseDigest].includes(JSON.parse(record.data['release.json']).releaseDigest),'Owner reference recovery installed lock differs');
 const originalNative=state.transition.nativeCutoverCheckpoint??state.transition.nativeMaintenanceCheckpoint;
 assert.equal(originalNative?.proof?.installedReleaseDigest,previous.releaseDigest,'Owner reference recovery lost its original native boundary');
 assert.ok(targetLock.components.r2d2OpenClawGateway&&Array.isArray(checkpoint.owners)&&checkpoint.owners.length>0);
 assert.equal(new Set(checkpoint.owners.map(owner=>owner.identity)).size,checkpoint.owners.length,'Owner reference recovery duplicates an Owner');
 for(const owner of checkpoint.owners){
  keys(owner,['identity','uid','beforeConfigurationDigest','afterConfigurationDigest','references']);assert.ok(owner.uid&&typeof owner.identity==='string');
  for(const name of ['beforeConfigurationDigest','afterConfigurationDigest'])assert.match(owner[name]??'',/^sha256:[a-f0-9]{64}$/);
  assert.ok(Array.isArray(owner.references)&&owner.references.length>0);
 }
 return checkpoint;
}
export function assertOwnerReferenceRecoveryBinding(checkpoint,{sources,plan,before,after}){
 assert.equal(sources.sourceEvidenceDigest,checkpoint.sourceEvidenceDigest,'Owner reference recovery source evidence changed');
 assert.equal(sources.historyEvidenceDigest??null,checkpoint.historyEvidenceDigest,'Owner reference recovery history changed');
 assert.equal(plan.installationId,checkpoint.installationId);assert.equal(plan.clusterUid,checkpoint.clusterUid);
 const row=checkpoint.owners.find(owner=>owner.identity===identity(before));
 if(!row)return false;
 assert.equal(row.uid,before.metadata.uid,'Owner reference recovery workload was replaced');
 if(shell(row.identity)){
  // Each Shell apply is atomic. Only an original complete before/target state
  // is resumable; a hybrid set of otherwise known trace/source refs is not.
  assert.ok([row.beforeConfigurationDigest,row.afterConfigurationDigest].includes(configuration(before)),'Shell recovery is neither its original nor target configuration');
  assert.equal(configuration(after),row.afterConfigurationDigest,'Shell recovery target configuration changed');
  return configuration(before)===row.afterConfigurationDigest;
 }
 return false;
}
export function isCheckpointedStagedGitea(owner,checkpoint,targetLock){
 if(identity(owner)!==gitea||owner.spec?.replicas!==0||!checkpoint)return false;
 const row=checkpoint.owners.find(item=>item.identity===gitea);assert.ok(row,'Staged Gitea recovery lacks its original Owner checkpoint');
 assert.equal(owner.metadata.uid,row.uid,'Staged Gitea recovery workload was replaced');
 assert.deepEqual(owner.spec.template.spec.containers.map(container=>[container.name,container.image]),[['gitea',targetLock.components.gitea.image]],'Staged Gitea does not contain the exact target artifact');
 assert.equal(configuration(owner),row.afterConfigurationDigest,'Staged Gitea differs from the source-verified target state');
 return true;
}
export function stagedGiteaRecoveryObservation(checkpoint,workloads){
 const row=workloads.find(owner=>`${owner.kind}/${owner.namespace}/${owner.name}`===gitea&&owner.replicas===0);
 if(!row)return undefined;
 assert.ok(checkpoint.owners.some(owner=>owner.identity===gitea&&owner.uid===row.uid));
 return {identity:gitea,uid:row.uid,resourceVersion:row.resourceVersion,checkpointDigest:checkpoint.checkpointDigest};
}
