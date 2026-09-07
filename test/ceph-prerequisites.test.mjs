import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCephExecutionProfile} from '../src/ceph-prerequisites.mjs';
const scope={context:'docker-desktop',channel:'edge',consoleUrl:'https://localhost:1114'};
test('Ceph profile rejects a different cluster, channel or Console before any command',()=>{
 for(const override of [{context:'production'},{channel:'stable'},{consoleUrl:'https://example.com'}])assert.throws(()=>prepareCephExecutionProfile({...scope,...override},{runner:()=>assert.fail('Unexpected API call')}),/restricted/);
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
