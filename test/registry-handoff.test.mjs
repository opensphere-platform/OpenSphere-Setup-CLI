import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {verifyRegistryHandoff,ensureRegistryPullSecrets} from '../src/bootstrap.mjs';
import {initialRegistryState,registryStateSecret,REGISTRY_NAMESPACES} from '../src/registry-lifecycle-contract.mjs';
const credentials=()=>({username:'opensphere',token:randomBytes(32).toString('hex'),lifecycle:{schemaVersion:'1.0',mode:'github-device',clientId:'OpenSphereClientId',userId:'42',scopes:['read:packages'],expiresAt:new Date(Date.now()+28800000).toISOString(),refreshToken:randomBytes(32).toString('hex'),refreshExpiresAt:new Date(Date.now()+86400000).toISOString(),verifiedAt:new Date().toISOString(),refreshPolicy:'automatic'}});
test('OAuth cannot be handed to a Console without the enabled lifecycle contract; no kubectl needed',()=>{
 assert.throws(()=>ensureRegistryPullSecrets({},credentials()),/has not enabled registry-auth\/v1/);
});
test('Setup rejects handing broad or unverified host credentials to runtime',()=>{
 const c=credentials();c.lifecycle.scopes.push('repo');assert.throws(()=>ensureRegistryPullSecrets({},c,{lifecycleEnabled:true}),/excessive registry credential/);
});
test('Setup waits for matching runtime generation and all five observed namespaces',async()=>{
 let now=Date.now(),reads=0;const state=initialRegistryState(credentials(),[]);const ready={...state,phase:'Ready',observation:{generation:state.generation,namespaces:[...REGISTRY_NAMESPACES],verifiedAt:new Date(now).toISOString()}};
 await verifyRegistryHandoff(state.generation,{now:()=>now,sleep:async(ms)=>{now+=ms;},read:()=>registryStateSecret(++reads===1?state:ready)});assert.equal(reads,2);
});
test('incomplete propagation times out, and runtime reauthorization is never called installation success',async()=>{
 let now=Date.now();const state=initialRegistryState(credentials(),[]);state.phase='Ready';state.observation={generation:state.generation,namespaces:['opensphere-console'],verifiedAt:new Date(now).toISOString()};
 await assert.rejects(verifyRegistryHandoff(state.generation,{now:()=>now,timeoutMs:3000,sleep:async(ms)=>{now+=ms;},read:()=>registryStateSecret(state)}),/not verified/);
 state.phase='ReauthorizationRequired';await assert.rejects(verifyRegistryHandoff(state.generation,{read:()=>registryStateSecret(state)}),/requires registry reauthorization/);
});