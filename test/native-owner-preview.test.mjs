import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {parseAllDocuments} from 'yaml';
import vm from 'node:vm';
import {bindNativeInstallerAuthEnvironment,renderNativeOwnerPreview,renderFoundationOwnerPreview,NATIVE_OWNER_SOURCE_PATHS} from '../src/native-owner-preview.mjs';
import {registryKubernetesEgress,discoverRegistryKubernetesEgress} from '../src/registry-runtime-access.mjs';
import {fetchFoundationInstallerArtifacts,FOUNDATION_ARTIFACT_PATHS} from '../src/bootstrap.mjs';

const fixtureRoot=new URL('./fixtures/native-owner-preview-C3/',import.meta.url);
const capture=JSON.parse(readFileSync(new URL('capture.json',fixtureRoot)));
const bytes=path=>process.env.OPENSPHERE_CONSOLE_SOURCE?execFileSync('git',['-C',process.env.OPENSPHERE_CONSOLE_SOURCE,'show','HEAD:'+path]):readFileSync(new URL(path,fixtureRoot));
const raw=path=>bytes(path).toString('utf8');
const sourceArtifacts=()=>capture.entries.map(entry=>({path:entry.path,contents:raw(entry.path)}));
const image=name=>`ghcr.io/opensphere-platform/${name}@sha256:${'f'.repeat(64)}`;
const lock={sourceRevision:capture.sourceRevision,channel:'edge',releaseDigest:'sha256:'+'e'.repeat(64),components:{
  consoleApi:{},extensionController:{},
  osaaGateway:{image:image('opensphere-console-osaa-gateway')},r2d2OpenClawGateway:{image:image('opensphere-console-r2d2-openclaw')},osdst:{image:image('opensphere-osdst')},
},auxiliaryArtifacts:{osShellControl:{image:image('opensphere-console-os-shell-control')},osShellRuntime:{image:image('opensphere-os-shell-runtime')},cliArtifacts:{image:image('opensphere-os-cli')}}};
const service={metadata:{namespace:'default',name:'kubernetes'},spec:{clusterIPs:['10.43.0.1'],ports:[{name:'https',protocol:'TCP',port:443}]}};
const slices={items:[{metadata:{namespace:'default',labels:{'kubernetes.io/service-name':'kubernetes'}},addressType:'IPv4',ports:[{name:'https',protocol:'TCP',port:6443}],endpoints:[{conditions:{ready:true},addresses:['10.10.1.31','10.10.1.32']}]}]};
const knowledgeProjection={configMaps:[{apiVersion:'v1',kind:'ConfigMap',metadata:{name:'synthetic-knowledge',namespace:'opensphere-console'},data:{scope:'공개 unit fixture only'}}],sources:[{configMap:{name:'synthetic-knowledge',items:[{key:'scope',path:'scope'}]}}]};
const origin='https://console.opensphere.test';
const artifacts=()=>sourceArtifacts().map(item=>item.path===NATIVE_OWNER_SOURCE_PATHS[0]?{...item,contents:bindNativeInstallerAuthEnvironment(item.contents,'production',lock.channel)}:item);
const options=()=>({artifacts:artifacts(),knowledgeProjection,kubernetesApiEgress:registryKubernetesEgress(service,slices),consoleUrl:origin,authEnvironment:'production'});
const documents=items=>items.flatMap(item=>parseAllDocuments(typeof item==='string'?item:item.yaml).map(doc=>{assert.equal(doc.errors.length,0);return doc.toJS();}).filter(Boolean));

// Pure rendering parity: execute the selected producer's exact stage 6 and
// its actual hash/API discovery helpers. All Kubernetes calls are intercepted;
// input data and the Knowledge projection are explicitly synthetic unit values.
function actualPowerShellStage6(bound=true){
  const directory=mkdtempSync(join(tmpdir(),'opensphere-native-ps-parity-'));
  try{
    const selected=bound?artifacts():sourceArtifacts();
    for(const item of selected){const path=join(directory,item.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,item.contents);}
    const installer=raw('scripts/Install-ConsoleNativeRuntime.ps1');
    const between=(start,end)=>{const begin=installer.indexOf(start),finish=installer.indexOf(end,begin);assert.ok(begin>=0&&finish>begin);return installer.slice(begin,finish);};
    const hashes=between('function Get-Sha256Text(','function New-RandomSafeString(');
    const fields=between('function Get-JsonField(','# M2-M3 contract');
    const discovery=between('function Get-KubernetesApiEgressRules {','\ntrap {');
    const stage=between("$authEnvironment=if($ReleaseChannel -eq 'edge')", "\nInvoke-Kubectl @('-n',$RuntimeNamespace,'rollout','restart'");
    const inputPath=join(directory,'inputs.json');writeFileSync(inputPath,JSON.stringify({root:directory,lock,origin,knowledgeProjection,service,slices}));
    const scriptPath=join(directory,'stage6-parity.ps1');
    writeFileSync(scriptPath,String.raw`param([string]$InputPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$data=Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$script:applied=[Collections.Generic.List[string]]::new()
function Invoke-Kubectl([string[]]$Arguments,[string]$InputText='') {
  if($Arguments[0] -ceq 'apply') {$script:applied.Add($InputText);return @()}
  if($Arguments -contains 'get' -and $Arguments -contains 'service'){return @($data.service|ConvertTo-Json -Depth 20 -Compress)}
  if($Arguments -contains 'get' -and $Arguments -contains 'endpointslices.discovery.k8s.io'){return @($data.slices|ConvertTo-Json -Depth 20 -Compress)}
  throw 'Unexpected side effect in pure stage6 parity'
}
${hashes}
${fields}
${discovery}
$ReleaseChannel=[string]$data.lock.channel
$ReleaseDigest=[string]$data.lock.releaseDigest
$ConsoleUrl=[string]$data.origin
$OsaaGatewayImage=[string]$data.lock.components.osaaGateway.image
$R2d2OpenClawGatewayImage=[string]$data.lock.components.r2d2OpenClawGateway.image
$OsdstImage=[string]$data.lock.components.osdst.image
$OsShellControlImage=[string]$data.lock.auxiliaryArtifacts.osShellControl.image
$OsShellRuntimeImage=[string]$data.lock.auxiliaryArtifacts.osShellRuntime.image
$OsCliImage=[string]$data.lock.auxiliaryArtifacts.cliArtifacts.image
$knowledgeProjection=$data.knowledgeProjection
$osaaPath=Join-Path $data.root 'apps/osaa-gateway/deploy.yaml'
$osdstPath=Join-Path $data.root 'apps/osdst/deploy.yaml'
$manifestPath=Join-Path $data.root 'apps/os-shell-control/deploy.yaml'
$runtimeTemplatePath=Join-Path $data.root 'apps/os-shell-control/runtime-template.js'
${stage}
[Console]::Write((ConvertTo-Json -InputObject @($script:applied) -Depth 30 -Compress))
`);
    return JSON.parse(execFileSync('pwsh',['-NoProfile','-NonInteractive','-File',scriptPath,'-InputPath',inputPath],{encoding:'utf8',timeout:30000,windowsHide:true}));
  }finally{rmSync(directory,{recursive:true,force:true});}
}
function gatewayEnvironment(rendered){return documents(rendered).find(item=>item.kind==='Deployment'&&item.metadata.name==='opensphere-console-osaa-gateway').spec.template.spec.containers.find(item=>item.name==='gateway').env;}

test('native preview captures are exact C3 declarations and match the configured canonical producer',()=>{
  for(const entry of capture.entries){const value=bytes(entry.path);assert.equal(value.length,entry.bytes);assert.equal(createHash('sha256').update(value).digest('hex'),entry.sha256);}
  assert.equal(capture.sourceRevision,'320e5031ad4ab1353daed82337a891dab5125fc4');
});

test('binding resolves only the selected C_AI auth slot and keeps promotion authentication strict',()=>{
  const value=raw(NATIVE_OWNER_SOURCE_PATHS[0]);
  assert.equal(bindNativeInstallerAuthEnvironment(value,'production','edge'),value.replace('__OPENSPHERE_AUTH_ENVIRONMENT__','production'));
  assert.throws(()=>bindNativeInstallerAuthEnvironment(value,'development','candidate'),/requires --auth-environment production/);
  for(const changed of [value.replace('__OPENSPHERE_AUTH_ENVIRONMENT__','production'),value+'\n__OPENSPHERE_AUTH_ENVIRONMENT__',null])assert.throws(()=>bindNativeInstallerAuthEnvironment(changed,'production'),/exactly one/);
});

test('real C3 PowerShell stage6 and owner preview have exactly equal declarations for all three native groups',()=>{
  const preview=renderNativeOwnerPreview(lock,options());
  assert.deepEqual(preview.map(item=>item.path),NATIVE_OWNER_SOURCE_PATHS);
  assert.deepEqual(documents(preview),documents(actualPowerShellStage6()));
  const deployments=documents(preview).filter(item=>item.kind==='Deployment');assert.equal(deployments.length,5);
  assert.equal(gatewayEnvironment(preview).find(item=>item.name==='OPENSPHERE_AUTH_ENVIRONMENT').value,'production');
});

test('unbound original C3 edge inference would change production auth and is refused by preview',()=>{
  assert.equal(gatewayEnvironment(actualPowerShellStage6(false)).find(item=>item.name==='OPENSPHERE_AUTH_ENVIRONMENT').value,'development');
  assert.throws(()=>renderNativeOwnerPreview(lock,{...options(),artifacts:sourceArtifacts()}),/authentication input is not bound/);
});

test('missing sources, unknown images, unresolved slots and absent verified Knowledge never yield a preview',()=>{
  const initial=options();
  for(const path of [...NATIVE_OWNER_SOURCE_PATHS,'apps/os-shell-control/runtime-template.js'])
    assert.throws(()=>renderNativeOwnerPreview(lock,{...initial,artifacts:initial.artifacts.filter(item=>item.path!==path)}),/missing or duplicated/);
  assert.throws(()=>renderNativeOwnerPreview(lock,{...initial,artifacts:[...initial.artifacts,initial.artifacts[0]]}),/missing or duplicated/);
  assert.throws(()=>renderNativeOwnerPreview(lock,{...initial,knowledgeProjection:{sources:[],configMaps:[]}}),/actual verified Knowledge/);
  const bad=structuredClone(lock);bad.components.osdst.image='unverified:latest';assert.throws(()=>renderNativeOwnerPreview(bad,initial),/exact release lock/);
  const changed=structuredClone(initial);changed.artifacts[1].contents+='\n__OPENSPHERE_UNKNOWN__';assert.throws(()=>renderNativeOwnerPreview(lock,changed),/unresolved/);
});

test('full preparation keeps its actual apply set unchanged and exposes the native preview only to preservation',async()=>{
  const source=readFileSync(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
  const begin=source.indexOf('export async function prepareRelease('),end=source.indexOf('\nexport function componentMigrationSourceRevision',begin);
  assert.ok(begin>=0&&end>begin);
  const nativePreview=renderNativeOwnerPreview(lock,options()),release=[{path:'foundation.yaml',yaml:'foundation declaration'}],foundation={release,ownerPreview:[...release,...nativePreview]},base=[{path:'base.yaml',yaml:'base declaration'}];
  const run=vm.runInNewContext('('+source.slice(begin,end).replace(/^export /,'')+')',{
    materializeFoundationInstallers:async()=>foundation,materializeBaseRelease:async()=>base,needsNativeRuntimePreparation:()=>false,Promise,
  });
  const prepared=await run(lock,'unused','longhorn',origin,'production');
  assert.deepEqual(Array.from(prepared.all),[...foundation.release,...base]);assert.deepEqual(prepared.base,base);
  assert.deepEqual(Array.from(prepared.ownerPreview),[...foundation.release,...nativePreview,...base]);
  assert.equal(prepared.all.some(item=>NATIVE_OWNER_SOURCE_PATHS.includes(item.path)),false);
});

test('actual full materialization binds the persisted auth input and feeds the same projector inputs into its read-only preview',async()=>{
  const source=readFileSync(new URL('../src/bootstrap.mjs',import.meta.url),'utf8');
  const begin=source.indexOf('async function materializeFoundationInstallers('),end=source.indexOf('\nfunction currentKubeContext()',begin);
  const knowledgePath='apps/osaa-gateway/knowledge-bundle/lock.json',knowledge={scope:'synthetic unit Knowledge input only'};
  const selected={...lock,channel:'candidate',knowledge},stored=new Map(),reads=[],calls=[];
  const realSources=new Map(sourceArtifacts().map(item=>[item.path,item.contents]));
  const context={join,Promise,Set,JSON,NATIVE_OWNER_SOURCE_PATHS,bindNativeInstallerAuthEnvironment,renderNativeOwnerPreview,renderFoundationOwnerPreview,
    isTargetConsoleRelease:()=>true,needsNativeRuntimePreparation:()=>true,foundationManifestSpecs:()=>[],fetchFoundationInstallerArtifacts,
    KNOWLEDGE_LOCK_PATH:knowledgePath,
    fetchReleaseArtifact:async(_lock,path)=>{reads.push(path);return path===knowledgePath?JSON.stringify(knowledge):path==='scripts/Install-ConsoleApiRuntime.ps1'?'Prepare-FoundationPrerequisites.ps1':realSources.get(path)||'unexecuted external installer dependency';},
    writeReleaseArtifact:async(_root,path,contents)=>stored.set(path,contents),
    materializeKnowledgeDirectory:async(value,directory)=>{assert.deepEqual(value,knowledge);assert.equal(directory,join('/unit-only','verified-knowledge'));},
    materializeSupabaseMigrationSet:async()=>({manifest:{scope:'unit migration I/O only'},evidence:{}}),
    run:(command,args,options)=>{assert.equal(command,'node');assert.deepEqual(Array.from(args),[join('/unit-only','scripts','render-knowledge-package.mjs'),join('/unit-only','verified-knowledge')]);assert.equal(options.capture,true);return JSON.stringify(knowledgeProjection);},
    discoverRegistryKubernetesEgress,kubectl:args=>{calls.push(args);assert.equal(args.includes('get'),true);return JSON.stringify(args.includes('service')?service:slices);},
  };
  const run=vm.runInNewContext('('+source.slice(begin,end)+')',context);
  const prepared=await run(selected,'/unit-only','longhorn',origin,'production');
  assert.deepEqual(reads.sort(),[...FOUNDATION_ARTIFACT_PATHS].sort());
  const persisted=stored.get(NATIVE_OWNER_SOURCE_PATHS[0]);
  assert.equal(persisted,bindNativeInstallerAuthEnvironment(raw(NATIVE_OWNER_SOURCE_PATHS[0]),'production','candidate'));
  assert.equal(prepared.ownerPreview.length,3);assert.equal(calls.length,2);
  assert.equal(gatewayEnvironment(prepared.ownerPreview).find(item=>item.name==='OPENSPHERE_AUTH_ENVIRONMENT').value,'production');
});

test('Gitea final Owner preview follows the actual fixed installer scale without modifying its staged apply declaration',()=>{
  const path='backend/gitea/bootstrap/gitea.yaml',staged=[{path,yaml:raw(path)}],before=structuredClone(staged);
  const preview=renderFoundationOwnerPreview(staged,sourceArtifacts());
  const old=documents(staged),next=documents(preview),index=old.findIndex(item=>item.kind==='Deployment'&&item.metadata.name==='opensphere-gitea');
  assert.equal(old[index].spec.replicas,0);assert.equal(next[index].spec.replicas,1);
  next[index].spec.replicas=0;assert.deepEqual(next,old);assert.deepEqual(staged,before);
  const changed=sourceArtifacts().map(item=>item.path==='backend/gitea/bootstrap/install.ps1'?{...item,contents:item.contents.replace("'--replicas=1'","'--replicas=2'")}:item);
  assert.throws(()=>renderFoundationOwnerPreview(staged,changed),/final scale contract differs/);
  assert.throws(()=>renderFoundationOwnerPreview(staged,[]),/selected installer source/);
});
