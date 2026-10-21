import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyArgocdObserverAssets} from '../src/argocd-observer-preparation.mjs';
import {argocdObserverSeaAssets} from '../scripts/argocd-observer-build-assets.mjs';
const root=resolve(import.meta.dirname,'..'),bundle=resolve(root,'.release/bundle/index.mjs'),assets=resolve(root,'.release/vendor/argocd-observer');
test('the real ncc Setup bundle retains normal help and dispatches observer validation without readiness side effects',()=>{
 const help=spawnSync(process.execPath,[bundle,'help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/prepare-argocd-observer/);assert.ok(!help.stderr.includes('Unknown release readiness command'));
 const plan=spawnSync(process.execPath,[bundle,'prepare-argocd-observer','--mode','plan'],{encoding:'utf8',windowsHide:true});assert.equal(plan.status,1);assert.match(plan.stderr,/Missing --kubeconfig/);
});
test('plain runtime and SEA package the same verified 12 source assets plus manifest',()=>{
 const receipt=verifyArgocdObserverAssets(assets),sea=argocdObserverSeaAssets(root);assert.equal(receipt.fileCount,12);assert.equal(Object.keys(sea).length,13);assert.ok(Object.hasOwn(sea,'argocd-observer/tools/prepare-argocd-observer.cjs'));assert.ok(Object.keys(sea).every(name=>name.startsWith('argocd-observer/')&&!name.includes('..')));
});
test('an altered emitted runtime asset fails before bundled helper execution',()=>{
 const file=resolve(assets,'owner/argocd-observer-policy.cjs'),original=readFileSync(file);
 try{writeFileSync(file,Buffer.concat([original,Buffer.from('\n// changed build output\n')]));const result=spawnSync(process.execPath,[bundle,'prepare-argocd-observer','--mode','plan'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.match(result.stderr,/Setup preparation failed/);assert.ok(!result.stderr.includes('Missing --kubeconfig'));}
 finally{writeFileSync(file,original);}
});
