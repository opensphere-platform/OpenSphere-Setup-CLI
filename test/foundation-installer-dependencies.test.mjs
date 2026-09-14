import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFoundationInstallerArtifacts,FOUNDATION_ARTIFACT_PATHS} from '../src/bootstrap.mjs';
const lock={components:{consoleApi:{},extensionController:{}}};
const script='scripts/Install-ConsoleApiRuntime.ps1';
const extra=['scripts/Prepare-FoundationPrerequisites.ps1','apps/extension-controller/src/foundation-bootstrap.json'];
test('earlier Console sources never request future Foundation dependencies',async()=>{
 const reads=[];const result=await fetchFoundationInstallerArtifacts(lock,async path=>{
  reads.push(path);assert.ok(!extra.includes(path));return path===script?'Write-Output installed':'verified source';
 });
 assert.equal(reads.filter(path=>path===script).length,1);assert.equal(result.length,FOUNDATION_ARTIFACT_PATHS.length-2);
});
test('an installer invoking Foundation preparation requires both source artifacts',async()=>{
 const result=await fetchFoundationInstallerArtifacts(lock,async path=>path===script?'& "$PSScriptRoot/Prepare-FoundationPrerequisites.ps1"':'verified source');
 assert.ok(extra.every(path=>result.some(item=>item.path===path)));assert.equal(result.length,FOUNDATION_ARTIFACT_PATHS.length);
});
test('a required Foundation dependency download failure stops preparation',async()=>{
 await assert.rejects(fetchFoundationInstallerArtifacts(lock,async path=>{
  if(path===script)return '& "$PSScriptRoot/Prepare-FoundationPrerequisites.ps1"';
  if(path===extra[1])throw Error('Source artifact HTTP 404');return 'verified source';
 }),/Source artifact HTTP 404/);
});
