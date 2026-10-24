import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseAllDocuments} from 'yaml';
import {HISS_VALIDATION_ARTIFACT,HISS_VALIDATION_PROFILES,verifyHissValidationArtifact,prepareHissValidation} from '../src/hiss-prerequisites.mjs';

const initial=readFileSync(new URL('./fixtures/hiss-validation.initial.yaml',import.meta.url),'utf8');
const current=JSON.parse(readFileSync(new URL('../src/hiss-validation-artifact.json',import.meta.url),'utf8')).yaml;
const documents=raw=>parseAllDocuments(raw).map(document=>document.toJSON()).filter(Boolean);
const oldHash='f079f22c8420c196f7ad834f42fc0d8acddf8b4c5134d9522fc5499fa219957d';
const newHash='286b837d4104a8936cee5169f2a70f52fb20490f0df5c3ac6f6037c2cde342d4';
const scope={context:'rke2',channel:'edge',consoleUrl:'https://console.opensphere.test'};
const roleOf=items=>items.find(resource=>resource.kind==='Role');
function observation(raw=current,mutate=()=>{}){
  const items=documents(raw).map((resource,index)=>({...structuredClone(resource),metadata:{...resource.metadata,uid:`uid-${index}`,resourceVersion:`${index+1}`}}));
  // Kubernetes owns these defaults/status fields; they add no authority.
  items.find(resource=>resource.kind==='Namespace').spec={finalizers:['kubernetes']};
  items.find(resource=>resource.kind==='ResourceQuota').status={used:{pods:'1'}};
  mutate(items);
  const calls=[];
  const runner=(command,args,options)=>{
    calls.push({command,args,options});
    assert.equal(command,'kubectl');
    assert.equal(args.includes('get'),true,'legacy compatibility must only observe');
    assert.equal(args.some(argument=>['apply','create','patch','replace','delete'].includes(argument)),false);
    return JSON.stringify({apiVersion:'v1',kind:'List',items});
  };
  return {items,calls,runner};
}

test('only the two exact validation captures are admitted, including the configured immutable Console producer',()=>{
  assert.equal(createHash('sha256').update(initial).digest('hex'),oldHash);
  assert.equal(createHash('sha256').update(current).digest('hex'),newHash);
  assert.equal(HISS_VALIDATION_PROFILES.length,2);
  assert.deepEqual(HISS_VALIDATION_PROFILES.map(profile=>profile.resourceCount),[7,7]);
  assert.equal(roleOf(documents(initial)).rules.length,3);
  assert.equal(roleOf(documents(current)).rules.length,4);
  for(const raw of [initial,current])assert.equal(verifyHissValidationArtifact(raw),raw);
  if(process.env.OPENSPHERE_CONSOLE_SOURCE)verifyHissValidationArtifact(readFileSync(resolve(process.env.OPENSPHERE_CONSOLE_SOURCE,HISS_VALIDATION_ARTIFACT),'utf8'));
  for(const raw of [initial,current]){
    const removed=documents(raw);removed.pop();
    for(const changed of [raw+'\n',raw.replace('restricted','privileged'),JSON.stringify(removed),null,undefined,'']){
      const calls=[];
      assert.throws(()=>prepareHissValidation(changed,scope,{runner:(...args)=>calls.push(args)}),{code:'UNTRUSTED_PROFILE'});
      assert.equal(calls.length,0);
    }
  }
});

test('the current approved validation capture keeps its unchanged server-side apply behavior',()=>{
  const calls=[];
  const result=prepareHissValidation(current,scope,{runner:(...args)=>calls.push(args)});
  assert.deepEqual(result,{applied:true,resourceCount:7,installationComplete:false});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].slice(0,2),['kubectl',['--context','rke2','apply','--server-side','--field-manager=opensphere-setup-hiss','-f','-','--request-timeout=20s']]);
  assert.equal(calls[0][2].input,current);
});

test('historical validation preserves exact old or approved successor authority and reports the actual Role contract',()=>{
  for(const [raw,expectedRoleHash]of [[initial,oldHash],[current,newHash]]){
    const client=observation(raw),before=structuredClone(client.items);
    const result=prepareHissValidation(initial,scope,{runner:client.runner});
    assert.equal(result.state,'Preserved');assert.equal(result.applied,false);
    assert.equal(result.profileSha256,oldHash);assert.equal(result.observedRoleProfileSha256,expectedRoleHash);
    assert.equal(result.resourceCount,7);assert.equal(result.observed.length,7);assert.equal(result.installationComplete,false);
    assert.deepEqual(result.observed,client.items.map(resource=>({
      identity:`${resource.apiVersion}/${resource.kind}/${resource.metadata.namespace||''}/${resource.metadata.name}`,
      uid:resource.metadata.uid,resourceVersion:resource.metadata.resourceVersion,
    })));
    assert.equal(client.calls.length,2);assert.deepEqual(client.items,before);
    for(const call of client.calls){
      assert.deepEqual(call.args.slice(0,2),['--context','rke2']);
      assert.equal(call.args.includes('--request-timeout=10s'),true);
      assert.equal(call.options.spawn.timeout,60000);
      assert.deepEqual(JSON.parse(call.options.input).items,documents(initial));
    }
  }
});

test('historical validation never infers authority from missing, extra or conflicting resources',()=>{
  const mutations=[
    items=>items.pop(),
    items=>items.push(structuredClone(items[0])),
    items=>{items[1]=structuredClone(items[0]);},
    items=>{roleOf(items).rules.push({apiGroups:['*'],resources:['*'],verbs:['*']});},
    items=>{roleOf(items).rules[3].verbs.push('update');},
    items=>{items.find(item=>item.kind==='ResourceQuota').spec.hard.pods='32';},
    items=>{items.find(item=>item.kind==='ResourceQuota').spec.scopes=['BestEffort'];},
    items=>{items.find(item=>item.kind==='ServiceAccount').automountServiceAccountToken=true;},
    items=>{items.find(item=>item.kind==='ServiceAccount').imagePullSecrets=[{name:'unexpected'}];},
    items=>{items.find(item=>item.kind==='RoleBinding').subjects[0].name='other-runtime';},
    items=>{items[0].metadata.labels['pod-security.kubernetes.io/enforce']='privileged';},
    items=>{delete items[0].metadata.labels['opensphere.io/authority'];},
    items=>{items[2].metadata.annotations={'helm.sh/hook':'pre-install'};},
    items=>{items[2].metadata.ownerReferences=[{uid:'unrelated-owner'}];},
    items=>{items.find(item=>item.kind==='ClusterRole').metadata.labels['rbac.authorization.k8s.io/aggregate-to-admin']='true';},
    items=>{items[2].metadata.uid='';},
    items=>{delete items[2].metadata.resourceVersion;},
    items=>{items[2].metadata.deletionTimestamp='2026-10-25T00:00:00Z';},
    items=>{items[2]=null;},
  ];
  for(const mutate of mutations){
    const client=observation(current,mutate);
    assert.throws(()=>prepareHissValidation(initial,scope,{runner:client.runner}),error=>['PRECONDITION_FAILED','OBSERVATION_UNAVAILABLE'].includes(error.code));
    assert.equal(client.calls.length,1);
  }
});

test('two individually valid observations cannot hide replacement or an authority transition',()=>{
  for(const mutate of [
    items=>{items[2].metadata.uid='replacement-uid';},
    items=>{roleOf(items).rules.pop();},
    items=>{items[0].metadata.labels['extra-owner-label']='changed';},
  ]){
    const client=observation(),run=client.runner;
    assert.throws(()=>prepareHissValidation(initial,scope,{runner:(...args)=>{
      if(client.calls.length===1)mutate(client.items);
      return run(...args);
    }}),{code:'PREPARATION_INCOMPLETE'});
    assert.equal(client.calls.length,2);
  }
});

test('unavailable observations and invalid scopes fail closed without apply or credential fallback',()=>{
  for(const runner of [()=>{throw Error('API unavailable');},()=>'{invalid',()=>JSON.stringify({kind:'Unexpected',items:[]})])
    assert.throws(()=>prepareHissValidation(initial,scope,{runner}),error=>['OBSERVATION_UNAVAILABLE','PRECONDITION_FAILED'].includes(error.code));
  for(const changes of [{context:''},{sourceRepository:'untrusted/owner'},{extra:true}]){
    let calls=0;
    assert.throws(()=>prepareHissValidation(initial,{...scope,...changes},{runner:()=>calls++}),{code:'INVALID_SCOPE'});
    assert.equal(calls,0);
  }
});

test('fresh historical captures with missing preparation explicitly require the existing approved HISS preparation path',()=>{
  let calls=0;
  assert.throws(()=>prepareHissValidation(initial,scope,{runner:()=>{
    calls++;return JSON.stringify({kind:'List',items:[]});
  }}),error=>error.code==='PRECONDITION_FAILED'&&error.message.includes('separately approved HISS preparation path'));
  assert.equal(calls,1);
});
