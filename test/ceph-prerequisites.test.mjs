import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareCephExecutionProfile} from '../src/ceph-prerequisites.mjs';
const scope={context:'docker-desktop',channel:'edge',consoleUrl:'https://localhost:1114'};
test('Ceph profile rejects an invalid target before any command',()=>{
 for(const override of [{context:''},{context:'-x'},{channel:'stable'},{consoleUrl:'http://localhost:1114'},{consoleUrl:'https://localhost:1114/path'},{extra:true}])
  assert.throws(()=>prepareCephExecutionProfile({...scope,...override},{runner:()=>assert.fail('Unexpected API call')}),{code:'INVALID_SCOPE'});
});
// Until 2026-09-23 only docker-desktop / https://localhost:1114 was accepted. Which Ceph to use is a
// Console setting made after the OS starts; this profile only prepares where that runs.
test('Ceph profile runs against the invoked cluster and names no cluster itself',()=>{
 const calls=[];prepareCephExecutionProfile({context:'rke2',channel:'edge',consoleUrl:'https://console.opensphere.test:1114'},{runner:(command,args)=>{calls.push(args);return '';}});
 assert.equal(calls.length,2);for(const args of calls)assert.deepEqual(args.slice(0,2),['--context','rke2']);
 const bundled=readFileSync(new URL('../src/ceph-preparation-profile.json',import.meta.url),'utf8');
 assert.deepEqual(JSON.parse(bundled).scope,{channel:'edge'});
 assert.equal(/docker-desktop|localhost/.test(bundled),false);
});
test('Ceph profile performs dry run only by default and never installs Rook workloads',()=>{
 const calls=[];const result=prepareCephExecutionProfile(scope,{runner:(command,args,options)=>{calls.push({command,args,options});return '';}});
 assert.equal(result.applied,false);assert.equal(result.installationComplete,false);assert.equal(calls.length,2);assert.ok(calls[1].args.includes('--dry-run=server'));
 const items=JSON.parse(calls[1].options.input).items;assert.ok(items.every(r=>!['Deployment','Job','DaemonSet','Namespace','CustomResourceDefinition'].includes(r.kind)));
});
test('profile repair preserves the durable operation and validates before applying',()=>{
 const calls=[];const result=prepareCephExecutionProfile(scope,{apply:true,runner:(command,args,options)=>{calls.push({args,options});return args.includes('get')?JSON.stringify({metadata:{labels:{'opensphere.io/ceph-preparation':'profile-v1'}},data:{operation:'existing operation'}}):'';}});
 assert.equal(result.preservedRecord,true);assert.equal(result.resourceCount,13);assert.ok(calls[1].args.includes('--dry-run=server'));assert.ok(!calls[2].args.includes('--dry-run=server'));
 assert.ok(JSON.parse(calls[2].options.input).items.every(r=>r.metadata.name!=='opensphere-ceph-preparation'));
});
