// Inventory is the complete declaration set, independent of early apply order
// and the Owner comparison view. It grants no authority and changes no prune kind.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NATIVE_OWNER_SOURCE_PATHS} from './native-owner-preview.mjs';
import {NATIVE_RUNTIME_PREREQUISITE_IDENTITIES} from './r2d2-native-prerequisites.mjs';
const valid=(items,allowEmpty=false)=>{
 assert.ok(Array.isArray(items)&&(allowEmpty||items.length),'Prepared inventory declarations are missing');
 for(const item of items)assert.ok(typeof item?.path==='string'&&item.path&&typeof item.yaml==='string'&&item.yaml,'Prepared inventory declaration bytes are missing');
 return items;
};
export function buildPreparedInventoryArtifacts(all,foundation,{nativeRequired=false,rollbackEvidenceOnly=false,componentScoped=false}={}){
 const result=[...valid(all,componentScoped)],native=foundation.nativeInstallerRelease;
 if(native===undefined){
  assert.ok(componentScoped||(!nativeRequired&&!foundation.nativeRuntime),'Actual native installer declarations are missing from inventory');
  if(!componentScoped)return result;
 }else{
  assert.ok(!componentScoped,'Component inventory cannot add full native installer declarations');
  valid(native);assert.deepEqual(native.map(item=>item.path).sort(),[...NATIVE_OWNER_SOURCE_PATHS].sort(),'Native inventory must contain exactly its three actual installer declarations');
  result.push(...native);
 }
 const plan=foundation.nativeRuntime;
 if(!plan){assert.ok(!nativeRequired||rollbackEvidenceOnly,'Native inventory lacks its actual prerequisite plan');return result;}
 const {planDigest,...content}=plan;
 assert.equal(plan.schema,'opensphere.r2d2-runtime-preparation/v1');
 assert.equal(planDigest,'sha256:'+createHash('sha256').update(JSON.stringify(content)).digest('hex'),'Native inventory prerequisite plan changed');
 assert.ok(Array.isArray(plan.entries),'Native inventory prerequisite declarations are missing');
 const objects=plan.entries.map(entry=>entry.object);
 assert.deepEqual(objects.map(object=>`${object.kind}/${object.metadata?.namespace??''}/${object.metadata?.name}`),[...NATIVE_RUNTIME_PREREQUISITE_IDENTITIES],
  'Native inventory prerequisite scope differs from the actual fixed installer');
 result.push({path:'setup/r2d2-native-runtime-prerequisites#inventory',yaml:objects.map(object=>JSON.stringify(object)).join('\n---\n')+'\n'});
 return result;
}
export function preparedInventoryArtifacts(prepared){
 // Component/legacy preparation has no separate late installer declarations.
 // An explicitly malformed inventory can never fall back to the early apply set.
 if(prepared.inventoryArtifacts===undefined){
  assert.ok(!prepared.foundation?.nativeRuntime&&!prepared.foundation?.nativeInstallerRelease,'Native preparation is missing its complete resource inventory');
  assert.ok(Array.isArray(prepared.all),'Prepared apply declarations are missing');return prepared.all;
 }
 return valid(prepared.inventoryArtifacts);
}
