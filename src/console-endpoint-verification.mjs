import http from 'node:http';
import https from 'node:https';
import {X509Certificate} from 'node:crypto';
import {rootCertificates} from 'node:tls';
import {setTimeout as delay} from 'node:timers/promises';
import {kubectl} from './process.mjs';
import {consoleServiceEndpoint} from './console-url.mjs';

export function verifyConsoleServiceAddress(service,consoleUrl) {
  const endpoint=consoleServiceEndpoint(consoleUrl);
  const ports=service?.spec?.ports;
  if(service?.metadata?.name!=='opensphere-console-ext'||service.metadata.namespace!=='opensphere-console'
    ||service.spec.type!=='LoadBalancer'||service.spec.selector?.app!=='opensphere-console'
    ||!Array.isArray(ports)||ports.length!==1||ports[0].name!==endpoint.name
    ||ports[0].port!==endpoint.port||ports[0].targetPort!==endpoint.targetPort||(ports[0].protocol??'TCP')!=='TCP'){
    throw Error(`Console Service does not match ${endpoint.origin}: expected ${endpoint.port} -> ${endpoint.targetPort}/TCP`);
  }
  return endpoint;
}

function publicTrustMaterial(read) {
  // Request public fields only, never the TLS private key.
  const data=read(['-n','opensphere-console','get','secret','shell-tls',
    '-o','jsonpath={.data.ca\\.crt}{"|"}{.data.tls\\.crt}'],{capture:true}).split('|');
  const decode=value=>Buffer.from(value||'','base64').toString('utf8');
  const chain=decode(data[1]);
  if(!chain.includes('-----BEGIN CERTIFICATE-----'))throw Error('Console public TLS certificate is missing');
  const ca=(decode(data[0])+'\n'+chain).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];
  const issuers=ca.filter(pem=>new X509Certificate(pem).ca);
  return [...rootCertificates,...issuers];
}

function requestPage(origin,path,{ca,requestTimeoutMs,maxBodyBytes=1024*1024}) {
  const url=new URL(path,origin);
  const transport=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const request=transport.get(url,{
      ca,rejectUnauthorized:true,signal:AbortSignal.timeout(requestTimeoutMs),
      headers:{accept:path==='/'?'text/html':'application/json'},
    },response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>maxBodyBytes)response.destroy(Error('Console endpoint response exceeds verification limit'));
        else chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end',()=>{
        if(response.statusCode!==200){
          const error=Error(`Console endpoint ${path} returned HTTP ${response.statusCode}`);
          error.retryable=[502,503,504].includes(response.statusCode);reject(error);return;
        }
        resolve({body:Buffer.concat(chunks).toString('utf8'),contentType:response.headers['content-type']||''});
      });
    });
    request.on('error',reject);
  });
}

export async function verifyPublicConsoleEndpoint(consoleUrl,{
  read=kubectl,timeoutMs=60000,requestTimeoutMs=5000,intervalMs=5000,onProgress=()=>{},
}={}) {
  const service=JSON.parse(read(['-n','opensphere-console','get','service','opensphere-console-ext','-o','json'],{capture:true}));
  const endpoint=verifyConsoleServiceAddress(service,consoleUrl);
  const ca=endpoint.name==='https'?publicTrustMaterial(read):undefined;
  const deadline=Date.now()+timeoutMs;
  for(let attempt=1;;attempt++){
    onProgress(`${endpoint.origin} 실제 주소 응답 확인 (${attempt}회)`);
    try {
      const options={ca,requestTimeoutMs:Math.max(1,Math.min(requestTimeoutMs,deadline-Date.now()))};
      const page=await requestPage(endpoint.origin,'/',options);
      if(!/^text\/html\b/i.test(page.contentType)||!/<title>\s*OpenSphere Console\s*<\/title>/i.test(page.body)
        ||!/<app-root(?:\s|>)/i.test(page.body))throw Error('Console endpoint did not serve the Console HTML');
      const ready=await requestPage(endpoint.origin,'/readyz',options);
      if(!/^application\/json\b/i.test(ready.contentType))throw Error('Console public API readiness is not JSON');
      const health=JSON.parse(ready.body);
      if(health.state!=='Ready'||health.authority!=='SupabasePostgreSQL')throw Error('Console public API authority is not Ready');
      const bootstrap=await requestPage(endpoint.origin,'/api/identity/bootstrap/status',options);
      if(!/^application\/json\b/i.test(bootstrap.contentType))throw Error('Console public bootstrap status is not JSON');
      const initialOperatorState=JSON.parse(bootstrap.body).state;
      if(!['required','complete'].includes(initialOperatorState))throw Error('Console public bootstrap state is invalid');
      return {origin:endpoint.origin,servicePort:endpoint.port,targetPort:endpoint.targetPort,
        transport:'direct-origin',tlsVerified:endpoint.name==='https',htmlReady:true,apiReady:true,
        initialOperatorState,verifiedFrom:'setup-host',verifiedAt:new Date().toISOString()};
    } catch(error) {
      const retryable=error.retryable||['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ABORT_ERR'].includes(error.code);
      if(!retryable||Date.now()>=deadline)throw Error(`Console public endpoint verification failed for ${endpoint.origin}: ${error.message}`);
      onProgress(`${endpoint.origin}: ${error.message}; 외부 접속 준비 대기`);
      await delay(Math.min(intervalMs,Math.max(0,deadline-Date.now())));
    }
  }
}
