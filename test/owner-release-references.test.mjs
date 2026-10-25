// Pure source/reference conformance. OCI and operating acceptance are not
// claimed here. CI uses its governed full Git checkout as the source oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {COMPONENTS,AUXILIARY_ARTIFACTS,LOCAL_EDGE_TRUST,RELEASE_TRUST} from '../src/release.mjs';
import {projectOwnerObservation} from '../src/adoption-owner-preservation.mjs';
import {fetchLocalNativeOwnerReferenceSources,ownerReferenceSourceEvidence,bindLocalNativeOwnerReferenceViews} from '../src/owner-release-references.mjs';
const previousRevision='5df584efff03a880db70a79458cc90bbfdee595d',targetRevision='320e5031ad4ab1353daed82337a891dab5125fc4',shellRevision='4b370b841c8843147ae14cfcb88eae504e267b1a';
function lock(revision,character){
 const artifacts=entries=>Object.fromEntries(Object.entries(entries).map(([name,repository])=>[name,{repository,image:`ghcr.io/opensphere-platform/${repository}@sha256:${character.repeat(64)}`,sourceRevision:revision}]));
 return {channel:'edge',trust:LOCAL_EDGE_TRUST,sourceRevision:revision,releaseDigest:'sha256:'+character.repeat(64),components:artifacts(COMPONENTS),auxiliaryArtifacts:artifacts(AUXILIARY_ARTIFACTS)};
}
const previous=lock(previousRevision,'a'),target=lock(targetRevision,'b');
previous.auxiliaryArtifacts.osShellControl.sourceRevision=shellRevision;
const bytes=(revision,path)=>process.env.OPENSPHERE_CONSOLE_SOURCE
 ?execFileSync('git',['-C',process.env.OPENSPHERE_CONSOLE_SOURCE,'show',revision+':'+path],{encoding:'utf8'})
 :readFileSync(new URL('./fixtures/native-owner-preview-C3/'+path,import.meta.url),'utf8');
const identity=owner=>`${owner.kind}/${owner.metadata.namespace}/${owner.metadata.name}`;
const document=(raw,id)=>parseAllDocuments(raw).map(doc=>doc.toJS()).find(owner=>owner&&identity(owner)===id);
function rendered(raw,release){
 const controlRevision=release.auxiliaryArtifacts.osShellControl.sourceRevision;
 const sha=value=>'sha256:'+createHash('sha256').update(value.replace(/\r\n/g,'\n')).digest('hex');
 const replacements=[
  ['__OPENSPHERE_GITEA_IMAGE__',release.components.gitea.image],['image: postgres:17-alpine','image: '+release.components.giteaPostgres.image],
  ['__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__',release.components.supabasePostgres.image],['__OPENSPHERE_CONSOLE_INDEX_CONTENT_IMAGE__',release.auxiliaryArtifacts.consoleIndexContent.image],
  ['__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__',release.components.extensionController.image],['__OPENSPHERE_REGISTRY_IMAGE_DIGEST__',release.components.registry.image.split('@')[1]],
  ['__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__',release.auxiliaryArtifacts.osShellRuntime.image],['__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__',release.auxiliaryArtifacts.cliArtifacts.image.split('@')[1]],
  ['__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__',release.auxiliaryArtifacts.osShellControl.image],
  ['__OPENSPHERE_OS_SHELL_MANIFEST_SHA256__',sha(bytes(controlRevision,'apps/os-shell-control/deploy.yaml'))],
  ['__OPENSPHERE_OS_SHELL_RUNTIME_TEMPLATE_SHA256__',sha(bytes(controlRevision,'apps/os-shell-control/runtime-template.js'))],
  ['__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__',`release://edge/${release.releaseDigest.slice(7)}/native-console-runtime`],
 ];
 for(const [from,to]of replacements)raw=raw.replaceAll(from,to);
 return raw;
}
async function fixture(){
 const calls=[];
 const sources=await fetchLocalNativeOwnerReferenceSources(previous,target,async(selected,path,{sourceRevision})=>{calls.push({selected,path,sourceRevision});return bytes(sourceRevision,path);});
 const metadata=ownerReferenceSourceEvidence(sources),pairs=new Map();
 for(const entry of metadata.filter(item=>item.side==='target')){
  // Same non-reference structure isolates the verified reference change itself;
  // real API-defaulted whole-Owner equality is verified separately on RKE2.
  const source=bytes(entry.sourceRevision,entry.path);
  const before=document(rendered(source,previous),entry.identity),after=document(rendered(source,target),entry.identity);
  pairs.set(entry.identity,{before,after});
 }
 return {sources,metadata,pairs,calls};
}
const bind=(f,pair,changes={})=>bindLocalNativeOwnerReferenceViews(pair.before,pair.after,{previousLock:previous,targetLock:target,sources:f.sources,...changes});
const configuration=owner=>projectOwnerObservation(owner,{}).configurationDigest;

test('the closed source set follows each declaration revision and binds init7/env8 plus exact release traces',async()=>{
 const f=await fixture();assert.equal(f.calls.length,14);assert.equal(f.metadata.length,22);assert.equal(f.pairs.size,11);
 assert.ok(f.metadata.filter(item=>item.side==='previous'&&item.declaration==='osShellControl').every(item=>item.sourceRevision===shellRevision));
 let references=0;
 for(const pair of f.pairs.values()){
  const before=structuredClone(pair.before),after=structuredClone(pair.after),view=bind(f,pair);
  references+=view.evidence.length;
  assert.equal(configuration(view.before),configuration(view.after));
  assert.deepEqual(pair.before,before);assert.deepEqual(pair.after,after);
  assert.ok(view.evidence.every(entry=>entry.sourceDigest.startsWith('sha256:')&&entry.valueDigest.startsWith('sha256:')));
 }
 assert.equal(references,36);
});

test('missing, copied or wrong-release source evidence cannot normalize a declared reference',async()=>{
 const f=await fixture(),pair=f.pairs.get('Deployment/opensphere-console/opensphere-console');
 for(const sources of [undefined,{...f.sources},{type:'opensphere.local-native-owner-reference-sources/v1'}])assert.throws(()=>bind(f,pair,{sources}),/missing or untrusted/);
 const changed=structuredClone(target);changed.components.registry.image=changed.components.registry.image.replace(/b/g,'c');
 assert.throws(()=>bind(f,pair,{targetLock:changed}),/target release changed/);
 const formal={...target,trust:RELEASE_TRUST};assert.throws(()=>bind(f,pair,{targetLock:formal}),/outside local native/);
});

test('a different verified artifact cannot replace the component assigned to a fixed init role',async()=>{
 const f=await fixture(),pair=structuredClone(f.pairs.get('Deployment/opensphere-console-change/opensphere-gitea'));
 pair.after.spec.template.spec.initContainers[0].image=target.components.giteaPostgres.image;
 assert.throws(()=>bind(f,pair),/exact verified artifact/);
});

test('extra init, duplicate or expanded env, valueFrom and changed literal references fail closed',async()=>{
 const f=await fixture(),initPair=f.pairs.get('Deployment/opensphere-console-change/opensphere-gitea'),envPair=f.pairs.get('Deployment/opensphere-console/opensphere-extension-controller');
 for(const change of [
  pair=>pair.after.spec.template.spec.initContainers.push({name:'extra-init',image:target.components.gitea.image}),
  pair=>pair.after.spec.template.spec.initContainers.push(structuredClone(pair.after.spec.template.spec.initContainers[0])),
 ]){const pair=structuredClone(initPair);change(pair);assert.throws(()=>bind(f,pair),/init set differs|init identity is duplicated/);}
 for(const change of [
  entries=>entries.push(structuredClone(entries.find(entry=>entry.name==='OPENSPHERE_EXTENSION_CONTROLLER_IMAGE'))),
  entries=>entries.push({name:'ORDERED',value:'$(OPENSPHERE_EXTENSION_CONTROLLER_IMAGE)'}),
  entries=>{const entry=entries.find(entry=>entry.name==='OPENSPHERE_EXTENSION_CONTROLLER_IMAGE');delete entry.value;entry.valueFrom={secretKeyRef:{name:'unapproved',key:'value'}};},
  entries=>{entries.find(entry=>entry.name==='OPENSPHERE_EXTENSION_CONTROLLER_IMAGE').value='different';},
 ]){
  const pair=structuredClone(envPair);change(pair.after.spec.template.spec.containers.find(container=>container.name==='controller').env);
  assert.throws(()=>bind(f,pair),/duplicated|ordered expansion|remain literal|exact verified artifact/);
 }
});

test('command, security, secret reference, auth and unknown env changes remain visible in the equality view',async()=>{
 const f=await fixture(),original=f.pairs.get('Deployment/opensphere-console-change/opensphere-gitea');
 for(const change of [
  owner=>{owner.spec.template.spec.initContainers[0].command=['unapproved-command'];},
  owner=>{owner.spec.template.spec.securityContext={runAsUser:0};},
  owner=>{owner.spec.template.spec.volumes=[{name:'unapproved',secret:{secretName:'different'}}];},
  owner=>{owner.spec.template.spec.containers[0].env.push({name:'AUTH_ENVIRONMENT',value:'development'});},
  owner=>{owner.spec.template.spec.containers[0].env.push({name:'UNREVIEWED',value:'new'});},
 ]){
  const pair=structuredClone(original);change(pair.after);const view=bind(f,pair);
  assert.notEqual(configuration(view.before),configuration(view.after));
 }
});

test('unknown historical Shell trace references cannot be normalized as release metadata',async()=>{
 const f=await fixture(),pair=structuredClone(f.pairs.get('Deployment/opensphere-console/opensphere-shell-api'));
 const before=pair.before.spec.template.spec.containers.find(container=>container.name==='api').env.find(entry=>entry.name==='OS_SHELL_RELEASE_EVIDENCE_REF');
 const after=pair.after.spec.template.spec.containers.find(container=>container.name==='api').env.find(entry=>entry.name==='OS_SHELL_RELEASE_EVIDENCE_REF');
 before.value='release://edge/'+'c'.repeat(64)+'/native-console-runtime';after.value='release://edge/'+'d'.repeat(64)+'/native-console-runtime';
 assert.throws(()=>bind(f,pair),/exact verified artifact or source/);
});

test('missing or modified source declarations and mutable source revisions cannot create evidence',async()=>{
 for(const source of ['', 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: unrelated}\n'])
  await assert.rejects(fetchLocalNativeOwnerReferenceSources(previous,target,async()=>source),/declaration is missing/);
 await assert.rejects(fetchLocalNativeOwnerReferenceSources(previous,target,async(selected,path,{sourceRevision})=>bytes(sourceRevision,path).replaceAll('__OPENSPHERE_GITEA_IMAGE__','__UNREVIEWED__')),/source role differs/);
 const changed=structuredClone(previous);changed.components.gitea.sourceRevision='main';let calls=0;
 await assert.rejects(fetchLocalNativeOwnerReferenceSources(changed,target,async()=>{calls++;return '';}),/exact source revision/);assert.equal(calls,0);
});
