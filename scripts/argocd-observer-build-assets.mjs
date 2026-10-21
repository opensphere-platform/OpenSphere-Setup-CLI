import {cpSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyArgocdObserverAssets} from '../src/argocd-observer-preparation.mjs';

export function argocdObserverSeaAssets(root){
 const source=resolve(root,'vendor/argocd-observer');verifyArgocdObserverAssets(source);
 const manifest=JSON.parse(readFileSync(resolve(source,'manifest.json')));
 return Object.fromEntries(['manifest.json',...Object.keys(manifest.files)].map(name=>['argocd-observer/'+name,resolve(source,name)]));
}
export function copyArgocdObserverBundleAssets(root){
 const assets=argocdObserverSeaAssets(root),target=resolve(root,'.release/vendor/argocd-observer');
 for(const [name,file]of Object.entries(assets)){const output=resolve(target,name.slice('argocd-observer/'.length));mkdirSync(dirname(output),{recursive:true});cpSync(file,output);}
 return {state:'VerifiedSetupAssetsCopied',fileCount:Object.keys(assets).length};
}
if(process.argv[1]&&basename(process.argv[1])==='argocd-observer-build-assets.mjs'&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(copyArgocdObserverBundleAssets(resolve(import.meta.dirname,'..'))));
