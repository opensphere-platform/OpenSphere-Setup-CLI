import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {verifyArgocdObserverAssets,runArgocdObserverPreparation} from '../src/argocd-observer-preparation.mjs';

test('Setup ships a fixed complete observer source snapshot and verifies every byte before load',()=>{
 const result=verifyArgocdObserverAssets();assert.equal(result.fileCount,11);assert.equal(result.sourceRepository,'https://github.com/opensphere-platform/OpenSphere-Platform-Support');assert.equal(result.sourceRevision,'ff81112b7ece8b424eafd056976123d3f02d566b');assert.match(result.sourceTreeSha256,/^[a-f0-9]{64}$/);
 const require=createRequire(import.meta.url),helper=require('../vendor/argocd-observer/tools/prepare-argocd-observer.cjs');
 assert.equal(typeof helper.createPreparation,'function');assert.throws(()=>helper.options(['--auth-token','private']),/Unsupported/);
});
test('a source asset or manifest change cannot be silently loaded',()=>{
 const dir=mkdtempSync(join(tmpdir(),'opensphere-observer-assets-test-'));
 try{cpSync(resolve(import.meta.dirname,'../vendor/argocd-observer'),dir,{recursive:true});const original=readFileSync(join(dir,'owner/argocd-observer-policy.cjs'));writeFileSync(join(dir,'owner/argocd-observer-policy.cjs'),Buffer.concat([original,Buffer.from('\n// changed\n')]));assert.throws(()=>verifyArgocdObserverAssets(dir),/integrity failed/);writeFileSync(join(dir,'manifest.json'),'{}');assert.throws(()=>verifyArgocdObserverAssets(dir),/manifest differs/);}
 finally{const resolved=resolve(dir);assert.ok(resolved.startsWith(resolve(tmpdir())+sep)&&basename(resolved).startsWith('opensphere-observer-assets-test-'));rmSync(resolved,{recursive:true,force:true});}
});
test('the dedicated Setup entry point defaults to plan and dispatches only its fixed preparation modes',()=>{
 const calls=[],fake={options:()=>({}),createPreparation:()=>({plan:()=>{calls.push('plan');return {state:'Planned'};}})};
 const result=runArgocdObserverPreparation([],{load:()=>fake});assert.deepEqual(calls,['plan']);assert.equal(result.installationComplete,false);assert.equal(result.setupAssets.fileCount,11);
 assert.throws(()=>runArgocdObserverPreparation([],{load:()=>({...fake,options:()=>({mode:'sync'})})}),/Unsupported/);
});
test('the observer entry point requires explicit cluster identity without weakening the existing reviewed Core guard',()=>{
 assert.throws(()=>runArgocdObserverPreparation(['--mode','plan']),/Missing --kubeconfig/);
 const old=readFileSync(resolve(import.meta.dirname,'../src/platform-core-prerequisites.mjs'),'utf8');assert.match(old,/installTarget\(scope\)/);assert.match(old,/if\(blocked\)throw fail\('PRECONDITION_FAILED'/);assert.ok(!old.includes('argocd-observer'));
});
test('the real Setup CLI dispatches the dedicated command without a default cluster and redacts unknown credential arguments',()=>{
 const file=resolve(import.meta.dirname,'../src/cli.mjs');
 const missing=spawnSync(process.execPath,[file,'prepare-argocd-observer','--mode','plan'],{encoding:'utf8',windowsHide:true});assert.equal(missing.status,1);assert.match(missing.stderr,/Missing --kubeconfig/);
 const invalid=spawnSync(process.execPath,[file,'prepare-argocd-observer','--auth-token','synthetic-secret-do-not-output'],{encoding:'utf8',windowsHide:true});assert.equal(invalid.status,1);assert.match(invalid.stderr,/Unsupported preparation option/);assert.ok(!invalid.stderr.includes('synthetic-secret-do-not-output'));
 const help=spawnSync(process.execPath,[file,'help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/prepare-argocd-observer/);
});
