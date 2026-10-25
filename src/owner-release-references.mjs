// Closed local-native compatibility for the already verified release images.
// These are concrete Console-owned reference fields, not caller-defined slots,
// permissions, credential references or an Owner manifest reconstruction.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {isLocalEdgeLock} from './release.mjs';
import {verifiedShellHistory} from './shell-release-history.mjs';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const sha=value=>'sha256:'+createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const storedSources=new WeakMap();
const gitea='backend/gitea/bootstrap/gitea.yaml',supabase='backend/supabase/target/deploy.yaml';
const init=(name,component,sourceValue,auxiliary=false)=>({type:'init',name,component,sourceValue,auxiliary});
const env=(container,name,component,sourceValue,{auxiliary=false,digest=false}={})=>({type:'env',container,name,component,sourceValue,auxiliary,digest});
const definitions=[
 {id:'Deployment/opensphere-console-change/opensphere-gitea',declaration:'gitea',path:gitea,refs:[init('materialize-config','gitea','__OPENSPHERE_GITEA_IMAGE__'),init('materialize-signing-key','gitea','__OPENSPHERE_GITEA_IMAGE__')]},
 {id:'Deployment/opensphere-console-change/opensphere-gitea-postgres',declaration:'giteaPostgres',path:gitea,refs:[init('prepare-data-volume','giteaPostgres','postgres:17-alpine')]},
 ...['auth','rest'].map(kind=>({id:`Deployment/opensphere-console-data/opensphere-supabase-${kind}`,declaration:kind==='auth'?'supabaseAuth':'supabaseRest',path:supabase,refs:[init('wait-for-postgres','supabasePostgres','__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__')]})),
 {id:'StatefulSet/opensphere-console-data/opensphere-supabase-postgres',declaration:'supabasePostgres',path:supabase,refs:[init('adopt-data-layout','supabasePostgres','__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__')]},
 {id:'Deployment/opensphere-console/opensphere-console',declaration:'console',path:'deploy/opensphere-console.yaml',refs:[init('console-index-content','consoleIndexContent','__OPENSPHERE_CONSOLE_INDEX_CONTENT_IMAGE__',true)]},
 {id:'Deployment/opensphere-console/opensphere-extension-controller',declaration:'extensionController',path:'apps/extension-controller/deploy.yaml',refs:[env('controller','OPENSPHERE_EXTENSION_CONTROLLER_IMAGE','extensionController','__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__')]},
 {id:'Deployment/opensphere-console/opensphere-registry',declaration:'registry',path:'backend/registry/deploy/registry.yaml',refs:[env('registry','IMAGE_DIGEST','registry','__OPENSPHERE_REGISTRY_IMAGE_DIGEST__',{digest:true})]},
 ...['api','gateway','reconciler'].map(name=>({id:`Deployment/opensphere-console/opensphere-shell-${name}`,declaration:'osShellControl',auxiliaryDeclaration:true,path:'apps/os-shell-control/deploy.yaml',refs:[
  env(name,'OS_SHELL_RUNTIME_IMAGE','osShellRuntime','__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__',{auxiliary:true}),
  env(name,'OS_SHELL_OS_ARTIFACT_DIGEST','cliArtifacts','__OPENSPHERE_OS_SHELL_OS_ARTIFACT_DIGEST__',{auxiliary:true,digest:true}),
  {type:'env',container:name,name:'OS_SHELL_RELEASE_EVIDENCE_REF',sourceValue:'__OPENSPHERE_OS_SHELL_RELEASE_EVIDENCE_REF__',source:'trace'},
 ]})),
];
const identity=owner=>`${owner.kind}/${owner.metadata?.namespace}/${owner.metadata?.name}`;
const one=(items,name,label)=>{assert.ok(Array.isArray(items),label+' is missing');const matches=items.filter(item=>item?.name===name);assert.equal(matches.length,1,label+' is missing or duplicated');return matches[0];};
const artifact=(lock,name,auxiliary=false)=>{
 const selected=(auxiliary?lock.auxiliaryArtifacts:lock.components)?.[name];
 assert.match(selected?.image??'',/^ghcr\.io\/opensphere-platform\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/,'Owner reference lacks an immutable release artifact');
 assert.match(selected.sourceRevision??'',/^[a-f0-9]{40}$/,'Owner reference lacks its exact source revision');
 return selected;
};
const fingerprint=lock=>sha({channel:lock.channel,trust:lock.trust,releaseDigest:lock.releaseDigest,sourceRevision:lock.sourceRevision,components:lock.components,auxiliaryArtifacts:lock.auxiliaryArtifacts});
function sourceDocument(raw,definition){
 assert.equal(typeof raw,'string','Owner reference source bytes are missing');assert.ok(Buffer.byteLength(raw)<=1024*1024,'Owner reference source exceeds budget');
 const docs=parseAllDocuments(raw);assert.ok(docs.every(doc=>!doc.errors.length),'Owner reference source is invalid YAML');
 const matches=docs.map(doc=>doc.toJS()).filter(owner=>owner&&identity(owner)===definition.id);
 assert.equal(matches.length,1,'Owner reference source declaration is missing or duplicated');
 return matches[0];
}
function referenceEntry(owner,reference){
 const pod=owner.spec?.template?.spec;assert.ok(pod,'Owner reference Pod declaration is missing');
 if(reference.type==='init')return one(pod.initContainers,reference.name,'Owner init reference');
 const container=one(pod.containers,reference.container,'Owner reference container'),entries=container.env;
 assert.ok(Array.isArray(entries),'Owner reference environment is missing');
 assert.equal(new Set(entries.map(entry=>entry?.name)).size,entries.length,'Owner reference environment is duplicated');
 for(const entry of entries)assert.ok(!(typeof entry.value==='string'&&entry.value.includes('$(')),'Owner reference environment has ordered expansion');
 const entry=one(entries,reference.name,'Owner release environment');
 assert.deepEqual(Object.keys(entry).sort(),['name','value'],'Owner release environment must remain literal');
 return entry;
}

// The normal caller supplies only fetchReleaseArtifact at the selected immutable
// declaration source. Raw source bodies stay private; the handle is not a
// serialized verification flag and a copied/forged handle is rejected.
export async function fetchLocalNativeOwnerReferenceSources(previousLock,targetLock,readArtifact,{historicalShell}={}){
 assert.ok(isLocalEdgeLock(previousLock)&&isLocalEdgeLock(targetLock)&&targetLock.components?.r2d2OpenClawGateway,'Owner release references are limited to local native adoption');
 assert.ok(!previousLock.releaseBom&&!targetLock.releaseBom,'Owner release references cannot change formal verification');
 const cache=new Map(),entries=new Map(),evidence=[];
 const history=historicalShell?verifiedShellHistory(historicalShell,previousLock):undefined;
 for(const [side,lock]of [['previous',previousLock],['target',targetLock]]){
  for(const definition of definitions){
   const selected=artifact(lock,definition.declaration,definition.auxiliaryDeclaration),key=selected.sourceRevision+':'+definition.path;
   if(!cache.has(key))cache.set(key,Promise.resolve(readArtifact(lock,definition.path,{sourceRevision:selected.sourceRevision})));
   const raw=await cache.get(key),document=sourceDocument(raw,definition),sourceHash=sha(raw);
   const sourceValues={manifest:sha(raw.replace(/\r\n/g,'\n'))};
   if(definition.auxiliaryDeclaration){
    const path='apps/os-shell-control/runtime-template.js',templateKey=selected.sourceRevision+':'+path;
    if(!cache.has(templateKey))cache.set(templateKey,Promise.resolve(readArtifact(lock,path,{sourceRevision:selected.sourceRevision})));
    const template=await cache.get(templateKey);assert.equal(typeof template,'string','Owner runtime template source bytes are missing');assert.ok(Buffer.byteLength(template)<=1024*1024);
    sourceValues.template=sha(template.replace(/\r\n/g,'\n'));
    sourceValues.trace=`release://${lock.channel}/${(side==='previous'&&history?history.originalReleaseDigest:lock.releaseDigest).replace('sha256:','')}/native-console-runtime`;
    if(side==='previous'&&history){
     assert.deepEqual(selected,history.shellArtifacts.osShellControl,'Historical Shell control artifact differs');
     for(const item of history.sources){assert.equal(selected.sourceRevision,item.sourceRevision,'Historical Shell source revision differs');assert.equal(item.sha256,item.path===definition.path?sourceValues.manifest:sourceValues.template,'Historical Shell source bytes differ');}
     for(const name of ['cliArtifacts','osShellRuntime'])assert.deepEqual(lock.auxiliaryArtifacts[name],history.shellArtifacts[name],'Historical Shell auxiliary artifact differs');
    }
   }
   for(const reference of definition.refs){
    const entry=referenceEntry(document,reference),field=reference.type==='init'?'image':'value';
    assert.equal(entry[field],reference.sourceValue,'Owner reference source role differs from its reviewed declaration');
    if(!reference.source)artifact(lock,reference.component,reference.auxiliary);
   }
   entries.set(side+':'+definition.id,{document,sourceValues,sourceRevision:selected.sourceRevision,path:definition.path,sha256:sourceHash});
   evidence.push({side,identity:definition.id,declaration:definition.declaration,sourceRevision:selected.sourceRevision,path:definition.path,sha256:sourceHash,...(definition.auxiliaryDeclaration?{runtimeTemplateDigest:sourceValues.template}: {})});
  }
 }
 const result=Object.freeze({type:'opensphere.local-native-owner-reference-sources/v1',previousReleaseDigest:previousLock.releaseDigest,targetReleaseDigest:targetLock.releaseDigest,
  sourceEvidenceDigest:sha({sources:evidence,historyEvidenceDigest:historicalShell?.historyEvidenceDigest??null}),...(historicalShell?{historyEvidenceDigest:historicalShell.historyEvidenceDigest}:{})});
 storedSources.set(result,{previous:fingerprint(previousLock),target:fingerprint(targetLock),entries,evidence});
 return result;
}
export function ownerReferenceSourceEvidence(sources){
 const data=storedSources.get(sources);assert.ok(data,'Owner reference source handle is not trusted');
 return structuredClone(data.evidence);
}

export function bindLocalNativeOwnerReferenceViews(before,after,{previousLock,targetLock,sources,recovery=false,recoveryShellAtTarget=false}={}){
 assert.equal(identity(before),identity(after),'Owner reference identity changed');
 const definition=definitions.find(item=>item.id===identity(before));
 const left=structuredClone(before),right=structuredClone(after);
 if(!definition)return {before:left,after:right,evidence:[]};
 const present=(owner,reference)=>reference.type==='init'?(owner.spec?.template?.spec?.initContainers??[]).some(item=>item.name===reference.name)
  :(owner.spec?.template?.spec?.containers??[]).some(container=>container.name===reference.container&&(container.env??[]).some(entry=>entry.name===reference.name));
 // Nothing is ignored when a simplified/nonmatching Owner has no such field.
 // Any real declared reference on either side requires its authentic source.
 if(!definition.refs.some(reference=>present(before,reference)||present(after,reference)))return {before:left,after:right,evidence:[]};
 assert.ok(isLocalEdgeLock(previousLock)&&isLocalEdgeLock(targetLock)&&targetLock.components?.r2d2OpenClawGateway,'Owner reference view is outside local native adoption');
 const data=storedSources.get(sources);assert.ok(data,'Owner reference source handle is missing or untrusted');
 assert.equal(data.previous,fingerprint(previousLock),'Owner reference original release changed');assert.equal(data.target,fingerprint(targetLock),'Owner reference target release changed');
 const evidence=[];
 for(const [side,owner,originalLock]of [['previous',left,previousLock],['target',right,targetLock]]){
  const shellAtTarget=definition.auxiliaryDeclaration&&side==='previous'&&recovery&&recoveryShellAtTarget;
  const lock=shellAtTarget?targetLock:originalLock,snapshot=data.entries.get((shellAtTarget?'target':side)+':'+definition.id);assert.ok(snapshot,'Owner reference source evidence is incomplete');
  if(definition.auxiliaryDeclaration){
   const name=definition.refs[0].container,selected=one(owner.spec.template.spec.containers,name,'Shell control container');
   assert.equal(selected.image,artifact(lock,'osShellControl',true).image,'Shell control image differs from the verified historical or target tuple');
   for(const [name,source]of [['OS_SHELL_MANIFEST_SHA256','manifest'],['OS_SHELL_RUNTIME_TEMPLATE_REVISION','template']]){
    const entry=referenceEntry(owner,{type:'env',container:selected.name,name});
    assert.ok(entry.value===snapshot.sourceValues[source],'Shell source reference differs from its immutable Git bytes');
    // Source files are unchanged in this transition. Keep their literal values
    // in the comparison; these fields are not normalization/ignore slots.
   }
  }
  if(definition.refs.some(reference=>reference.type==='init')){
   const names=list=>(list??[]).map(item=>item.name).sort();
   const actual=names(owner.spec.template.spec.initContainers),expected=names(snapshot.document.spec.template.spec.initContainers);
   assert.equal(new Set(actual).size,actual.length,'Owner init identity is duplicated');assert.deepEqual(actual,expected,'Owner init set differs from its verified source');
  }
  for(const reference of definition.refs){
   const entry=referenceEntry(owner,reference),field=reference.type==='init'?'image':'value';
   const expected=(selectedLock,selectedSnapshot)=>reference.source?selectedSnapshot.sourceValues[reference.source]
    :reference.digest?artifact(selectedLock,reference.component,reference.auxiliary).image.split('@')[1]:artifact(selectedLock,reference.component,reference.auxiliary).image;
   const value=expected(lock,snapshot),targetSnapshot=data.entries.get('target:'+definition.id);
   const atTarget=recovery&&!definition.auxiliaryDeclaration&&side==='previous'&&entry[field]===expected(targetLock,targetSnapshot);
   assert.ok(entry[field]===value||atTarget,'Owner release reference differs from the exact verified artifact or source');
   const selected=reference.source?undefined:artifact(atTarget?targetLock:lock,reference.component,reference.auxiliary);
   const selectedSource=atTarget?targetSnapshot:snapshot;
   evidence.push({side,identity:definition.id,field:reference.type==='init'?`initContainers/${reference.name}/image`:`containers/${reference.container}/env/${reference.name}`,
    artifact:reference.component??'osShellControl/'+reference.source,artifactSourceRevision:selected?.sourceRevision??selectedSource.sourceRevision,valueDigest:sha(entry[field]),sourceRevision:selectedSource.sourceRevision,sourcePath:selectedSource.path,sourceDigest:selectedSource.sha256});
   entry[field]=`verified-owner-reference://${reference.component??'osShellControl'}/${reference.source??(reference.digest?'digest':'image')}`;
  }
 }
 return {before:left,after:right,evidence};
}
