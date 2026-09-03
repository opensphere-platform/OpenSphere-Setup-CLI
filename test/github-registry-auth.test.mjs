import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createGitHubRegistryAuth,limitedScopes} from '../src/github-registry-auth.mjs';
const token=()=>randomBytes(32).toString('hex');
const json=(body,headers={})=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json',...headers}});
const user=(scopes='read:packages')=>json({id:42,login:'opensphere'},{'x-oauth-scopes':scopes});
const device=()=>({device_code:token(),user_code:'ABCD-1234',verification_uri:'https://github.com/login/device',expires_in:900,interval:5});
const cid='OpenSphereClientId';

test('device flow requests only package reading and offline access, never a client secret',async()=>{
 let fields;const auth=createGitHubRegistryAuth({now:()=>1000,fetchImpl:async(url,options)=>{assert.equal(url,'https://github.com/login/device/code');fields=new URLSearchParams(options.body);assert.equal(options.redirect,'error');return json(device());}});
 const flow=await auth.start(cid);assert.equal(fields.get('scope'),'read:packages offline_access');assert.equal(fields.has('client_secret'),false);assert.equal(flow.nextPollAt,6000);
});
test('device flow obeys pending and slow_down intervals and stops on denial',async()=>{
 let time=0,count=0;const responses=[json(device()),json({error:'authorization_pending'}),json({error:'slow_down',interval:10}),json({error:'access_denied'})];
 const auth=createGitHubRegistryAuth({now:()=>time,fetchImpl:async()=>{count++;return responses.shift();}});let flow=await auth.start(cid);
 assert.equal((await auth.poll(flow)).pending,true);assert.equal(count,1);
 time=5000;flow=(await auth.poll(flow)).flow;assert.equal(flow.nextPollAt,10000);
 time=10000;flow=(await auth.poll(flow)).flow;assert.equal(flow.nextPollAt,20000);
 time=20000;await assert.rejects(auth.poll(flow),{code:'ReauthorizationRequired'});assert.equal(count,4);
});
test('device URI cannot redirect an operator to a third-party origin',async()=>{
 const auth=createGitHubRegistryAuth({fetchImpl:async()=>json({...device(),verification_uri:'https://example.org/login'})});await assert.rejects(auth.start(cid),{code:'InvalidProviderResponse'});
});
test('expired device flow does not poll the provider',async()=>{
 let calls=0;const auth=createGitHubRegistryAuth({now:()=>10000,fetchImpl:async()=>{calls++;}});await assert.rejects(auth.poll({expiresAt:new Date(0).toISOString()}),{code:'ReauthorizationRequired'});assert.equal(calls,0);
});
test('broad, missing and unobservable package scopes fail closed',async()=>{
 assert.throws(()=>limitedScopes('repo,read:packages'),{code:'ReadOnlyPackagesScopeRequired'});
 for(const scopes of ['repo,read:packages','write:packages','']){
  const auth=createGitHubRegistryAuth({fetchImpl:async()=>user(scopes)});await assert.rejects(auth.pat({username:'opensphere',token:token()}),{code:'ReadOnlyPackagesScopeRequired'});
 }
 const auth=createGitHubRegistryAuth({fetchImpl:async()=>json({id:42,login:'opensphere'})});await assert.rejects(auth.pat({username:'opensphere',token:token()}),{code:'ReadOnlyPackagesScopeUnverifiable'});
});
test('refresh uses the device grant without client secret and revalidates identity',async()=>{
 const access=token(),refresh=token(),old=token();let fields;
 const auth=createGitHubRegistryAuth({fetchImpl:async(url,options)=>{
  if(url==='https://api.github.com/user')return user();fields=new URLSearchParams(options.body);
  return json({access_token:access,refresh_token:refresh,expires_in:28800,refresh_token_expires_in:15897600,token_type:'bearer',scope:'read:packages'});
 }});
 const result=await auth.refresh({lifecycle:{mode:'github-device',clientId:cid,userId:'42',refreshToken:old,refreshExpiresAt:new Date(Date.now()+100000).toISOString()}});
 assert.equal(fields.get('grant_type'),'refresh_token');assert.equal(fields.get('refresh_token'),old);assert.equal(fields.has('client_secret'),false);assert.equal(result.token,access);assert.equal(result.lifecycle.refreshToken,refresh);
});
test('identity mismatch and provider errors do not echo credentials',async()=>{
 const secret=token();const auth=createGitHubRegistryAuth({fetchImpl:async()=>user()});await assert.rejects(auth.inspect(secret,{userId:'999'}),e=>e.code==='IdentityMismatch'&&!String(e).includes(secret));
 const unavailable=createGitHubRegistryAuth({fetchImpl:async()=>{throw new Error(secret);}});await assert.rejects(unavailable.inspect(secret),e=>e.code==='ProviderUnavailable'&&!String(e).includes(secret));
});
test('registry token success alone is not proof of manifest pull access',async()=>{
 const image='ghcr.io/opensphere-platform/opensphere-console@sha256:'+'a'.repeat(64);
 let mode='denied';let calls=0;
 const auth=createGitHubRegistryAuth({fetchImpl:async(url,options)=>{
  calls++;if(url.startsWith('https://ghcr.io/token?'))return json({token:token()});
  assert.equal(options.method,'HEAD');assert.equal(options.redirect,'error');
  return new Response(null,{status:mode==='denied'?403:200,headers:{'docker-content-digest':'sha256:'+'a'.repeat(64)}});
 }});
 const credentials={username:'opensphere',token:token()};await assert.rejects(auth.verifyImages(credentials,[image]),{code:'RegistryPullDenied'});
 mode='allowed';assert.equal((await auth.verifyImages(credentials,[image,image])).imageCount,1);assert.equal(calls,4);
 await assert.rejects(auth.verifyImages(credentials,['https://example.org/secret']),{code:'InvalidRegistryImage'});
});


test('PAT and OAuth token values cannot be mistaken for a public Client ID',async()=>{
 let called=0;const auth=createGitHubRegistryAuth({fetchImpl:async()=>{called++;throw new Error('network must not be reached');}});
 for(const prefix of ['ghp_','gho_','ghu_','ghs_','ghr_','github_pat_']){
  const value=prefix+token();await assert.rejects(auth.start(value),error=>error.code==='OpenSphereOAuthClientIdRequired'&&!error.message.includes(value));
 }
 assert.equal(called,0);
});
