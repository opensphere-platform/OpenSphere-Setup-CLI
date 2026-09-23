import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectBootstrapInput,createTerminalQuestions,saveBootstrapInput} from '../src/bootstrap-input.mjs';
const environment={context:'rke2-test',classes:[{metadata:{name:'local-path'},provisioner:'rancher.io/local-path'},
  {metadata:{name:'longhorn'},provisioner:'driver.longhorn.io'}],installed:null};
const options={channel:'edge'};
function deps(answers,overrides={}){return {interactive:true,readEnvironment:()=>environment,
  ask:async()=>answers.shift(),write:()=>{},...overrides};}
test('fresh interactive input records the administrator endpoint and selected existing storage',async()=>{
  const receipt=await collectBootstrapInput(options,deps(['invalid','https://console.example.test','missing','1','y']));
  assert.equal(receipt.consoleUrl,'https://console.example.test');
  assert.equal(receipt.storageClass,'local-path');
  assert.equal(receipt.mode,'administrator-terminal');
  assert.equal(receipt.installation,'fresh');
});
test('explicit options still require interactive confirmation',async()=>{
  await assert.rejects(collectBootstrapInput({...options,consoleUrl:'https://console.example.test',storageClass:'longhorn'},
    deps(['','','n'])),/cancelled/);
});
test('non-TTY bootstrap requires complete explicit automation intent before cluster reads',async()=>{
  for(const extra of [{},{yes:true},{nonInteractive:true,yes:true},{nonInteractive:true,consoleUrl:'https://console.example.test',storageClass:'longhorn'}]){
    await assert.rejects(collectBootstrapInput({...options,...extra},deps([],{interactive:false,readEnvironment:()=>{throw Error('must not read');}})),/Unattended|interactive administrator/);
  }
  const receipt=await collectBootstrapInput({...options,consoleUrl:'https://console.example.test',storageClass:'longhorn',nonInteractive:true,yes:true},deps([],{interactive:false}));
  assert.equal(receipt.mode,'explicit-automation');
});
test('resume uses installed input and refuses endpoint or storage migration',async()=>{
  const installed={consoleUrl:'https://installed.example.test',storageClass:'longhorn'};
  const readEnvironment=()=>({...environment,installed});
  const result=await collectBootstrapInput(options,deps(['yes'],{readEnvironment}));
  assert.equal(result.consoleUrl,installed.consoleUrl);
  await assert.rejects(collectBootstrapInput({...options,consoleUrl:'https://different.example.test'},deps([],{readEnvironment})),/differs/);
});
test('EOF cancels a pending terminal question instead of hanging installation',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const terminal=createTerminalQuestions(input,output);
  const pending=terminal.ask('Console URL: ');
  input.end();
  await assert.rejects(pending,/input ended/);
  await assert.rejects(terminal.ask('again'),/input ended/);
});
test('receipt persists closed non-secret fields only',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'setup-input-'));
  try{
    const receipt=await collectBootstrapInput(options,deps(['https://console.example.test','2','y']));
    const path=await saveBootstrapInput({...receipt,token:'must-not-persist',argv:['secret']},folder);
    const saved=JSON.parse(await readFile(path,'utf8'));
    assert.deepEqual(saved,receipt);
  }finally{await rm(folder,{recursive:true,force:true});}
});
