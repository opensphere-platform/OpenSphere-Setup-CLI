import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import vm from 'node:vm';
import {verifyPublicConsoleEndpoint,verifyConsoleServiceAddress} from '../src/console-endpoint-verification.mjs';

let directory,ca,key,certificate,wrongCertificate,expiredCertificate;
before(()=>{
  directory=mkdtempSync(join(tmpdir(),'os-endpoint-test-'));
  const openssl=(args)=>{
    const result=spawnSync(process.env.OPENSSL_BINARY||'openssl',args,{cwd:directory,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,0,result.error?.message||result.stderr);
  };
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Disposable Setup Test CA',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout','ca.key','-out','ca.crt']);
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout','tls.key','-out','tls.csr']);
  for(const [file,san,days] of [['tls','IP:127.0.0.1,DNS:localhost','1'],['wrong','DNS:wrong.example.test','1'],['expired','IP:127.0.0.1','0']]){
    writeFileSync(join(directory,file+'.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
    openssl(['x509','-req','-in','tls.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days',days,'-extfile',file+'.ext','-out',file+'.crt']);
  }
  ca=readFileSync(join(directory,'ca.crt'));key=readFileSync(join(directory,'tls.key'));
  certificate=readFileSync(join(directory,'tls.crt'));wrongCertificate=readFileSync(join(directory,'wrong.crt'));expiredCertificate=readFileSync(join(directory,'expired.crt'));
});
after(()=>{
  if(!directory)return;
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('os-endpoint-test-'));
  rmSync(directory,{recursive:true,force:true});
});

const html='<!doctype html><title>OpenSphere Console</title><app-root></app-root>';
function service(port){return {metadata:{name:'opensphere-console-ext',namespace:'opensphere-console'},
  spec:{type:'LoadBalancer',selector:{app:'opensphere-console'},ports:[{name:'https',port,targetPort:8443}]}};}
function reader(port,{trust=true,cert=certificate,chain=false}={}){
  return args=>{
    if(args.includes('service'))return JSON.stringify(service(port));
    assert.ok(args.includes('secret'));assert.ok(args.at(-1).startsWith('jsonpath='));
    assert.doesNotMatch(args.at(-1),/tls\\\.key/);
    const publicChain=chain?Buffer.concat([cert,ca]):cert;
    return (trust&&!chain?ca.toString('base64'):'')+'|'+publicChain.toString('base64');
  };
}
function respond(request,response){
  if(request.url==='/'){response.setHeader('content-type','text/html');response.end(html);}
  else {response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/readyz'
    ?{state:'Ready',authority:'SupabasePostgreSQL'}:{state:'required'}));}
}
async function withEndpoint(operation,{cert=certificate,handler=respond}={}){
  const server=https.createServer({key,cert},handler);
  server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`https://127.0.0.1:${port}`;
  try{return await operation({port,origin,read:reader(port,{cert})});}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const options={timeoutMs:350,requestTimeoutMs:100,intervalMs:20};

test('HTTPS default 443 cannot pass verification with the former 1114 Service',()=>{
  assert.throws(()=>verifyConsoleServiceAddress(service(1114),'https://console.example.test'),/expected 443 -> 8443/);
  assert.equal(verifyConsoleServiceAddress(service(443),'https://console.example.test').port,443);
});

test('real HTTPS verifies HTML and public API through the exact origin using only public CA fields',async()=>{
  await withEndpoint(async({origin,port,read})=>{
    const result=await verifyPublicConsoleEndpoint(origin,{read,...options});
    assert.equal(result.origin,origin);assert.equal(result.servicePort,port);
    assert.equal(result.transport,'direct-origin');assert.equal(result.tlsVerified,true);
    assert.equal(result.htmlReady,true);assert.equal(result.apiReady,true);
    assert.equal(result.initialOperatorState,'required');
    const external=await verifyPublicConsoleEndpoint(origin,{read:reader(port,{chain:true}),...options});
    assert.equal(external.tlsVerified,true,'external CA chain works without a separate ca.crt field');
  });
});

test('wrong port, TLS trust, hostname and expiry cannot produce endpoint success',async()=>{
  await withEndpoint(async({origin,port})=>{
    await assert.rejects(verifyPublicConsoleEndpoint(origin,{read:reader(port+1),...options}),/Service does not match/);
    await assert.rejects(verifyPublicConsoleEndpoint(origin,{read:reader(port,{trust:false}),...options}),/verification failed/);
  });
  for(const cert of [wrongCertificate,expiredCertificate])await withEndpoint(async({origin,read})=>{
    await assert.rejects(verifyPublicConsoleEndpoint(origin,{read,...options}),/verification failed/);
  },{cert});
});

test('HTTP200 alone, redirects, failed public API and oversized responses cannot pass',async()=>{
  for(const handler of [
    (_q,r)=>{r.setHeader('content-type','text/html');r.end('<title>Another site</title>');},
    (_q,r)=>{r.writeHead(302,{location:'https://elsewhere.invalid'});r.end();},
    (q,r)=>{if(q.url==='/')respond(q,r);else {r.writeHead(503);r.end();}},
    (_q,r)=>{r.setHeader('content-type','text/html');r.end('x'.repeat(1024*1024+1));},
  ])await withEndpoint(async({origin,read})=>{
    await assert.rejects(verifyPublicConsoleEndpoint(origin,{read,...options}),/verification failed/);
  },{handler});
});

test('unreachable or stalled HTTPS origin terminates within the configured bound',async()=>{
  let saved;
  await withEndpoint(async current=>{saved=current;});
  const started=Date.now();
  await assert.rejects(verifyPublicConsoleEndpoint(saved.origin,{read:saved.read,...options}),/verification failed/);
  await withEndpoint(async({origin,read})=>{
    await assert.rejects(verifyPublicConsoleEndpoint(origin,{read,...options}),/verification failed/);
  },{handler:()=>{}});
  assert.ok(Date.now()-started<5000);
});

test('installation verification never records success when the real public origin fails',async()=>{
  // Keep the production verification orchestration; isolate unrelated backbone
  // owners while exercising the actual HTTPS probe before evidence publication.
  const source=readFileSync(new URL('../src/verify.mjs',import.meta.url),'utf8');
  const functionText=source.slice(source.indexOf('export async function verifyInstallation(')).replace('export ','');
  for(const broken of [true,false])await withEndpoint(async({origin,read})=>{
    const records=[];
    const context={console,Date,Error,
      validateLock:()=>{},verifyInstallationLock:()=>({consoleUrl:origin,installationUid:'id',installationState:{phase:'Installing'}}),
      hasBeszelBootstrapHistory:()=>false,verifySecrets:()=>1,verifyRegistryPullPath:()=>({}),verifyPersistentStorage:()=>1,
      eventuallyReady:operation=>operation(),verifyServiceEndpoints:()=>['service'],verifyWorkloads:()=>({podCount:1}),
      verifySupabaseDatabase:()=>({}),verifySupabaseServices:async()=>({}),verifyGitea:async()=>({}),verifyBeszel:async()=>({}),
      verifyConsoleApi:async()=>({}),verifyKnowledgeDelivery:()=>({}),verifyOfficialSkills:async()=>({state:'Verified'}),withService:null,
      recordInstallationEvidence:evidence=>records.push(evidence),
      verifyPublicConsoleEndpoint:url=>verifyPublicConsoleEndpoint(url,{read,...options}),
    };
    const verify=vm.runInNewContext(functionText+'\nverifyInstallation;',context);
    if(broken){await assert.rejects(verify({channel:'edge',releaseDigest:'digest'}),/verification failed/);assert.equal(records.length,0);}
    else {const result=await verify({channel:'edge',releaseDigest:'digest'});assert.equal(records.length,1);assert.equal(result.publicEndpoint.origin,origin);}
  },{handler:broken?(_q,r)=>{r.writeHead(503);r.end();}:respond});
});
