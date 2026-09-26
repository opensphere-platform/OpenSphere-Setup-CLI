'use strict';
// CON-FR-007/018: a Knowledge component receipt is not fresh whole-Console health.
const {validateLock}=require('./knowledge-package.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^sha256:[a-f0-9]{64}$/;
const SCHEMA='opensphere.knowledge-installation/v1';
const same=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
function sort(v){return v&&typeof v==='object'?(Array.isArray(v)?v.map(sort):Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]))):v;}
function assert(ok){if(!ok)throw Object.assign(Error('Knowledge installation evidence is invalid'),{code:'ObservationChanged',status:409});}
function closed(v,keys){assert(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','));}
function timestamp(v){assert(typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);return Date.parse(v);}
function validateBootstrap(proof,lock){
 closed(proof,['scope','releaseDigest','verifiedAt','images','bootstrapJobComplete','agentPublicKeyPublished']);
 assert(proof.scope==='historical-beszel-bootstrap'&&HASH.test(proof.releaseDigest)&&proof.bootstrapJobComplete===true&&proof.agentPublicKeyPublished===true);
 timestamp(proof.verifiedAt);closed(proof.images,['beszelHub','beszelAgent','beszelBootstrap']);
 for(const key of Object.keys(proof.images))assert(proof.images[key]===lock.components[key]?.image&&/^ghcr\.io\/opensphere-platform\/[a-z0-9.-]+@sha256:[a-f0-9]{64}$/.test(proof.images[key]));
 return proof;
}
function validateDelivery({operationId,knowledge,delivery},now){
 assert(UUID.test(operationId||''));validateLock(knowledge);
 assert(delivery?.schema==='opensphere.knowledge-delivery/v1'&&delivery.operationId===operationId&&delivery.version===knowledge.version
  &&delivery.state==='Delivered'&&delivery.immutable===true&&delivery.readOnly===true
  &&Number.isSafeInteger(delivery.desiredPods)&&delivery.desiredPods>0&&delivery.readyPods===delivery.desiredPods
  &&delivery.activation==='NotObserved'&&delivery.semanticSearch==='NotObserved'&&delivery.installationLock==='NotPromoted');
 closed(delivery,['schema','operationId','version','state','readyPods','desiredPods','activation','semanticSearch','installationLock','observedAt','immutable','readOnly']);
 const at=timestamp(delivery.observedAt);if(now!==undefined)assert(Number.isFinite(now)&&now-at>=-10000&&now-at<=60000);
}
function validateObservations({operationId,knowledge,delivery,activation,semanticSearch},now){
 validateDelivery({operationId,knowledge,delivery},now);
 for(const [value,state] of [[activation,'Active'],[semanticSearch,'Verified']]){
  closed(value,['owner','operationId','version','sha256','state','observedAt']);
  assert(value.owner==='C_AI'&&value.operationId===operationId&&value.version===knowledge.version&&value.sha256===knowledge.sha256&&value.state===state);
 }
 for(const value of [delivery,activation,semanticSearch]){
  const at=timestamp(value.observedAt);
  if(now!==undefined)assert(Number.isFinite(now)&&now-at>=-10000&&now-at<=60000);
 }
}
function validateComponentEvidence(value,lock,state){
 closed(value,['schema','scope','runtimeState','operationId','releaseDigest','baseReleaseDigest','verifiedAt','knowledge','delivery','activation','semanticSearch','historicalBootstrap']);
 assert(value.schema===SCHEMA&&value.scope==='knowledge-component'&&value.runtimeState==='NotObserved'
  &&value.releaseDigest===lock.releaseDigest&&HASH.test(value.baseReleaseDigest)&&value.baseReleaseDigest!==value.releaseDigest
  &&same(value.knowledge,lock.knowledge));
 validateObservations(value,timestamp(value.verifiedAt));validateBootstrap(value.historicalBootstrap,lock);
 assert(Date.parse(value.historicalBootstrap.verifiedAt)<=Date.parse(value.verifiedAt));
 for(const observation of [value.delivery,value.activation,value.semanticSearch])assert(Date.parse(observation.observedAt)<=Date.parse(value.verifiedAt)+10000);
 if(state){
  assert(state.phase==='Ready'&&state.releaseDigest===lock.releaseDigest
   &&state.verification?.evidenceConfigMap==='opensphere-installation-evidence'
   &&state.verification.verifiedAt===value.verifiedAt&&state.verification.scope==='knowledge-component'
   &&state.verification.operationId===value.operationId);
 }
 return value;
}
function bootstrapProof(evidence,lock,state){
 if(evidence?.schema===SCHEMA)return structuredClone(validateComponentEvidence(evidence,lock,state).historicalBootstrap);
 assert(evidence?.schema===undefined);
 assert(state?.phase==='Ready'&&state.releaseDigest===lock.releaseDigest
  &&state.verification?.evidenceConfigMap==='opensphere-installation-evidence'&&state.verification.verifiedAt===evidence?.verifiedAt
  &&evidence.releaseDigest===lock.releaseDigest&&evidence.runtimeImagesMatchLock===true
  &&evidence.beszel?.bootstrapJobComplete===true&&evidence.beszel?.agentPublicKeyPublished===true);
 return validateBootstrap({scope:'historical-beszel-bootstrap',releaseDigest:lock.releaseDigest,verifiedAt:evidence.verifiedAt,
  images:Object.fromEntries(['beszelHub','beszelAgent','beszelBootstrap'].map(key=>[key,lock.components[key]?.image])),
  bootstrapJobComplete:true,agentPublicKeyPublished:true},lock);
}
// Re-review N3 (2026-09-26): one claim rule for the installation record, shared by Setup and Console
// Knowledge. A Knowledge release takes the record from an idle Ready base immediately before its
// first workload change and holds it (Installing + knowledgeUpdate + transition) until its own
// completion writes Ready. Setup starts an ordinary upgrade only from an idle Ready record, and a
// Knowledge release refuses a record another run holds. Nothing expires by time.
const TRANSITION='opensphere.knowledge-installation-transition/v1';
const evidenceSha256=v=>'sha256:'+require('node:crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
function isKnowledgeClaim(state){return Boolean(state?.knowledgeUpdate)||state?.transition?.mode==='knowledge';}
function ownsClaim(state,{base,target,operationId}){
 const u=state?.knowledgeUpdate;
 return u?.schema===TRANSITION&&u.operationId===operationId&&u.baseReleaseDigest===base.releaseDigest&&u.targetReleaseDigest===target.releaseDigest
  &&state.transition?.mode==='knowledge'&&state.transition.runId===operationId;
}
// 'free': idle Ready base; 'own': this operation's claim (base or promoted target, or its completed Ready); 'busy': anything else.
function claimStatus({installed,state,base,target,operationId}){
 const idle=!state?.transition&&!state?.knowledgeUpdate;
 if(same(installed,base)){
  if(state?.phase==='Ready'&&state.releaseDigest===base.releaseDigest&&idle)return 'free';
  return state?.phase==='Installing'&&state.releaseDigest===base.releaseDigest&&ownsClaim(state,{base,target,operationId})?'own':'busy';
 }
 if(same(installed,target)){
  if(state?.phase==='Installing'&&state.releaseDigest===target.releaseDigest&&ownsClaim(state,{base,target,operationId}))return 'own';
  if(state?.phase==='Ready'&&state.releaseDigest===target.releaseDigest&&idle
   &&state.verification?.scope==='knowledge-component'&&state.verification.operationId===operationId)return 'own';
 }
 return 'busy';
}
function claimedState(state,{base,target,operationId,proof,baseEvidence,now}){
 assert(state?.phase==='Ready'&&UUID.test(operationId||''));
 const claimed={...state,phase:'Installing',releaseDigest:base.releaseDigest,observedAt:now,
  knowledgeUpdate:{schema:TRANSITION,operationId,baseReleaseDigest:base.releaseDigest,targetReleaseDigest:target.releaseDigest,
   historicalBootstrap:proof,baseEvidenceSha256:evidenceSha256(baseEvidence)},
  transition:{runId:operationId,mode:'knowledge',previousReleaseDigest:base.releaseDigest,targetReleaseDigest:target.releaseDigest,
   previousState:'Ready',previousVerifiedAt:state.verification?.verifiedAt??null,startedAt:now,rollback:'knowledge-owner'}};
 delete claimed.verification;delete claimed.failureCode;
 return claimed;
}
module.exports={SCHEMA,TRANSITION,same,validateBootstrap,validateDelivery,validateObservations,validateComponentEvidence,bootstrapProof,
 evidenceSha256,isKnowledgeClaim,claimStatus,claimedState};
