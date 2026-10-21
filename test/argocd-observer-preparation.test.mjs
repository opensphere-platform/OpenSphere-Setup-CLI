import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {verifyArgocdObserverAssets,runArgocdObserverPreparation} from '../src/argocd-observer-preparation.mjs';
import {preparePlatformCorePrerequisites} from '../src/platform-core-prerequisites.mjs';

test('Setup ships a fixed complete observer source snapshot and verifies every byte before load',()=>{
 const result=verifyArgocdObserverAssets();assert.equal(result.fileCount,12);assert.equal(result.sourceRepository,'https://github.com/opensphere-platform/OpenSphere-Platform-Support');assert.equal(result.sourceRevision,'fc136f54df1b2c1346cb6cb70d0195b3caf305ff');assert.match(result.sourceTreeSha256,/^[a-f0-9]{64}$/);
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
 const result=runArgocdObserverPreparation([],{load:()=>fake});assert.deepEqual(calls,['plan']);assert.equal(result.installationComplete,false);assert.equal(result.setupAssets.fileCount,12);
 assert.throws(()=>runArgocdObserverPreparation([],{load:()=>({...fake,options:()=>({mode:'sync'})})}),/Unsupported/);
});

test('verified helper provenance never substitutes for the actually deployed PSSS compatibility source',()=>{
 const require=createRequire(import.meta.url),helper=require('../vendor/argocd-observer/tools/prepare-argocd-observer.cjs');
 const deployed='65d8bbfdddefafd1d1146b4ac73f8bda8f517a9f',image='sha256:'+'a'.repeat(64);let observed;
 const result=runArgocdObserverPreparation(['--mode','apply','--compat-source',deployed,'--compat-digest',image],{load:()=>({options:helper.options,createPreparation:config=>({activate:()=>{observed=config;return {state:'ObserverPrepared'};}})})});
 assert.equal(result.setupAssets.sourceRevision,'fc136f54df1b2c1346cb6cb70d0195b3caf305ff');assert.equal(observed['compat-source'],deployed);assert.equal(observed['compat-digest'],image);assert.equal(result.installationComplete,false);
});

test('the explicit cluster-scope mode dispatches only local namespace descriptor preparation',()=>{
 const calls=[],fake={options:()=>({mode:'cluster-scope'}),createPreparation:()=>({prepareClusterScope:()=>{calls.push('cluster-scope');return {state:'LocalNamespaceClusterPrepared',namespaces:['opensphere-console','opensphere-platform-delivery'],newRbac:false,credentialMaterial:false};},activate:()=>{throw Error('Observer token must not rotate');}})};
 const result=runArgocdObserverPreparation([],{load:()=>fake});assert.deepEqual(calls,['cluster-scope']);assert.equal(result.newRbac,false);assert.equal(result.credentialMaterial,false);assert.equal(result.installationComplete,false);
});

test('the explicit project-observation mode never dispatches observer rotation or workload sync',()=>{
 const calls=[],fake={options:()=>({mode:'project-observation'}),createPreparation:()=>({prepareProjectObservation:()=>{calls.push('project-observation');return {state:'DemoProjectObservationPrepared',newRbac:false,tokenRotation:false};},activate:()=>{throw Error('Observer token must not rotate');}})};
 const result=runArgocdObserverPreparation([],{load:()=>fake});assert.deepEqual(calls,['project-observation']);assert.equal(result.newRbac,false);assert.equal(result.tokenRotation,false);assert.equal(result.installationComplete,false);
});
test('the observer entry point requires explicit cluster identity without weakening the existing reviewed Core guard',()=>{
 assert.throws(()=>runArgocdObserverPreparation(['--mode','plan']),/Missing --kubeconfig/);
 const old=readFileSync(resolve(import.meta.dirname,'../src/platform-core-prerequisites.mjs'),'utf8');assert.match(old,/installTarget\(scope\)/);assert.match(old,/if\(blocked\)throw fail\('PRECONDITION_FAILED'/);
});

test('Core preparation preserves only the approved reduced observer executor without restoring Secret authority',async()=>{
 const raw=readFileSync(resolve(import.meta.dirname,'fixtures/console-contract-v66/deploy/installation-profiles/platform-core.json'),'utf8'),profile=JSON.parse(raw);
 const authority=JSON.parse(readFileSync(resolve(import.meta.dirname,'../vendor/argocd-observer/contracts/argocd-executor-authority.json'),'utf8'));
 const reduced=authority.resources.find(r=>r.kind==='Role'&&r.metadata.namespace==='argocd'&&r.metadata.name==='opensphere-platform-support-core-executor');
 assert.ok(reduced);assert.ok(!reduced.rules.some(r=>r.resources?.includes('secrets')));
 const id=r=>`${r.apiVersion}/${r.kind}/${r.metadata.namespace||''}/${r.metadata.name}`;
 const target=id(reduced),existing=new Map(profile.resources.map(r=>[id(r),r]));assert.ok(existing.has(target));existing.set(target,reduced);
 let writes=0;const client={read:async requested=>requested.map(r=>{const copy=structuredClone(existing.get(id(r))||r);copy.metadata.uid='uid-'+id(r);return copy;}),create:async()=>{writes++;throw Error('Must not create');},patchRules:async()=>{writes++;throw Error('Must not patch');}};
 const result=await preparePlatformCorePrerequisites(raw,{context:'rke2',channel:'edge',consoleUrl:'https://console.opensphere.test'},{client,apply:true});assert.equal(result.status,'Prepared');assert.ok(result.reviewedSuccessors.includes(target));assert.ok(result.preserved.includes(target));
 assert.equal(writes,0);
});
test('the real Setup CLI dispatches the dedicated command without a default cluster and redacts unknown credential arguments',()=>{
 const file=resolve(import.meta.dirname,'../src/cli.mjs');
 const missing=spawnSync(process.execPath,[file,'prepare-argocd-observer','--mode','plan'],{encoding:'utf8',windowsHide:true});assert.equal(missing.status,1);assert.match(missing.stderr,/Missing --kubeconfig/);
 const invalid=spawnSync(process.execPath,[file,'prepare-argocd-observer','--auth-token','synthetic-secret-do-not-output'],{encoding:'utf8',windowsHide:true});assert.equal(invalid.status,1);assert.match(invalid.stderr,/Unsupported preparation option/);assert.ok(!invalid.stderr.includes('synthetic-secret-do-not-output'));
 const help=spawnSync(process.execPath,[file,'help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/prepare-argocd-observer/);assert.match(help.stdout,/tls-prepare\|cluster-scope\|project-observation\|apply/);
});
