import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,windowsHide:true});
test('status cannot silently ignore an explicit OAuth authentication request',()=>{
 const result=run('status','--registry-auth','oauth');assert.equal(result.status,1);assert.match(result.stderr,/status queries Kubernetes only/);
});
test('OAuth App override cannot silently fall back to another authentication mode',()=>{
 const result=run('resolve','--github-client-id','OpenSphereClientId');assert.equal(result.status,1);assert.match(result.stderr,/requires --registry-auth oauth/);
});
test('OAuth rejects mixed stdin credentials before any browser or provider request',()=>{
 const result=run('resolve','--registry-auth','oauth','--registry-token-stdin');assert.equal(result.status,1);assert.match(result.stderr,/OAuth and stdin token options cannot be combined/);
});
