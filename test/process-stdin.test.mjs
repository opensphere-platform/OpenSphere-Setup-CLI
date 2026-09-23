import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const runnerUrl=new URL('../src/process.mjs',import.meta.url).href;
function nestedRun(input,{capture=false,exitCode=0}={}) {
  const expected=input===undefined?'parent terminal input':input;
  const child=`import {readFileSync} from 'node:fs';
    if(readFileSync(0,'utf8')!==${JSON.stringify(expected)})process.exit(43);
    process.stdout.write('child output');process.stderr.write('child diagnostic');
    process.exit(${exitCode});`;
  const parent=`import {run} from ${JSON.stringify(runnerUrl)};
    const output=run(process.execPath,['--input-type=module','--eval',${JSON.stringify(child)}],
      {input:${JSON.stringify(input)},capture:${capture},spawn:{timeout:2000}});
    if(${capture})process.stdout.write('captured:'+output);`;
  return spawnSync(process.execPath,['--input-type=module','--eval',parent],{
    input:'parent terminal input',encoding:'utf8',windowsHide:true,timeout:6000,
  });
}

test('streamed child receives supplied manifest, not inherited terminal input',()=>{
  const result=nestedRun('{"kind":"ConfigMap","data":{"plan.json":"{}"}}');
  assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.equal(result.stdout,'child output');
  assert.equal(result.stderr,'child diagnostic');
});

test('an explicitly empty input closes child stdin while absent input remains interactive',()=>{
  for(const input of ['',undefined]){
    const result=nestedRun(input);
    assert.equal(result.status,0,result.error?.message||result.stderr);
    assert.equal(result.stdout,'child output');
  }
});

test('captured child still receives supplied input and returns captured output',()=>{
  const result=nestedRun('captured manifest',{capture:true});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.equal(result.stdout,'captured:child output');
  assert.equal(result.stderr,'');
});

test('streamed child failure after consuming supplied input is propagated',()=>{
  const result=nestedRun('failed manifest',{exitCode:42});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/failed with exit code 42/);
});
