// Source library packaging checks only; these are not release signature tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readinessProfile} from '../src/release-readiness-profile.mjs';
const entry=fileURLToPath(new URL('../src/release-readiness-profile.mjs',import.meta.url));
test('shared profile library does not mistake a bundled CLI entrypoint for its own command',()=>{
 const root=mkdtempSync(join(tmpdir(),'osc-profile-entry-'));
 try{
  const bundle=join(root,'index.mjs');copyFileSync(entry,bundle);
  const result=spawnSync(process.execPath,[bundle,'--help'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('external import of shared profile library performs no CLI dispatch',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../src/release-readiness-profile.mjs',import.meta.url).href)});process.stdout.write('imported');`],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'imported');assert.equal(result.stderr,'');
});
test('direct shared-profile CLI still validates a prepared adoption instead of becoming a no-op',()=>{
 const root=mkdtempSync(join(tmpdir(),'osc-profile-direct-'));
 try{
  const source='a'.repeat(40),digest='sha256:'+'b'.repeat(64);
  const workload={kind:'Deployment',namespace:'opensphere-console',name:'synthetic-web',owner:'console',uid:'uid',resourceVersion:'7',replicas:2,
   configurationDigest:'sha256:'+'c'.repeat(64),containers:[{name:'web',image:'ghcr.io/opensphere-platform/opensphere-console@'+digest,features:{}}]};
  const bom={sourceRevision:source,readinessProfile:readinessProfile('full',source)};
  const installed={releaseDigest:digest,resourceVersion:'9',observedUtc:new Date().toISOString(),workloads:[workload]};
  const rendered={sourceRevision:source,baseReleaseDigest:digest,baseResourceVersion:'9',deactivations:[],workloads:[{...workload,baseUid:'uid',baseResourceVersion:'7'}]};
  const paths=['bom.json','installed.json','rendered.json'].map(name=>join(root,name));
  for(const [i,value]of[bom,installed,rendered].entries())writeFileSync(paths[i],JSON.stringify(value));
  const result=spawnSync(process.execPath,[entry,'verify-adoption',...paths],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'preserved');
  rendered.workloads[0].replicas=1;writeFileSync(paths[2],JSON.stringify(rendered));
  const denied=spawnSync(process.execPath,[entry,'verify-adoption',...paths],{encoding:'utf8',windowsHide:true});
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/Active Owner would shrink/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
