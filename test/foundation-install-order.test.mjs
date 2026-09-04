import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import vm from 'node:vm';

const source=await readFile(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
const begin=source.indexOf('function runFoundationInstallers(');
const end=source.indexOf('\nexport function assertComponentMigrationPrefix(',begin);
assert.ok(begin>=0 && end>begin);
const production=source.slice(begin,end);
const names=['gitea','giteaPostgres','consoleApi','extensionController','supabasePostgres',
  'supabaseAuth','supabaseRest','supabaseStorage','beszelHub','beszelAgent','beszelBootstrap'];
const lock={components:Object.fromEntries(names.map(name=>[name,{image:`ghcr.io/fixture/${name}@sha256:${'a'.repeat(64)}`}]))};
const foundation={target:true,root:'/verified-release',migration:{evidence:{
  sha256:'sha256:'+'b'.repeat(64),setDigest:'sha256:'+'c'.repeat(64),latestGlobalId:'opensphere-console/20260903/0028',
}}};
function harness({failBeszel=false}={}) {
  const state={reader:false,api:false,legacy:false,calls:[],progress:[]};
  const context={join,currentKubeContext:()=> 'docker-desktop',
    runLegacyFoundationInstallers:()=>{state.legacy=true;},
    run:(executable,args)=>{
      assert.equal(executable,'pwsh');
      const script=args[args.indexOf('-File')+1].replaceAll('\\','/');
      state.calls.push(script);
      assert.equal(args.at(-1)==='docker-desktop' || args.includes('docker-desktop'),true);
      if(script.endsWith('/deploy/baseline-monitoring/install.ps1')) {
        if(failBeszel)throw Error('reader provision failed');
        state.reader=true;
      } else if(script.endsWith('/scripts/Install-ConsoleApiRuntime.ps1')) {
        // Kubelet refuses to start C_API unless its required Secret exists.
        if(!state.reader)throw Error('CreateContainerConfigError: opensphere-baseline-monitoring-reader not found');
        assert.equal(args[args.indexOf('-ConsoleApiImage')+1],lock.components.consoleApi.image);
        assert.equal(args[args.indexOf('-ExpectedMigrationSetDigest')+1],foundation.migration.evidence.setDigest);
        assert.equal(args.includes('-VerifiedMaterializedRelease'),true);
        state.api=true;
      }
    },
  };
  return {state,run:vm.runInNewContext('('+production+')',context),
    progress:{item:(kind,message)=>state.progress.push([kind,message])}};
}
test('fresh foundation provisions the mandatory monitoring reader before the API container starts',()=>{
  const h=harness();
  h.run(lock,foundation,'standard','https://localhost:1114',h.progress);
  assert.equal(h.state.api,true);
  assert.equal(h.state.calls.length,3);
  assert.equal(h.state.progress.filter(([kind])=>kind==='완료').length,3);
});
test('monitoring prerequisite failure stops before API deployment and does not report it complete',()=>{
  const h=harness({failBeszel:true});
  assert.throws(()=>h.run(lock,foundation,'standard','https://localhost:1114',h.progress),/reader provision failed/);
  assert.equal(h.state.api,false);
  assert.equal(h.state.calls.some(path=>path.endsWith('Install-ConsoleApiRuntime.ps1')),false);
  assert.equal(h.state.progress.filter(([kind])=>kind==='완료').length,1);
});
test('legacy rollback keeps its existing foundation installer path',()=>{
  const h=harness();
  h.run(lock,{...foundation,target:false},'standard','https://localhost:1114',h.progress);
  assert.equal(h.state.legacy,true);
  assert.equal(h.state.calls.length,0);
});
const preparedBegin=source.indexOf('function installPreparedRelease(');
const preparedEnd=source.indexOf('\nexport async function bootstrap(',preparedBegin);
assert.ok(preparedBegin>=0 && preparedEnd>preparedBegin);
const crdPath='apps/extension-controller/crds/ui-plugin-crds.yaml';
const trustPath='apps/extension-controller/config/trusted-keys.yaml';
const preparedFixture={foundation:{target:true},base:[crdPath,trustPath,'deploy/opensphere-console.yaml'].map(path=>({path,yaml:'verified '+path}))};
function preparedHarness({failEstablishment=false}={}) {
  const state={applied:[],established:false,foundation:false};
  const fn=vm.runInNewContext('('+source.slice(preparedBegin,preparedEnd)+')',{
    TRUST_CONFIGMAP_PATH:trustPath,
    applyRelease:(items,_label,_progress,options)=>{
      assert.equal(options.preserveHostLocalEdgeTrust,true);
      for(const item of items){
        if(item.path==='deploy/opensphere-console.yaml' && !state.foundation)throw Error('Main Shell deployed before foundations');
        state.applied.push(item.path);
      }
    },
    kubectl:args=>{
      assert.equal(args.includes('--for=condition=Established'),true);
      assert.equal(args.includes('crd/uipluginpackages.plugins.opensphere.io'),true);
      assert.equal(args.includes('crd/uipluginregistrations.plugins.opensphere.io'),true);
      if(failEstablishment)throw Error('CRD did not establish');
      state.established=true;
    },
    runFoundationInstallers:(_lock,foundation)=>{
      if(foundation.target && (!state.established || !state.applied.includes(crdPath) || !state.applied.includes(trustPath))) {
        throw Error('Controller lifecycle cannot list registrations without its CRD');
      }
      state.foundation=true;
    },
  });
  return {state,run:(prepared=preparedFixture)=>fn({channel:'edge'},prepared,'standard','https://localhost:1114','apply')};
}
test('controller definitions and trust are ready before foundation readiness; Main Shell follows',()=>{
  const h=preparedHarness();h.run();
  assert.equal(h.state.foundation,true);
  assert.deepEqual(h.state.applied,[crdPath,trustPath,'deploy/opensphere-console.yaml']);
});
test('unestablished controller definitions stop before any foundation workload',()=>{
  const h=preparedHarness({failEstablishment:true});
  assert.throws(()=>h.run(),/CRD did not establish/);
  assert.equal(h.state.foundation,false);
  assert.equal(h.state.applied.includes('deploy/opensphere-console.yaml'),false);
});
test('missing verified controller prerequisites fail before any cluster mutation',()=>{
  const h=preparedHarness();
  assert.throws(()=>h.run({...preparedFixture,base:preparedFixture.base.filter(item=>item.path!==crdPath)}),/lacks Extension Controller prerequisites/);
  assert.deepEqual(h.state.applied,[]);
  assert.equal(h.state.foundation,false);
});
test('legacy prepared releases keep their apply sequence without target CRD prerequisites',()=>{
  const h=preparedHarness();
  h.run({foundation:{target:false},base:[{path:'legacy.yaml',yaml:'legacy'}]});
  assert.equal(h.state.foundation,true);
  assert.equal(h.state.established,false);
  assert.deepEqual(h.state.applied,['legacy.yaml']);
});
