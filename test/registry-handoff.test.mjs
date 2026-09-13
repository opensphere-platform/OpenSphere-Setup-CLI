import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {verifyRegistryHandoff,ensureRegistryPullSecrets,assertManagedRegistryReady} from '../src/bootstrap.mjs';
import {initialRegistryState,registryStateSecret,REGISTRY_NAMESPACES,GENERATION_ANNOTATION,pullSecretData} from '../src/registry-lifecycle-contract.mjs';
const credentials=()=>({username:'opensphere',token:randomBytes(32).toString('hex'),lifecycle:{schemaVersion:'1.0',mode:'github-device',clientId:'OpenSphereClientId',userId:'42',scopes:['read:packages'],expiresAt:new Date(Date.now()+28800000).toISOString(),refreshToken:randomBytes(32).toString('hex'),refreshExpiresAt:new Date(Date.now()+86400000).toISOString(),verifiedAt:new Date().toISOString(),refreshPolicy:'automatic'}});
test('OAuth cannot be handed to a Console without the enabled lifecycle contract; no kubectl needed',()=>{
 assert.throws(()=>ensureRegistryPullSecrets({},credentials()),/has not enabled registry-auth\/v1/);
});
test('Setup rejects handing broad or unverified host credentials to runtime',()=>{
 const c=credentials();c.lifecycle.scopes.push('repo');assert.throws(()=>ensureRegistryPullSecrets({},c,{lifecycleEnabled:true}),/excessive registry credential/);
});
test('Setup waits for matching runtime generation and all six observed namespaces',async()=>{
 let now=Date.now(),reads=0;const state=initialRegistryState(credentials(),[]);const ready={...state,phase:'Ready',observation:{generation:state.generation,namespaces:[...REGISTRY_NAMESPACES],verifiedAt:new Date(now).toISOString()}};
 await verifyRegistryHandoff(state.generation,{now:()=>now,sleep:async(ms)=>{now+=ms;},read:()=>registryStateSecret(++reads===1?state:ready)});assert.equal(reads,2);
});
test('incomplete propagation times out, and runtime reauthorization is never called installation success',async()=>{
 let now=Date.now();const state=initialRegistryState(credentials(),[]);state.phase='Ready';state.observation={generation:state.generation,namespaces:['opensphere-console'],verifiedAt:new Date(now).toISOString()};
 await assert.rejects(verifyRegistryHandoff(state.generation,{now:()=>now,timeoutMs:3000,sleep:async(ms)=>{now+=ms;},read:()=>registryStateSecret(state)}),/not verified/);
 state.phase='ReauthorizationRequired';await assert.rejects(verifyRegistryHandoff(state.generation,{read:()=>registryStateSecret(state)}),/requires registry reauthorization/);
});

test('upgrade preflight requires current owner and all runtime pull Secret generations without replacing credentials',()=>{
 const now=Date.now(),state=initialRegistryState(credentials(),[]);
 state.phase='Ready';state.observation={generation:state.generation,namespaces:[...REGISTRY_NAMESPACES],verifiedAt:new Date(now).toISOString()};
 const pulls=new Map(REGISTRY_NAMESPACES.map(namespace=>[namespace,{type:'kubernetes.io/dockerconfigjson',
  metadata:{annotations:{[GENERATION_ANNOTATION]:state.generation}},data:pullSecretData(state.credentials,state.generation)}]));
 const before=JSON.stringify({state,pulls:[...pulls]});
 assert.doesNotThrow(()=>assertManagedRegistryReady(state,pulls,{now}));
 assert.equal(JSON.stringify({state,pulls:[...pulls]}),before);
 for(const phase of ['ReauthorizationRequired','AwaitingAuthorization','Pending','Anonymous']) {
  assert.throws(()=>assertManagedRegistryReady({...state,phase},pulls,{now}),/runtime GHCR connection is not ready.*registry-connections/);
 }
 for(const observation of [null,{...state.observation,generation:'other'},
  {...state.observation,namespaces:REGISTRY_NAMESPACES.slice(1)},
  {...state.observation,namespaces:[...REGISTRY_NAMESPACES,REGISTRY_NAMESPACES[0]]},
  {...state.observation,verifiedAt:new Date(now-20*60*1000).toISOString()},
  {...state.observation,verifiedAt:new Date(now+60000).toISOString()}]) {
  assert.throws(()=>assertManagedRegistryReady({...state,observation},pulls,{now}),/runtime GHCR connection is not ready/);
 }
 const expired={...state,credentials:{...state.credentials,lifecycle:{...state.credentials.lifecycle,expiresAt:new Date(now).toISOString()}}};
 assert.throws(()=>assertManagedRegistryReady(expired,pulls,{now}),/runtime GHCR connection is not ready/);
 const first=pulls.get(REGISTRY_NAMESPACES[0]);first.metadata.annotations[GENERATION_ANNOTATION]='old';
 assert.throws(()=>assertManagedRegistryReady(state,pulls,{now}),/runtime GHCR connection is not ready/);
 first.metadata.annotations[GENERATION_ANNOTATION]=state.generation;delete first.data['.dockerconfigjson'];
 assert.throws(()=>assertManagedRegistryReady(state,pulls,{now}),/runtime GHCR connection is not ready/);
});
