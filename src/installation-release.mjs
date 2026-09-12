import {resolveChannel,validateLock,calculateReleaseDigest,isLocalEdgeLock} from './release.mjs';
import {fetchReleaseArtifact} from './bootstrap.mjs';
import knowledgePackage from './knowledge-package.cjs';
const PATH='apps/osaa-gateway/knowledge-bundle/lock.json';

// Newly resolved installation targets include the exact Gateway source's data
// baseline. Never normalize/re-hash the stored historical installation in place.
export async function resolveInstallationRelease(channel,options={}){
 const {resolveChannelFn=resolveChannel,readArtifact=fetchReleaseArtifact,...rest}=options;
 const lock=await resolveChannelFn(channel,rest);
 validateLock(lock);
 if(!isLocalEdgeLock(lock))return lock;
 if(lock.digestFormat!=='canonical-json-v1'||(lock.releaseScope&&lock.releaseScope!=='integrated'))throw Error('Knowledge baseline requires a newly resolved integrated target');
 const sourceRevision=lock.components.osaaGateway.sourceRevision;
 const raw=await readArtifact(lock,PATH,{sourceRevision,sourceArtifactCredential:options.sourceArtifactCredential});
 if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)throw Error('Knowledge baseline exceeds source read budget');
 const knowledge=knowledgePackage.validateLock(JSON.parse(raw));
 const target={...lock,knowledge};
 target.releaseDigest=calculateReleaseDigest(target.channel,target.components,target.trust,target.releaseBom,target);
 return validateLock(target);
}
