import test from 'node:test';
import assert from 'node:assert/strict';
import {applyComponentReleaseInDependencyOrder} from '../src/bootstrap.mjs';

const names=['console','consoleApi','extensionController','osaaGateway','osdst','osShellControl','cliArtifacts'];
const manifests=names.map(name=>({path:`runtime/${name}.yaml#${name}`,yaml:name}));
test('mixed release makes durable storage Ready, then command consumers Ready, before Gateway apply',()=>{
 const events=[];
 applyComponentReleaseInDependencyOrder(manifests,names,{apply:rows=>events.push(['apply',...rows.map(r=>r.yaml)]),wait:keys=>events.push(['ready',...keys])});
 assert.deepEqual(events,[['apply','osdst'],['ready','osdst'],['apply','consoleApi','extensionController','osShellControl','cliArtifacts'],['ready','consoleApi','extensionController','osShellControl','cliArtifacts'],['apply','console','osaaGateway']]);
 assert.deepEqual(events.filter(e=>e[0]==='apply').flatMap(e=>e.slice(1)).sort(),[...names].sort());
});
for (const failsAt of ['osdst','consoleApi'])test(`failed ${failsAt} rollout never applies Gateway`,()=>{
 const applied=[];
 assert.throws(()=>applyComponentReleaseInDependencyOrder(manifests,names,{apply:rows=>applied.push(...rows.map(r=>r.yaml)),wait:keys=>{if(keys.includes(failsAt))throw Error('readiness failed');}}),/readiness failed/);
 assert(!applied.includes('osaaGateway'));
 if(failsAt==='osdst')assert.deepEqual(applied,['osdst']);
});
test('Gateway-only and unrelated component changes retain their ordinary apply path',()=>{
 for(const keys of [['osaaGateway'],['console','osdst']]){
  const events=[];
  applyComponentReleaseInDependencyOrder(manifests.filter(m=>keys.includes(m.yaml)),keys,{apply:rows=>events.push(rows.map(r=>r.yaml)),wait:()=>assert.fail('no prerequisite rollout expected')});
  assert.deepEqual(events,[keys]);
 }
});
test('declared but absent prerequisites stop before Gateway apply',()=>{
 assert.throws(()=>applyComponentReleaseInDependencyOrder(manifests.filter(m=>m.yaml!=='osdst'),names,{apply:()=>assert.fail('must stop'),wait:()=>assert.fail('must stop')}),/Missing prerequisite/);
});
