import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveInstallationRelease} from '../src/installation-release.mjs';
import {calculateReleaseDigest,validateLock} from '../src/release.mjs';
const {base}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
function resolved(){const lock=structuredClone(base);delete lock.knowledge;lock.releaseDigest=calculateReleaseDigest(lock.channel,lock.components,lock.trust,lock.releaseBom,lock);validateLock(lock);return lock;}
test('normal target resolution records the exact source Knowledge before its digest is persisted',async()=>{
 const source=resolved(),before=JSON.stringify(source),credential={fixture:true};let reads=0;
 const target=await resolveInstallationRelease('edge',{sourceArtifactCredential:credential,resolveChannelFn:async()=>source,
  readArtifact:async(lock,path,options)=>{reads++;assert.equal(lock,source);assert.equal(path,'apps/osaa-gateway/knowledge-bundle/lock.json');assert.equal(options.sourceRevision,source.components.osaaGateway.sourceRevision);assert.equal(options.sourceArtifactCredential,credential);return JSON.stringify(base.knowledge);}});
 assert.equal(reads,1);assert.equal(JSON.stringify(source),before);assert.deepEqual(target.knowledge,base.knowledge);
 assert.notEqual(target.releaseDigest,source.releaseDigest);assert.equal(target.releaseDigest,base.releaseDigest);validateLock(target);
});
test('missing, malformed or substituted source Knowledge cannot become an installed baseline',async()=>{
 for(const readArtifact of [async()=>{throw Error('source denied');},async()=>'{',async()=>' '.repeat(8193),async()=>JSON.stringify({...base.knowledge,source:'https://example.invalid'})])
  await assert.rejects(resolveInstallationRelease('edge',{resolveChannelFn:async()=>resolved(),readArtifact}));
});
test('an existing component lock is never silently normalized into a new installation target',async()=>{
 const {target}=JSON.parse(readFileSync(new URL('./fixtures/knowledge-release-v1.json',import.meta.url)));
 await assert.rejects(resolveInstallationRelease('edge',{resolveChannelFn:async()=>target,readArtifact:async()=>{throw Error('must not read');}}),/integrated target/);
});
