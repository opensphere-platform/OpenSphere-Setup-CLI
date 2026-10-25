import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import vm from 'node:vm';
import {fetchFoundationInstallerArtifacts,fetchReleaseArtifact,FOUNDATION_ARTIFACT_PATHS} from '../src/bootstrap.mjs';
import {NATIVE_RUNTIME_RENDERER,NATIVE_RUNTIME_SOURCE_PATHS,NATIVE_JOURNAL,NATIVE_ACTION_INTENT,NATIVE_SESSION_FENCE,prepareNativeRuntimePrerequisites} from '../src/r2d2-native-prerequisites.mjs';
import {INSTALLATION_IDENTITY_CONFIGMAP} from '../src/installation-identity.mjs';

const captureRoot=new URL('./fixtures/native-runtime-source-C3/',import.meta.url);
const capture=JSON.parse(readFileSync(new URL('capture.json',captureRoot)));
const capturedInput=JSON.parse(readFileSync(new URL('./fixtures/native-maintenance-prerequisites-v1.json',import.meta.url))).input;
const clusterUid='22222222-2222-4222-8222-222222222222';
const policyInput={schema:'opensphere.r2d2-runtime-preparation/v1',clusterUid,installationId:capturedInput.policy.installationId,installedReleaseDigest:null,...structuredClone(capturedInput)};
const lock={sourceRevision:capture.sourceRevision,releaseDigest:'sha256:'+'c'.repeat(64),components:{
  consoleApi:{},extensionController:{},osaaGateway:{sourceRevision:capture.sourceRevision,image:policyInput.policy.bridgeImage},
  r2d2OpenClawGateway:{sourceRevision:capture.sourceRevision,image:policyInput.policy.image},
}};
const manifest={migrations:[NATIVE_JOURNAL,NATIVE_ACTION_INTENT,NATIVE_SESSION_FENCE].map(semanticKey=>({semanticKey}))};
const bytesFor=path=>process.env.OPENSPHERE_CONSOLE_SOURCE
  ?execFileSync('git',['-C',process.env.OPENSPHERE_CONSOLE_SOURCE,'show','HEAD:'+path])
  :readFileSync(new URL(path,captureRoot));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fetcher({missing=false}={}){
  const calls=[];
  const fetchFn=async(url,options)=>{
    const prefix='https://raw.githubusercontent.com/opensphere-platform/OpenSphere-console/'+capture.sourceRevision+'/';
    assert.equal(url.startsWith(prefix),true);assert.equal(options.redirect,'error');
    const path=url.slice(prefix.length);assert.ok(NATIVE_RUNTIME_SOURCE_PATHS.includes(path));calls.push(path);
    return {ok:!(missing&&path.endsWith('openclaw-native-config.cjs')),status:missing&&path.endsWith('openclaw-native-config.cjs')?404:200,text:async()=>bytesFor(path).toString('utf8')};
  };
  return {calls,read:(path,options={})=>fetchReleaseArtifact(lock,path,{...options,fetchFn})};
}
function clusterReader(){
  const calls=[];
  const kubectl=args=>{
    calls.push(args);assert.equal(args.includes('get'),true,'consumer conformance never mutates Kubernetes');
    if(args.join(' ')==='get namespace kube-system -o jsonpath={.metadata.uid}')return clusterUid;
    if(args.includes(INSTALLATION_IDENTITY_CONFIGMAP))return JSON.stringify({kind:'ConfigMap',metadata:{uid:'identity-uid',resourceVersion:'1'},immutable:true,data:{clusterUid,installationId:policyInput.installationId}});
    return '';
  };
  return {calls,kubectl};
}
function writeArtifact(root,path,contents){
  assert.ok(NATIVE_RUNTIME_SOURCE_PATHS.includes(path));const file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,contents);
}
async function fullMaterialize(root,options){
  const source=fetcher(options);
  const artifacts=await fetchFoundationInstallerArtifacts(lock,path=>NATIVE_RUNTIME_SOURCE_PATHS.includes(path)
    ?source.read(path):Promise.resolve(path==='scripts/Install-ConsoleApiRuntime.ps1'?'Prepare-FoundationPrerequisites.ps1':'unused installer dependency'));
  for(const item of artifacts.filter(item=>NATIVE_RUNTIME_SOURCE_PATHS.includes(item.path)))writeArtifact(root,item.path,item.contents);
  return source;
}
function prepare(root,reader){return prepareNativeRuntimePrerequisites(lock,{input:policyInput,manifest,kubectl:reader.kubectl,rendererPath:join(root,NATIVE_RUNTIME_RENDERER)});}

test('native source minimum is exactly the immutable renderer and its one relative dependency',()=>{
  assert.deepEqual(NATIVE_RUNTIME_SOURCE_PATHS,capture.entries.map(item=>item.path));
  assert.ok(NATIVE_RUNTIME_SOURCE_PATHS.every(path=>FOUNDATION_ARTIFACT_PATHS.includes(path)));
  for(const entry of capture.entries){
    const bytes=bytesFor(entry.path);assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
    const relative=[...bytes.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/gu)].map(match=>resolve(dirname(entry.path),match[1]));
    assert.ok(relative.every(path=>NATIVE_RUNTIME_SOURCE_PATHS.some(candidate=>resolve(candidate)===path)));
    assert.notEqual(hash(Buffer.concat([bytes,Buffer.from('\n// altered capture\n')])),entry.sha256,'mutated producer bytes must not match the captured conformance contract');
  }
});

test('full installer downloads the real closure into an isolated directory and actual default preparation succeeds',async()=>{
  const root=mkdtempSync(join(tmpdir(),'opensphere-native-closure-'));
  try{
    const source=await fullMaterialize(root);assert.deepEqual(source.calls.sort(),[...NATIVE_RUNTIME_SOURCE_PATHS].sort());
    const reader=clusterReader(),plan=prepare(root,reader);
    assert.equal(plan.entries.length,9);assert.equal(plan.installationId,policyInput.installationId);
    assert.deepEqual(readdirSync(join(root,'apps/osaa-gateway')).sort(),['openclaw-native-config.cjs','openclaw-runtime-resources.cjs']);
    const actual=JSON.parse(execFileSync(process.execPath,['-e',
      'const r=require(process.argv[1]);process.stdout.write(JSON.stringify({seed:JSON.parse(r.configSeed({})),sources:Object.keys(require.cache)}));',join(root,NATIVE_RUNTIME_RENDERER)],{encoding:'utf8',cwd:root,env:{...process.env,NODE_PATH:''}}));
    assert.equal(actual.seed.cron.enabled,false);assert.equal(actual.seed.tools.exec.mode,'deny');
    assert.deepEqual(actual.sources.map(path=>resolve(path)).sort(),NATIVE_RUNTIME_SOURCE_PATHS.map(path=>resolve(root,path)).sort());
    assert.ok(reader.calls.every(args=>args.includes('get')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('component preparation downloads the same real closure at the exact C_AI revision before default rendering',async()=>{
  const root=mkdtempSync(join(tmpdir(),'opensphere-native-component-'));
  try{
    const source=fetcher(),reader=clusterReader();
    const bootstrap=readFileSync(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
    const body=bootstrap.slice(bootstrap.indexOf('export async function prepareComponentRelease'),bootstrap.indexOf('export async function preflightReleaseArtifacts')).replace('export async function','async function');
    const context={NATIVE_RUNTIME_RENDERER,NATIVE_RUNTIME_SOURCE_PATHS,componentReleaseManifestSpecs:()=>({foundation:[],base:[]}),
      componentMigrationSourceRevision:()=>null,EXTENSION_CONTROLLER_MANIFEST:{path:'unused-controller'},needsNativeRuntimePreparation:()=>true,
      fetchReleaseArtifact:(selected,path,options)=>{assert.equal(selected,lock);assert.equal(options.sourceRevision,lock.components.osaaGateway.sourceRevision);return source.read(path,options);},
      writeReleaseArtifact:async(directory,path,contents)=>writeArtifact(directory,path,contents),
      readVerifiedMigrationManifest:async(selected,revision)=>{assert.equal(revision,capture.sourceRevision);return {manifest};},SUPABASE_MIGRATION_MANIFEST:'backend/supabase/migrations/manifest.json',
      prepareNativeRuntimePrerequisites:(selected,options)=>prepareNativeRuntimePrerequisites(selected,{...options,kubectl:reader.kubectl}),join};
    const run=vm.runInNewContext(body+';prepareComponentRelease',context);
    const prepared=await run(lock,root,'unused','https://console.test','development',{changedComponents:['osaaGateway'],includeMigrations:false,r2d2RuntimePolicy:policyInput});
    assert.equal(prepared.foundation.nativeRuntime.entries.length,9);
    assert.deepEqual(source.calls.sort(),[...NATIVE_RUNTIME_SOURCE_PATHS].sort());assert.ok(reader.calls.every(args=>args.includes('get')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing or syntactically modified helper fails in the isolated real renderer without ambient fallback or writes',async()=>{
  for(const fault of ['missing','invalid-source']){
    const root=mkdtempSync(join(tmpdir(),'opensphere-native-negative-'));
    try{
      await fullMaterialize(root);const helper=join(root,NATIVE_RUNTIME_SOURCE_PATHS[1]);
      if(fault==='missing')unlinkSync(helper);else writeFileSync(helper,'module.exports = { broken: ; };\n');
      const reader=clusterReader();assert.throws(()=>prepare(root,reader),fault==='missing'?/Cannot find module.*openclaw-native-config/s:/SyntaxError/);
      assert.ok(reader.calls.every(args=>args.includes('get')));
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('a missing required helper download aborts materialization instead of copying from a local checkout',async()=>{
  const root=mkdtempSync(join(tmpdir(),'opensphere-native-download-negative-'));
  try{await assert.rejects(fullMaterialize(root,{missing:true}),/openclaw-native-config.cjs.*HTTP 404/);assert.deepEqual(readdirSync(root),[]);}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('pre-native target releases never request the future native source closure',async()=>{
  const previous={components:{consoleApi:{},extensionController:{}}},reads=[];
  const artifacts=await fetchFoundationInstallerArtifacts(previous,async path=>{reads.push(path);return path==='scripts/Install-ConsoleApiRuntime.ps1'?'Prepare-FoundationPrerequisites.ps1':'old source';});
  assert.ok(reads.every(path=>!NATIVE_RUNTIME_SOURCE_PATHS.includes(path)));
  assert.equal(artifacts.length,FOUNDATION_ARTIFACT_PATHS.length-NATIVE_RUNTIME_SOURCE_PATHS.length);
});

test('native helper source authority still refuses a mutable revision before any fetch',async()=>{
  let calls=0;
  await assert.rejects(fetchReleaseArtifact(lock,NATIVE_RUNTIME_SOURCE_PATHS[1],{sourceRevision:'main',fetchFn:()=>{calls++;}}),/source revision is invalid/);
  assert.equal(calls,0);
});
