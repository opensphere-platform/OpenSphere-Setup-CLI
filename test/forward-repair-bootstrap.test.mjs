import test from 'node:test';
import assert from 'node:assert/strict';
import {runForwardRepairBootstrap} from '../src/bootstrap.mjs';
const image='ghcr.io/opensphere-platform/opensphere-console-beszel-bootstrap@sha256:'+'a'.repeat(64);
const lock={components:{beszelBootstrap:{image}}};
const source={manifests:[{path:'deploy/baseline-monitoring/beszel-release.yaml',yaml:
  `apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: beszel-bootstrap-v0187\n  namespace: opensphere-monitoring\nspec:\n  template:\n    spec:\n      containers:\n        - name: configure\n          image: ${image}\n`} ]};
const completed={metadata:{uid:'job-uid'},spec:{template:{spec:{containers:[{name:'configure',image}]}}},status:{succeeded:1}};
test('repair recreates only the absent official bootstrap Job and verifies its completion/image',()=>{
  for(const present of [true,false]){
    const calls=[];let reads=0;
    const result=runForwardRepairBootstrap(lock,source,{query:(args,options)=>{
      calls.push(args);assert.equal(options.capture,true);
      if(args.includes('get'))return ++reads===1&&!present?'':JSON.stringify(completed);
      if(args[0]==='create')assert.equal(options.input,source.manifests[0].yaml);
      return '';
    }});
    assert.equal(result.jobUid,'job-uid');assert.equal(result.completed,true);
    assert.equal(calls.filter(a=>a[0]==='create').length,present?0:1);
    assert.ok(!calls.some(a=>a.includes('delete')||a.includes('secret')||a.includes('patch')));
  }
});
test('repair never replaces another or failed bootstrap Job and rejects an ungoverned source',()=>{
  for(const invalid of [
    {...completed,status:{failed:1}},
    {...completed,spec:{template:{spec:{containers:[{name:'configure',image:'other-image'}]}}}},
  ]){
    let writes=0;
    assert.throws(()=>runForwardRepairBootstrap(lock,source,{query:args=>{
      if(args.includes('get'))return JSON.stringify(invalid);writes++;return '';
    }}),/refusing to replace/);assert.equal(writes,0);
  }
  assert.throws(()=>runForwardRepairBootstrap(lock,{manifests:[]},{query:()=>''}),/governed/);
});
