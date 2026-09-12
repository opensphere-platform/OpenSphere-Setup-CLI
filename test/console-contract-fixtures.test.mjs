import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const root=new URL('./fixtures/console-contract-v66/',import.meta.url);
test('standalone Setup provider fixtures have exact reviewed bytes and no sibling repository dependency',()=>{
 const manifest=JSON.parse(readFileSync(new URL('fixture-manifest.json',root)));
 assert.equal(manifest.schema,'opensphere.setup-test-fixtures/v1');assert.equal(manifest.files.length,19);
 for(const entry of manifest.files){assert(!entry.path.startsWith('/')&&!entry.path.includes('..'));assert.equal(createHash('sha256').update(readFileSync(new URL(entry.path,root))).digest('hex'),entry.sha256,entry.path);}
 for(const name of ['base-runtime.test.mjs','console-service-port.test.mjs','console-index-content.test.mjs','platform-core-prerequisites.test.mjs']){
  const source=readFileSync(new URL(name,import.meta.url),'utf8');assert.doesNotMatch(source,/\.\.\/\.\.\/OpenSphere-[Cc]onsole/);
 }
});
