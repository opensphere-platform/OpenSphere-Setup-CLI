import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {validateLock,validateReleaseTransition,calculateReleaseDigest} from '../src/release.mjs';
import {componentReleaseWorkloadComponents,componentReleaseManifestSpecs} from '../src/bootstrap.mjs';
const {base,target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
const digest=lock=>calculateReleaseDigest(lock.channel,lock.components,lock.trust,lock.releaseBom,lock);
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;

test('Console canonical lock keeps its identity through reordered transport and Setup validation',()=>{
 for(const lock of [base,target]){
  assert.equal(lock.digestFormat,'canonical-json-v1');
  assert.equal(digest(reorder(lock)),lock.releaseDigest);
  assert.doesNotThrow(()=>validateLock(reorder(lock)));
  const unsupported={...lock,digestFormat:'invented'};
  assert.throws(()=>validateLock(unsupported),/format/);
  const removed={...lock};delete removed.digestFormat;
  assert.throws(()=>validateLock(removed),/digest/);
 }
 assert.doesNotThrow(()=>validateReleaseTransition(reorder(base),reorder(target)));
});
test('Setup accepts the Console producer fixture with exactly the same digest and no code image changes',()=>{
 assert.equal(digest(base),base.releaseDigest);assert.equal(digest(target),target.releaseDigest);
 assert.deepEqual(validateLock(base),base);assert.deepEqual(validateReleaseTransition(base,target),target);
 assert.deepEqual(target.components,base.components);assert.deepEqual(target.auxiliaryArtifacts,base.auxiliaryArtifacts);
 assert.deepEqual(componentReleaseWorkloadComponents(target),['osaaGateway']);
 const selected=componentReleaseManifestSpecs(target),specs=[...selected.foundation,...selected.base];
 assert.deepEqual(specs.map(x=>x.path),['apps/osaa-gateway/deploy.yaml']);
 assert.equal(specs[0].artifactSourceRevision,base.components.osaaGateway.sourceRevision);
});
test('independent Knowledge mutation cannot bypass executor transition validation',()=>{
 for(const mutate of [t=>{t.knowledge.sha256='0'.repeat(64);},t=>delete t.changedKnowledge,t=>delete t.knowledge,t=>{t.sourceRevision='c'.repeat(40);},t=>{t.knowledge.version='knowledge-v0.1.0-edge.5';},t=>{t.changedKnowledge=false;}]){
  const changed=structuredClone(target);mutate(changed);
  if(changed.knowledge?.sha256!=='0'.repeat(64))changed.releaseDigest=digest(changed);
  assert.throws(()=>validateReleaseTransition(base,changed));
 }
 const mutatedBase=structuredClone(base);mutatedBase.knowledge.sha256='0'.repeat(64);
 assert.throws(()=>validateReleaseTransition(mutatedBase,target),/digest/);
});
