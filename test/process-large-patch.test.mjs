import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {kubectl} from '../src/process.mjs';

test('a large local JSON patch retains CAS tests and succeeds beyond Windows argv limit',()=>{
  const directory=mkdtempSync(join(tmpdir(),'opensphere-large-patch-test-'));
  const file=join(directory,'object.json');
  const before=readdirSync(tmpdir()).filter(x=>x.startsWith('opensphere-kubectl-patch-')).sort();
  const value='x'.repeat(45000);
  writeFileSync(file,JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'fixture',uid:'fixture-uid',resourceVersion:'1'},data:{value:'old'}}));
  const patch=(uid)=>JSON.stringify([{op:'test',path:'/metadata/uid',value:uid},{op:'test',path:'/metadata/resourceVersion',value:'1'},{op:'replace',path:'/data',value:{value}}]);
  try {
    const result=JSON.parse(kubectl(['patch','--local','-f',file,'--type=json','-o','json','-p',patch('fixture-uid')],{capture:true}));
    assert.equal(result.data.value,value);
    assert.throws(()=>kubectl(['patch','--local','-f',file,'--type=json','-o','json','-p',patch('other-uid')],{capture:true}),/failed with exit code/);
    assert.deepEqual(readdirSync(tmpdir()).filter(x=>x.startsWith('opensphere-kubectl-patch-')).sort(),before);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
