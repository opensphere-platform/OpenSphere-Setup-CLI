import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {verifyPlatformCoreProfile,PLATFORM_CORE_APPROVED_SHA256,PLATFORM_CORE_SHA256} from '../src/platform-core-prerequisites.mjs';

// 2026-09-29 localhost upgrade: the rollback preparation of the previous Console release (d13a6885)
// verifies that release's own reviewed profile, so a single pinned hash refused every upgrade.
const scope={context:'docker-desktop',channel:'edge',consoleUrl:'https://localhost:1114'};
const source=process.env.OPENSPHERE_CONSOLE_SOURCE;
const at=rev=>execFileSync('git',['-C',source,'show',`${rev}:deploy/installation-profiles/platform-core.json`],{encoding:'utf8',maxBuffer:8*1024*1024});

test('the current profile hash is one of the reviewed ones',()=>{
  assert.ok(Object.hasOwn(PLATFORM_CORE_APPROVED_SHA256,PLATFORM_CORE_SHA256));
  assert.equal(Object.keys(PLATFORM_CORE_APPROVED_SHA256).length,2);
});
test('both reviewed Console profiles verify and changed bytes do not',{skip:!source&&'OPENSPHERE_CONSOLE_SOURCE not set'},()=>{
  for(const rev of ['7aa06cba','d13a6885'])assert.equal(verifyPlatformCoreProfile(at(rev),scope).resources.length,53,rev);
  const changed=at('7aa06cba').replace('"schema"','"schema" ');
  assert.throws(()=>verifyPlatformCoreProfile(changed,scope),{code:'UNTRUSTED_PROFILE'});
});
