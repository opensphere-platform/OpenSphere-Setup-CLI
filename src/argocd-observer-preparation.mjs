#!/usr/bin/env node
// Dedicated Setup entry point. It never loosens the historical localhost Core
// preparation guard or runs a caller-supplied script/manifest/credential.
import {readFileSync,realpathSync,lstatSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,relative,sep,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isSea,getAsset} from 'node:sea';

export const ARGO_OBSERVER_ASSET_MANIFEST_SHA256='d76e47ecd118949b25efd1c57fd6654231c6f82275e1309b0803ed57644cb351';
const assetRoot=resolve(import.meta.dirname,'../vendor/argocd-observer');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyArgocdObserverAssets(root=assetRoot){
 const embedded=isSea()&&root===assetRoot;
 const real=embedded?null:realpathSync(root),bytes=embedded?Buffer.from(getAsset('argocd-observer/manifest.json')):readFileSync(resolve(real,'manifest.json'));
 if(sha(bytes)!==ARGO_OBSERVER_ASSET_MANIFEST_SHA256)throw Error('Argo observer Setup asset manifest differs from the pinned release');
 const manifest=JSON.parse(bytes);
 if(manifest.schema!=='opensphere.setup.argocd-observer-assets/v1'||Object.keys(manifest.files||{}).length!==11)throw Error('Argo observer Setup asset envelope is invalid');
 for(const [name,digest]of Object.entries(manifest.files)){
  if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.split('/').some(p=>!p||p==='..'||p==='.')||!/^([a-f0-9]{64})$/.test(digest))throw Error('Argo observer Setup asset identity is invalid');
  if(embedded){if(sha(Buffer.from(getAsset('argocd-observer/'+name)))!==digest)throw Error('Argo observer embedded Setup asset integrity failed');}
  else{const file=resolve(real,name),actual=realpathSync(file),rel=relative(real,actual);if(lstatSync(file).isSymbolicLink()||rel.startsWith('..'+sep)||rel==='..'||sha(readFileSync(actual))!==digest)throw Error('Argo observer Setup asset integrity failed');}
 }
 if(sha(JSON.stringify(manifest.files))!==manifest.sourceTreeSha256)throw Error('Argo observer Setup source snapshot digest failed');
 return {schema:manifest.schema,sourceRepository:manifest.sourceRepository,sourceRevision:manifest.sourceRevision,sourceTreeSha256:manifest.sourceTreeSha256,fileCount:11};
}
export function runArgocdObserverPreparation(argv,{load}={}){
 const assets=verifyArgocdObserverAssets();
 let temporary,root=assetRoot;
 try{
  if(isSea()&&!load){
   temporary=mkdtempSync(join(tmpdir(),'opensphere-verified-observer-code-'));root=temporary;
   const manifest=JSON.parse(Buffer.from(getAsset('argocd-observer/manifest.json')));
   for(const name of Object.keys(manifest.files)){const file=resolve(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,Buffer.from(getAsset('argocd-observer/'+name)),{mode:0o600});}
  }
  const entry=resolve(root,'tools/prepare-argocd-observer.cjs');
  const helper=(load||(()=>createRequire(entry)(entry)))();
  const config=helper.options(argv),tool=helper.createPreparation(config),mode=config.mode||'plan';
  const methods={plan:()=>tool.plan(),'core-credentials':()=>tool.prepareCredentials(),'tls-prepare':()=>tool.prepareTls(),apply:()=>tool.activate(),renew:()=>tool.activate({renew:true}),cutover:()=>tool.cutover(),revoke:()=>tool.revoke()};
  if(!Object.hasOwn(methods,mode))throw Error('Unsupported Argo observer preparation mode');
  return {...methods[mode](),setupAssets:assets,installationComplete:false};
 }finally{if(temporary){const target=resolve(temporary);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('opensphere-verified-observer-code-'))throw Error('Observer temporary code path is invalid');rmSync(target,{recursive:true,force:true});}}
}
