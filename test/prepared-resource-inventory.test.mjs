// Source declaration/inventory/prune conformance only; no cluster or installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {buildPreparedInventoryArtifacts,preparedInventoryArtifacts} from '../src/prepared-resource-inventory.mjs';
import {NATIVE_RUNTIME_PREREQUISITE_IDENTITIES} from '../src/r2d2-native-prerequisites.mjs';
import {NATIVE_OWNER_SOURCE_PATHS} from '../src/native-owner-preview.mjs';
import {releaseResourceInventory,pruneReleaseResources} from '../src/bootstrap.mjs';
const resource=(kind,name,namespace='opensphere-console')=>({apiVersion:kind==='Role'?'rbac.authorization.k8s.io/v1':'v1',kind,metadata:{name,...(namespace?{namespace}:{})}});
const manifest=(path,objects)=>({path,yaml:objects.map(object=>JSON.stringify(object)).join('\n---\n')});
const row=object=>({apiVersion:object.apiVersion,kind:object.kind,name:object.metadata.name,...(object.metadata.namespace?{namespace:object.metadata.namespace}:{})});
function plan(){
 const entries=NATIVE_RUNTIME_PREREQUISITE_IDENTITIES.map(identity=>{
  const [kind,namespace,name]=identity.split('/');return {object:resource(kind,name,namespace),before:null};
 });
 const value={schema:'opensphere.r2d2-runtime-preparation/v1',entries};
 return {...value,planDigest:'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
function fixture(){
 const base=resource('Deployment','core'),nativeObjects=[resource('Deployment','opensphere-console-osaa-gateway'),resource('Deployment','opensphere-osdst'),resource('Role','opensphere-shell-api-system-actor','opensphere-foundation')];
 const all=[manifest('base.yaml',[base])],native=nativeObjects.map((object,i)=>manifest(NATIVE_OWNER_SOURCE_PATHS[i],[object]));
 return {all,nativeObjects,base,foundation:{nativeInstallerRelease:native,nativeRuntime:plan(),ownerPreview:[manifest('comparison-only',[resource('Deployment','never-inventory-this')])]},native};
}
// Unit substitute for kubectl's tab-separated, client-defaulted identity output.
// The production decoder/filter and prune algorithm themselves are unchanged.
const decode=(args,{input})=>{
 assert.deepEqual(args.slice(0,6),['create','--dry-run=client','--validate=false','-f','-','-o']);
 return parseAllDocuments(input).map(document=>{assert.equal(document.errors.length,0);return document.toJS();}).filter(Boolean)
  .map(object=>[object.apiVersion,object.kind,object.metadata?.namespace??'',object.metadata?.name].join('\t')).join('\n');
};
test('complete inventory includes only actual late native declarations and fixed prerequisite plan; apply/preview stay independent',()=>{
 const f=fixture(),before=structuredClone(f),artifacts=buildPreparedInventoryArtifacts(f.all,f.foundation,{nativeRequired:true});
 assert.equal(artifacts.length,5);assert.deepEqual(f,before);
 assert.ok(!artifacts.some(item=>item.path==='comparison-only'));assert.equal(f.all.length,1);
 const actual=releaseResourceInventory(artifacts,decode);
 assert.ok(f.nativeObjects.every(object=>actual.some(item=>item.name===object.metadata.name)));
 const prerequisiteNames=new Set(f.foundation.nativeRuntime.entries.map(entry=>entry.object.metadata.name));
 assert.equal(actual.filter(item=>prerequisiteNames.has(item.name)).length,7,'the unchanged prune kinds exclude Namespace and ResourceQuota');
 assert.ok(!actual.some(item=>['Namespace','Secret','PersistentVolumeClaim','ResourceQuota','LimitRange'].includes(item.kind)));
});
test('normal prune preserves declared native resources but still retires an actually removed resource',()=>{
 const f=fixture(),complete=releaseResourceInventory(buildPreparedInventoryArtifacts(f.all,f.foundation,{nativeRequired:true}),decode);
 const removed=row(resource('ConfigMap','actually-retired'));
 const previous=[row(f.base),...f.nativeObjects.map(row),removed],deletes=[];
 pruneReleaseResources(previous,complete,args=>{assert.equal(args.includes('delete'),true);deletes.push(args);return '';});
 assert.deepEqual(deletes,[['-n','opensphere-console','delete','ConfigMap/actually-retired','--ignore-not-found','--wait=true']]);
 const broken=releaseResourceInventory(f.all,decode),oldDeletes=[];
 pruneReleaseResources(previous,broken,args=>{oldDeletes.push(args);return '';});assert.equal(oldDeletes.length,4,'the old apply-only inventory reproduces native deletion');
});
test('protected namespaces, credentials, personal PVCs and capacity objects remain outside the unchanged prune inventory',()=>{
 const f=fixture();f.all.push(manifest('protected',[resource('Namespace','personal',''),resource('Secret','credential'),resource('PersistentVolumeClaim','private-data'),resource('ResourceQuota','quota'),resource('LimitRange','limits')]));
 const inventory=releaseResourceInventory(buildPreparedInventoryArtifacts(f.all,f.foundation,{nativeRequired:true}),decode);
 assert.ok(!inventory.some(item=>['Namespace','Secret','PersistentVolumeClaim','ResourceQuota','LimitRange'].includes(item.kind)));
});
test('component inventory records only its actual selected declarations and prerequisite plan, without adding full native groups',()=>{
 const f=fixture();delete f.foundation.nativeInstallerRelease;
 const artifacts=buildPreparedInventoryArtifacts(f.all,f.foundation,{componentScoped:true,nativeRequired:true});
 assert.equal(artifacts.length,2);assert.equal(artifacts[0],f.all[0]);
 assert.equal(releaseResourceInventory(artifacts,decode).length,8);
 assert.throws(()=>buildPreparedInventoryArtifacts(f.all,{...f.foundation,nativeInstallerRelease:f.native},{componentScoped:true}),/cannot add full native/);
});
test('native declaration omissions, duplicate/extra sources and altered prerequisite scope fail before inventory can be accepted',()=>{
 for(const change of [
  f=>{delete f.foundation.nativeInstallerRelease;},f=>{f.foundation.nativeInstallerRelease=f.native.slice(1);},
  f=>{f.foundation.nativeInstallerRelease=[...f.native,f.native[0]];},f=>{f.foundation.nativeInstallerRelease[0]={...f.native[0],path:'unrelated.yaml'};},
  f=>{delete f.foundation.nativeRuntime;},f=>{f.foundation.nativeRuntime.entries.pop();},
  f=>{f.foundation.nativeRuntime.entries[0].object.metadata.name='different';},
 ]){const f=fixture();change(f);assert.throws(()=>buildPreparedInventoryArtifacts(f.all,f.foundation,{nativeRequired:true}));}
 const f=fixture();f.foundation.nativeRuntime.entries[0].object.metadata.name='different';delete f.foundation.nativeRuntime.planDigest;
 f.foundation.nativeRuntime.planDigest='sha256:'+createHash('sha256').update(JSON.stringify(f.foundation.nativeRuntime)).digest('hex');
 assert.throws(()=>buildPreparedInventoryArtifacts(f.all,f.foundation,{nativeRequired:true}),/scope differs/);
});
test('explicit malformed inventory never falls back; non-native/component empty apply inventory remains unchanged',()=>{
 const f=fixture();for(const value of [null,[],[{path:'broken'}]])assert.throws(()=>preparedInventoryArtifacts({all:f.all,inventoryArtifacts:value}));
 assert.equal(preparedInventoryArtifacts({all:f.all}),f.all);assert.deepEqual(preparedInventoryArtifacts({all:[]}),[]);
 assert.throws(()=>preparedInventoryArtifacts({all:f.all,foundation:f.foundation}),/Native preparation is missing/);
 assert.deepEqual(buildPreparedInventoryArtifacts(f.all,{}),f.all);
});
